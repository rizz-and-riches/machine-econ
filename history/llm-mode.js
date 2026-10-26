/* Real AI mode: the same economy, with real language-model agents.
 *
 * Agents are prompt pairs (frozen role prompt + trainable strategy prompt) on one
 * frozen model, as in the paper (Sec. 2.1). Wake-up, actions and both kinds of
 * birth are model calls. The role prompts, the wake-up prompt and the two birth
 * meta-prompts are adapted from the authors' released code (MIT licence):
 * hayekmas/adapters/researchworld/agent.py and prompts.py, hayekmas/base/prompts.py.
 *
 * Differences from the released code, all made to keep the number of model calls small:
 *   - wake-up is judged for all candidates in ONE call per step, not one call per agent
 *   - no replay trials (max_trials 1)
 *   - the problems are MATH problems with whole-number answers, marked exactly
 *
 * `ask(prompt)` must return a Promise of the model's text. The page passes Claude
 * through the artifact `sample` capability. Tests pass a stand-in.
 */
(function (root) {
  'use strict';

  const FROZEN = {
    planner: 'You are the Planner agent. You produce a concise roadmap for solving the problem: the key sub-steps in order and the technique for each. You must NOT perform calculations and you must NOT give a final answer.',
    executor: 'You are the Executor agent, the main workhorse. Each turn you perform ONE concrete calculation or derivation that advances exactly one sub-step. You must NOT give a final answer.',
    verifier: 'You are the Verifier agent. You check the most recent contribution, especially the latest Executor turn, for correctness. You must NOT add new derivations from scratch and must NOT give a final answer.',
    answer: 'You are the Answer agent. You are the ONLY agent that may give the final answer. You read the shared work and state the final result.',
  };
  const TRAINABLE = {
    planner: 'List the sub-steps needed, in order, in at most four short lines. Name the technique for each. If a plan already exists, add one missing sub-step instead of rewriting it.',
    executor: 'Find the earliest sub-step that is not done yet and carry it out cleanly. Show the key line of working. If a Verifier flagged an error in the last Executor turn, fix only that error this turn.',
    verifier: 'Inspect the latest contribution and report exactly one of: "Correct." plus the check you used, or "Error: <what is wrong>. Fix: <what the Executor should do>."',
    answer: 'If the shared work reaches a final result, give it. If the work is clearly unfinished, do not answer: say in one sentence what is still missing.',
  };

  const NEXT_STEP = [
    'You are one role in a team of agents solving a competition math problem together. Agents share a common state and take ONE turn at a time.',
    '', '<<<budget>>>', '', '# Your system prompt', '<<<system>>>', '', '# Current shared state', '<<<state>>>', '',
    '# Rules',
    '- You get exactly ONE short turn: at most 60 words. Make one contribution that matches your role.',
    '- Wrap your contribution in a single <step>...</step> block.',
    '- Never repeat work already in the state. Only add something new.',
    '<<<answer_rule>>>',
  ].join('\n');
  const ANSWER_RULE = '- You are the ONLY agent allowed to give a final answer. If the work reaches a result, end with <final_answer>\\boxed{N}</final_answer> where N is the final number. If the work is clearly unfinished, output only a <step> saying what is missing.';
  const TERMINAL_RULE = '- TERMINAL MODE: this is the final turn. You MUST end with <final_answer>\\boxed{N}</final_answer>, giving your best final number from the shared state.';

  const WAKE = [
    'You are coordinating wake-up decisions in a collaborative multi-agent task. Each agent below might or might not be the right one to act next.',
    'Judge each agent ONLY by its own system prompt and the current state, as that agent would.',
    '', '## Current state', '<<<state>>>', '', '## Agents', '<<<agents>>>', '',
    'Reply with JSON only, one key per agent name, value true if that agent should act now, false otherwise. Example: {"E-3": true, "V-4": false}',
  ].join('\n');

  // From hayekmas/base/prompts.py (GOOD_AGENT_BIRTH_PROMPT and BAD_AGENT_BIRTH_PROMPT), lightly shortened.
  const GOOD_BIRTH = [
    "You are an expert prompt engineer. You will modify an agent's system prompt to improve its general problem-solving ability.",
    '', 'Frozen system prompt (immutable):', '<frozen_system_prompt>', '<<<frozen>>>', '</frozen_system_prompt>', '',
    'Trainable system prompt (this is what you will modify):', '<trainable_system_prompt>', '<<<trainable>>>', '</trainable_system_prompt>', '',
    'Modify the trainable system prompt to add a general-purpose reasoning skill or strategy that helps across many different problems. The new prompt must contain ZERO references to any specific problem, topic, number, equation, or answer.',
    'Good modifications add transferable skills such as a reasoning heuristic, a problem-solving strategy, a self-checking habit, or a communication discipline. Keep it concise.',
    'Return ONLY the new trainable system prompt text, nothing else.',
  ].join('\n');
  const BAD_BIRTH = [
    "You are an expert prompt engineer. You will modify an agent's system prompt to fix a general weakness revealed by a failure.",
    '', 'Frozen system prompt (immutable):', '<frozen_system_prompt>', '<<<frozen>>>', '</frozen_system_prompt>', '',
    'Trainable system prompt (this is what you will modify):', '<trainable_system_prompt>', '<<<trainable>>>', '</trainable_system_prompt>', '',
    '## Failure context', 'The agent failed on a task. Study the failure to identify the GENERAL skill or habit that was missing, NOT the specific problem details.',
    '<task>', '<<<task>>>', '</task>', '<correct_answer>', '<<<answer>>>', '</correct_answer>',
    "Lines marked with >>> are the source agent's turns. All other lines are from other agents.", '<trajectory>', '<<<trace>>>', '</trajectory>', '',
    'Modify the trainable system prompt so the agent avoids similar mistakes. You can add, edit or delete a skill. Use a short itemized list of do\'s and don\'ts.',
    'The new prompt must contain ZERO references to any specific problem, number, equation or answer. Keep it to a short paragraph.',
    'Return ONLY the new trainable system prompt text, nothing else.',
  ].join('\n');

  const SHORT = { planner: 'P', executor: 'E', verifier: 'V', answer: 'A' };
  const DEFAULTS = {
    seed: 11, initialWealth: 50, baseBid: 10, epsilon: 1, rent: 20, rentInterval: 3,
    birthInterval: 3, birthsPerInterval: 2, minAgents: 2, maxAgents: 10,
    pA: 0.334, pB: 0.334, periodicGoodP: 0.5, maxSteps: 8, reward: 100, answerBonusScale: 0.5, pathRewardScale: 1.0,
    founders: { planner: 1, executor: 2, verifier: 1, answer: 1 },
  };

  function extractStep(text) {
    const m = /<step>([\s\S]*?)<\/step>/i.exec(text || '');
    return (m ? m[1] : text || '').trim().slice(0, 700);
  }
  function extractFinal(text) {
    const m = /<final_answer>([\s\S]*?)<\/final_answer>/i.exec(text || '');
    if (!m) return null;
    const inner = m[1];
    const b = /\\boxed\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/.exec(inner);
    return (b ? b[1] : inner).trim();
  }
  function normalize(ans) {
    if (ans == null) return null;
    let s = String(ans).replace(/\$|\\!|\\,|\s|\\text\{[^}]*\}|\\mbox\{[^}]*\}|\^\\circ|\\%|%/g, '');
    s = s.replace(/^\\?\(|\\?\)$/g, '').replace(/,(?=\d{3}\b)/g, '').replace(/\.0+$/, '');
    s = s.replace(/^[a-zA-Z]=/, '');
    return s;
  }
  function isCorrect(given, truth) {
    const g = normalize(given), t = normalize(truth);
    if (g == null) return false;
    if (g === t) return true;
    const gn = Number(g), tn = Number(t);
    return Number.isFinite(gn) && Number.isFinite(tn) && Math.abs(gn - tn) < 1e-9;
  }
  function parseJSON(text) {
    if (!text) return null;
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch (e) { return null; }
  }

  class LLMEconomy {
    constructor(cfg, ask) {
      this.cfg = Object.assign({}, DEFAULTS, cfg || {});
      this.ask = ask;
      this.rand = (root.EoM || require('./engine.js')).mulberry32(this.cfg.seed);
      this.agents = []; this.graveyard = []; this.nextId = 1; this.episode = 0; this.house = 0; this.calls = 0;
      this.births = [];
      for (const role of ['planner', 'executor', 'verifier', 'answer'])
        for (let i = 0; i < this.cfg.founders[role]; i++) this.agents.push(this._make(role, TRAINABLE[role], 'founder', null));
    }
    _make(role, trainable, kind, parent) {
      const id = this.nextId++;
      return { id, name: SHORT[role] + '-' + id, role, trainable, bid: null, status: 'novice', wealth: this.cfg.initialWealth,
        kind, parentName: parent ? parent.name : null, born: this.episode, wins: 0, alive: true, lastFailure: null };
    }
    system(a) { return FROZEN[a.role] + '\n' + a.trainable; }
    async _ask(prompt, kind) { this.calls++; return await this.ask(prompt, kind); }
    stateText(problem, turns) {
      const lines = ['Problem:', problem.problem, '', turns.length ? 'Turns so far:' : 'Turns so far: none yet.'];
      turns.forEach((t, i) => lines.push('[Turn ' + (i + 1) + '] ' + t.name + ' (' + t.role + '): ' + t.text));
      return lines.join('\n');
    }

    // hard wake-up rules from the research adapter, then one batched model judgement
    async wakeSet(problem, turns, step, pop) {
      const c = this.cfg, last = turns.length ? turns[turns.length - 1].role : null;
      if (step >= c.maxSteps - 1) return pop.filter((a) => a.role === 'answer');      // terminal mode
      const sure = [], ask = [];
      for (const a of pop) {
        if (last === a.role) continue;                                             // never the same role twice in a row
        if (a.role === 'planner' && !last) { sure.push(a); continue; }              // planner self-starts
        if (a.role === 'answer') {
          if (last !== 'executor' && last !== 'verifier') continue;
          if (last === 'executor') { sure.push(a); continue; }                      // fallback after the executor
        }
        if (!last && a.role !== 'planner') { ask.push(a); continue; }
        ask.push(a);
      }
      if (!ask.length) return sure;
      const prompt = WAKE.replace('<<<state>>>', this.stateText(problem, turns))
        .replace('<<<agents>>>', ask.map((a) => '- ' + a.name + ': ' + this.system(a).replace(/\n/g, ' ')).join('\n'));
      const res = parseJSON(await this._ask(prompt, 'wake'));
      const yes = ask.filter((a) => (res ? res[a.name] === true : true));   // fail open if the reply cannot be read
      return sure.concat(yes);
    }

    setBids(active, log) {
      const vet = active.filter((a) => a.status === 'veteran' && a.bid != null).map((a) => a.bid);
      const high = vet.length ? Math.max(...vet) : this.cfg.baseBid;
      for (const a of active) if (a.status === 'novice') { a.bid = high + this.cfg.epsilon; a.status = 'veteran'; log({ type: 'novice', id: a.id, name: a.name, bid: a.bid }); }
    }
    pick(active) {
      const withBid = active.filter((a) => a.bid != null), pool = withBid.length ? withBid : active;
      const max = Math.max(...pool.map((a) => (a.bid == null ? -Infinity : a.bid)));
      const top = pool.filter((a) => a.bid === max || max === -Infinity);
      return top[Math.floor(this.rand() * top.length)];
    }

    async planning(problem, training, log, pop, stopFlag) {
      pop = pop || this.agents;
      const turns = []; let prev = null, final = null, submitter = null; const wins = [];
      for (let step = 0; step < this.cfg.maxSteps; step++) {
        if (stopFlag && stopFlag()) break;
        const active = await this.wakeSet(problem, turns, step, pop);
        if (!active.length) { log({ type: 'no-eligible', step }); break; }
        if (training) this.setBids(active, log);
        const w = this.pick(active);
        log({ type: 'auction', step, winner: w.name, bids: active.map((a) => ({ name: a.name, bid: a.bid })) });
        if (training) {
          w.wealth -= w.bid;
          if (prev) { prev.wealth += w.bid; log({ type: 'pay', from: w.name, to: prev.name, amount: w.bid }); }
          else { this.house += w.bid; log({ type: 'pay', from: w.name, to: 'House', amount: w.bid }); }
          w.wins++;
        }
        const terminal = step >= this.cfg.maxSteps - 1;
        const prompt = NEXT_STEP.replace('<<<budget>>>', 'Turn ' + (step + 1) + ' of ' + this.cfg.maxSteps + '. ' + (this.cfg.maxSteps - step - 1) + ' turn(s) left after this one.')
          .replace('<<<system>>>', this.system(w)).replace('<<<state>>>', this.stateText(problem, turns))
          .replace('<<<answer_rule>>>', w.role === 'answer' ? (terminal ? ANSWER_RULE + '\n' + TERMINAL_RULE : ANSWER_RULE) : '- You must NOT give a final answer.');
        const out = await this._ask(prompt, 'act');
        const text = extractStep(out);
        const fa = w.role === 'answer' ? extractFinal(out) : null;
        turns.push({ name: w.name, role: w.role, text: fa != null ? (text ? text + ' ' : '') + 'FINAL ANSWER: ' + fa : text, id: w.id });
        wins.push(w);
        log({ type: 'act', step, name: w.name, role: w.role, text: turns[turns.length - 1].text });
        prev = w;
        if (fa != null) { final = fa; submitter = w; break; }
      }
      const correct = final != null && isCorrect(final, problem.answer);
      return { turns, final, correct, submitter, wins };
    }

    async trainEpisode(problem, log, stopFlag) {
      const c = this.cfg; this.episode++;
      log({ type: 'episode', episode: this.episode, id: problem.id, level: problem.level });
      const r = await this.planning(problem, true, log, null, stopFlag);
      // released research config reward: centred score, answer bonus 0.5, path reward split per action
      const sig = (r.correct ? 1 : -1) * c.reward;
      if (r.submitter) { r.submitter.wealth += c.answerBonusScale * sig; log({ type: 'reward', to: r.submitter.name, amount: c.answerBonusScale * sig, why: 'answer' }); }
      if (r.wins.length) { const per = (c.pathRewardScale * sig) / r.wins.length; for (const w of r.wins) w.wealth += per; log({ type: 'reward', to: 'path', amount: per, n: r.wins.length, why: 'path' }); }
      log({ type: 'outcome', correct: r.correct, final: r.final, truth: problem.answer });
      if (!r.correct) {     // failure context for exploration births
        for (const w of new Set(r.wins)) {
          w.lastFailure = { task: problem.problem, answer: problem.answer,
            trace: r.turns.map((t) => (t.id === w.id ? '>>> ' : '    ') + t.name + ' (' + t.role + '): ' + t.text).join('\n') };
        }
      }
      const dead = this.removeBankrupt(log);
      if (c.rent > 0 && this.episode % c.rentInterval === 0) {
        for (const a of this.agents) a.wealth -= c.rent;
        log({ type: 'rent', amount: c.rent, n: this.agents.length });
        dead.push(...this.removeBankrupt(log));
      }
      await this.ensureRoles(dead, log);
      for (const b of dead) {
        if (this.agents.length >= c.maxAgents) break;
        const u = this.rand();
        if (u < c.pA) await this.birthGood(this.richest(), log, 'bankruptcy');
        else if (u < c.pA + c.pB) await this.birthBad(b, log, 'bankruptcy');
      }
      if (this.episode % c.birthInterval === 0) {
        for (let i = 0; i < c.birthsPerInterval && this.agents.length < c.maxAgents; i++) {
          if (this.rand() < c.periodicGoodP) await this.birthGood(this.richest(), log, 'periodic');
          else await this.birthBad(this.poorest(), log, 'periodic');
        }
      }
      while (this.agents.length < c.minAgents) await this.birthGood(this.richest(), log, 'replenish');
      return r;
    }
    richest() { return this.agents.reduce((b, a) => (!b || a.wealth > b.wealth ? a : b), null); }
    poorest() { return this.agents.reduce((b, a) => (!b || a.wealth < b.wealth ? a : b), null); }
    removeBankrupt(log) {
      const dead = this.agents.filter((a) => a.wealth < 0);
      for (const a of dead) { a.alive = false; a.diedAt = this.episode; this.graveyard.push(a); log({ type: 'bankrupt', name: a.name, wealth: a.wealth }); }
      this.agents = this.agents.filter((a) => a.wealth >= 0);
      return dead;
    }
    async ensureRoles(dead, log) {
      for (const role of ['planner', 'executor', 'verifier', 'answer']) {
        if (this.agents.some((a) => a.role === role)) continue;
        const src = dead.find((a) => a.role === role) || this.graveyard.slice().reverse().find((a) => a.role === role);
        if (src) await this.birthBad(src, log, 'role-recovery', true);
      }
    }
    clean(raw, fallback) {
      const t = String(raw || '').replace(/<\/?(trainable_system_prompt|frozen_system_prompt)>/g, '').trim().replace(/^["']|["']$/g, '').trim();
      return t.length >= 10 ? t.slice(0, 1200) : fallback;
    }
    async birthGood(parent, log, why) {
      if (!parent || this.agents.length >= this.cfg.maxAgents) return null;
      const p = GOOD_BIRTH.replace('<<<frozen>>>', FROZEN[parent.role]).replace('<<<trainable>>>', parent.trainable);
      const trainable = this.clean(await this._ask(p, 'birth'), parent.trainable);
      const child = this._make(parent.role, trainable, 'good', parent);
      this.agents.push(child);
      this.births.push({ kind: 'good', why, child: child.name, parent: parent.name, before: parent.trainable, after: trainable, episode: this.episode });
      log({ type: 'birth', kind: 'good', name: child.name, parent: parent.name, why });
      return child;
    }
    async birthBad(src, log, why, force) {
      if (!src || (!force && this.agents.length >= this.cfg.maxAgents)) return null;
      const f = src.lastFailure || {};
      const p = BAD_BIRTH.replace('<<<frozen>>>', FROZEN[src.role]).replace('<<<trainable>>>', src.trainable)
        .replace('<<<task>>>', f.task || '(Task description not available)').replace('<<<answer>>>', f.answer || '(Correct answer not available)')
        .replace('<<<trace>>>', f.trace || '(No actions recorded - agent never successfully acted)');
      const trainable = this.clean(await this._ask(p, 'birth'), src.trainable);
      const child = this._make(src.role, trainable, 'bad', src);
      this.agents.push(child);
      this.births.push({ kind: 'bad', why, child: child.name, parent: src.name, before: src.trainable, after: trainable, episode: this.episode, hadTrace: !!f.trace });
      log({ type: 'birth', kind: 'bad', name: child.name, parent: src.name, why });
      return child;
    }
    // Alg. 2: frozen copy, no money moves
    async evaluate(problems, log, stopFlag) {
      const frozen = this.agents.map((a) => Object.assign({}, a));
      const results = [];
      for (const pr of problems) {
        if (stopFlag && stopFlag()) break;
        log({ type: 'test', id: pr.id, level: pr.level });
        const r = await this.planning(pr, false, log, frozen, stopFlag);
        results.push({ id: pr.id, level: pr.level, correct: r.correct, final: r.final, truth: pr.answer, path: r.turns.map((t) => SHORT[t.role]).join('') });
        log({ type: 'test-result', id: pr.id, correct: r.correct, final: r.final, truth: pr.answer });
      }
      return { acc: results.length ? results.filter((x) => x.correct).length / results.length : 0, results };
    }
    totalWealth() { return this.agents.reduce((t, a) => t + a.wealth, 0); }
  }

  const api = { LLMEconomy, FROZEN, TRAINABLE, extractFinal, extractStep, isCorrect, normalize, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EoMLLM = api;
})(typeof window !== 'undefined' ? window : globalThis);
