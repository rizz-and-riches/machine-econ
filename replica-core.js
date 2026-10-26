// Economy of Minds, line-by-line JavaScript port of the released code
// (github.com/zhentingqi/EoM, commit d272266, MIT licence).
//   hayekmas/base/config.py      -> defaultConfig, configFromDict, Reward
//   hayekmas/base/agent.py       -> Agent
//   hayekmas/base/population.py  -> Population
//   hayekmas/base/mas.py         -> HayekMAS
//   hayekmas/base/pipeline.py    -> Trainer (train loop, periodic test, checkpoints)
//   hayekmas/base/prompts.py     -> GOOD/BAD birth prompts, WAKEUP_PROMPT (verbatim)
//   hayekmas/adapters/researchworld/* -> RESEARCH adapter (prompts verbatim)
// plus a MATH adapter built from the paper's description (Sec. 3.1, App. D.2),
// which the release does not include.
// Every model call goes through ctx.ask(kind, prompt, opts) so the page decides
// which Claude tier answers. Comments marked "page:" are the only places this
// port does something the Python does not.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./released_prompts.json'));
  else root.EoMReplica = factory(root.EoMReleasedPrompts);
})(typeof self !== 'undefined' ? self : this, function (RP) {
'use strict';
// RP = released_prompts.json, extracted from the Python source by gen-prompts.py (byte for byte).

// ---------------------------------------------------------------- random
// page: Python's global `random` is unseeded. A seeded generator makes runs
// resumable and replayable. Same calls: random.random, random.choice, random.randint.
function makeRng(state) {
  const r = { s: state >>> 0 };
  r.random = () => { r.s = (r.s + 0x6D2B79F5) >>> 0; let t = r.s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  r.choice = (a) => a[Math.floor(r.random() * a.length)];
  r.randint = (a, b) => a + Math.floor(r.random() * (b - a + 1));
  return r;
}

// ---------------------------------------------------------------- config.py
function defaultConfig() {
  return {
    engine: { max_steps_per_episode: 10, max_trials_per_episode: 4, birth_interval: 5, num_births_per_interval: 2, min_num_agents: 0, max_num_agents: 0, bid_scheme: 'fixed', base_bid: 0.1, novice_bid_epsilon: 0.01, initial_wealth: 0.5, rent: 0.0, rent_interval: 5, holland_alpha: 0.1, tycoon_wealth_threshold: 5.0 },
    reward: { reward_scheme: 'path_reward_only', path_reward_scale: 1.0, terminal_output_bonus_scale: 0.5, env_reward_scale: 1.0, missing_terminal_score: 0.0, center_env_reward: true, path_reward_per_unique_author: false, step_reward_split_chain: false, step_reward_chain_window: 3 },
    evolution: { p_a: 0.0, p_b: 1.0, periodical_good_p: 0.5 },
    evaluation: { periodic_test_enabled: true, periodic_test_before_training: false, periodic_test_every_n_tasks: 5, periodic_test_parallel_enabled: true, periodic_test_max_workers: 4 },
    concurrency: { wakeup_parallel_enabled: false, wakeup_max_workers: 1, wakeup_retry_attempts: 2, wakeup_retry_backoff_seconds: 1.0, wakeup_fail_open: false, log_wakeup: true, wakeup_model: null },
    terminal: { enabled: true, start_on_step_from_end: 1, candidate_agent_tags: ['terminal'], allow_abstain_terminal_mode: true },
  };
}
function configFromDict(raw) {
  const c = defaultConfig();
  const eng = raw.engine || raw;
  for (const k of Object.keys(c.engine)) if (eng[k] !== undefined) c.engine[k] = eng[k];
  const rw = raw.reward || {};
  for (const k of Object.keys(c.reward)) if (rw[k] !== undefined) c.reward[k] = rw[k];
  if (rw.distribution_mode === 'per_unique_agent') c.reward.path_reward_per_unique_author = true;
  const ev = raw.evolution || {}; for (const k of Object.keys(c.evolution)) if (ev[k] !== undefined) c.evolution[k] = ev[k];
  const ea = raw.evaluation || {}; for (const k of Object.keys(c.evaluation)) if (ea[k] !== undefined) c.evaluation[k] = ea[k];
  const wk = raw.wakeup || {}; for (const k of Object.keys(c.concurrency)) if (wk[k] !== undefined) c.concurrency[k] = wk[k];
  const tm = raw.terminal || {}; for (const k of Object.keys(c.terminal)) if (tm[k] !== undefined) c.terminal[k] = tm[k];
  if (raw.page) c.page = Object.assign({}, raw.page);
  return c;
}
const Reward = {
  centered: (s) => 2.0 * s - 1.0,
  signal: (rc, s) => rc.env_reward_scale * (rc.center_env_reward ? 2.0 * s - 1.0 : s),
  bonus: (rc, s) => rc.terminal_output_bonus_scale * Reward.signal(rc, s),
  perAgent: (rc, s, n) => (n <= 0 ? 0.0 : (rc.path_reward_scale * Reward.signal(rc, s)) / n),
};

// The released research config, global_configs/train_research.json, "mas" section, verbatim.
const RELEASED_RESEARCH_MAS = {
  engine: { max_steps_per_episode: 10, max_trials_per_episode: 2, birth_interval: 3, num_births_per_interval: 2, min_num_agents: 2, max_num_agents: 20, bid_scheme: 'fixed', base_bid: 0.1, novice_bid_epsilon: 0.1, initial_wealth: 0.5, rent: 0.2, rent_interval: 3 },
  reward: { reward_scheme: 'path_reward_and_stepwise_reward', center_env_reward: true, env_reward_scale: 1.0, path_reward_scale: 1.0, terminal_output_bonus_scale: 0.5, missing_terminal_score: 0.0 },
  evolution: { p_a: 0.334, p_b: 0.334, periodical_good_p: 0.5 },
  evaluation: { periodic_test_enabled: true, periodic_test_before_training: false, periodic_test_every_n_tasks: 3, periodic_test_parallel_enabled: true, periodic_test_max_workers: 10 },
  wakeup: { wakeup_parallel_enabled: true, wakeup_max_workers: 10, log_wakeup: false, wakeup_model: { api: 'litellm', name: 'openai/gpt-5-nano', max_tokens: 4096, temperature: 1 } },
};
const RELEASED_RESEARCH_RUN = { num_epochs: 2, train_max_tasks: 40, test_max_tasks: null, judge_threshold: 0.5, model_temperature: 0.9, model_max_tokens: 63000 };

// ---------------------------------------------------------------- base/prompts.py (verbatim)
const GOOD_AGENT_BIRTH_PROMPT = RP.GOOD_AGENT_BIRTH_PROMPT, BAD_AGENT_BIRTH_PROMPT = RP.BAD_AGENT_BIRTH_PROMPT, WAKEUP_PROMPT = RP.WAKEUP_PROMPT;

function formatMutate(frozen, trainable) {
  return GOOD_AGENT_BIRTH_PROMPT.split('<<<frozen_system_prompt>>>').join(frozen || '(empty)').split('<<<trainable_system_prompt>>>').join(trainable);
}
function formatSpawn(frozen, trainable, trace, task, answer) {
  if (!trace) trace = '(No actions recorded - agent never successfully acted)';
  if (!task) task = '(Task description not available)';
  if (!answer) answer = '(Correct answer not available)';
  return BAD_AGENT_BIRTH_PROMPT.split('<<<frozen_system_prompt>>>').join(frozen || '(empty)').split('<<<trainable_system_prompt>>>').join(trainable)
    .split('<<<agent_trace>>>').join(trace).split('<<<task_description>>>').join(task).split('<<<correct_answer>>>').join(answer);
}
function cleanTrainable(raw, frozen) {
  if (frozen && raw.includes(frozen)) raw = raw.split(frozen).join('');
  raw = raw.replace(/<\/?(?:trainable_system_prompt|frozen_system_prompt|section_to_modify)>/g, '').trim();
  // Python: .strip().strip("'\"").strip()
  raw = raw.replace(/^['"]+|['"]+$/g, '').trim();
  return raw;
}
const fill = (tpl, map) => { let s = tpl; for (const [k, v] of Object.entries(map)) s = s.split('<<<' + k + '>>>').join(v); return s; };

// ---------------------------------------------------------------- researchworld/prompts.py (verbatim)
const R_NEXT_STEP_PROMPT = RP.NEXT_STEP_PROMPT, R_ANSWER_PROMPT_POSTFIX = RP.ANSWER_PROMPT_POSTFIX;
const R_TERMINAL_ABSTAIN = RP.TERMINAL_MODE_NOTE_ABSTAIN, R_TERMINAL_NO_ABSTAIN = RP.TERMINAL_MODE_NOTE_NO_ABSTAIN, R_JUDGE_NOTE = RP.JUDGE_NOTE;
const RUBRIC_JUDGE_PROMPT = RP.RUBRIC_JUDGE_PROMPT;
function parseJudge(response) {
  let score = 0.0, reason = '';
  for (const line of response.split('\n')) {
    const s = line.trim(); if (!s) continue; const up = s.toUpperCase();
    if (up.startsWith('SCORE:')) { const rest = s.slice(6).trim().replace(/^:+/, '').trim(); const tok = (rest.split(/\s+/)[0] || '').replace(/,+$/, ''); const v = parseFloat(tok); if (tok !== '' && !isNaN(v) && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(tok)) score = v; score = Math.max(0, Math.min(1, score)); }
    else if (up.startsWith('REASON:')) reason = s.slice(7).trim().replace(/^:+/, '').trim();
  }
  if (!reason) reason = 'Score ' + score.toFixed(3) + ' (no reason parsed).';
  return [score, reason];
}

// ---------------------------------------------------------------- researchworld/agent.py roles (verbatim prompts)
const RESEARCH_ROLES = [
  { cls: 'LiteratureResearchAgent', role: 'literature', tags: ['research'], name: 'Literature', selfStart: true,
    frozen: RP['LiteratureResearchAgent.FROZEN_SYSTEM_PROMPT'],
    trainable: RP['LiteratureResearchAgent.TRAINABLE_SYSTEM_PROMPT'] },
  { cls: 'PlannerResearchAgent', role: 'planner', tags: ['research'], name: 'Planner', selfStart: true,
    frozen: RP['PlannerResearchAgent.FROZEN_SYSTEM_PROMPT'],
    trainable: RP['PlannerResearchAgent.TRAINABLE_SYSTEM_PROMPT'] },
  { cls: 'DeriverResearchAgent', role: 'deriver', tags: ['research'], name: 'Deriver',
    frozen: RP['DeriverResearchAgent.FROZEN_SYSTEM_PROMPT'],
    trainable: RP['DeriverResearchAgent.TRAINABLE_SYSTEM_PROMPT'] },
  { cls: 'VerifierResearchAgent', role: 'verifier', tags: ['research'], name: 'Verifier',
    frozen: RP['VerifierResearchAgent.FROZEN_SYSTEM_PROMPT'],
    trainable: RP['VerifierResearchAgent.TRAINABLE_SYSTEM_PROMPT'] },
  { cls: 'AnswerResearchAgent', role: 'answer', tags: ['terminal', 'final_answer'], name: 'Answer', postfix: R_ANSWER_PROMPT_POSTFIX, wakeAfter: ['deriver', 'verifier'], fallbackAfter: ['deriver'],
    frozen: RP['AnswerResearchAgent.FROZEN_SYSTEM_PROMPT'],
    trainable: RP['AnswerResearchAgent.TRAINABLE_SYSTEM_PROMPT'] },
];

// ---------------------------------------------------------------- MATH adapter (from the paper's text; not in the release)
// Paper Sec. 3.1 / App. D.2: initial population planner, executor, verifier; the
// planner proposes the immediate next step, the executor carries it out, the verifier
// judges it; "partial agents" with a short output budget (128 tokens on average).
// The paper does not say who submits the answer; here the executor does (it is the
// only terminal-tagged role). Prompt wording follows the research adapter's style.
function mustReplace(str, a, b) { if (!str.includes(a)) throw new Error('template changed: ' + a); return str.split(a).join(b); }
let M_NEXT_STEP_PROMPT = RP.NEXT_STEP_PROMPT;
M_NEXT_STEP_PROMPT = mustReplace(M_NEXT_STEP_PROMPT, 'five-agent team collaboratively solving a long-form\nscientific-reasoning problem.', 'three-agent team collaboratively solving a competition\nmathematics problem.');
M_NEXT_STEP_PROMPT = mustReplace(M_NEXT_STEP_PROMPT, '- You get exactly ONE turn. Make one substantive contribution that matches your role.', '- You get exactly ONE turn. Make one short contribution that matches your role.\n- Your output budget is about <<<token_budget>>> tokens. Anything longer is cut off.');
M_NEXT_STEP_PROMPT = mustReplace(M_NEXT_STEP_PROMPT, 'for the Answer agent,', 'for the Executor,');
M_NEXT_STEP_PROMPT = mustReplace(M_NEXT_STEP_PROMPT, '- The problem usually has several sub-questions (e.g. parts (a), (b), (c), ...). Progress through them in order and label your contribution with the sub-question it addresses when possible.\n', '');
M_NEXT_STEP_PROMPT = mustReplace(M_NEXT_STEP_PROMPT, '\n<<<judge_note>>>', '');
const M_EXECUTOR_POSTFIX = `
# Output format for the Executor role (important)
- You are the ONLY agent allowed to emit a final answer.
- When the step you carry out produces the final result of the problem, end your response with <final_answer>\\boxed{ANSWER}</final_answer>. Only the boxed answer is checked against the reference answer.
- Otherwise do NOT emit <final_answer>.`;
const M_TERMINAL_ABSTAIN = '- **TERMINAL MODE**: This is the final wrap-up step. Prefer giving the best possible <final_answer>\\boxed{...}</final_answer> from the current state over more work. If the state is truly insufficient, abstain with a single <step> explaining what is missing.';
const M_TERMINAL_NO_ABSTAIN = '- **TERMINAL MODE**: This is the final wrap-up step. You MUST emit a <final_answer>\\boxed{...}</final_answer> block with the best answer supported by the current shared state.';
const MATH_ROLES = [
  { cls: 'PlannerMathAgent', role: 'planner', tags: ['math'], name: 'Planner', selfStart: true,
    frozen: 'You are the **Planner** agent. You propose the immediate next step for solving the problem: what to compute or establish next, and how. You must NOT carry out the step yourself, and you must NOT emit <final_answer>.',
    trainable: 'Read the problem and the shared notes, then propose the single most useful next step in one or two sentences.\n- If there is no work yet, propose the first step.\n- If a Verifier flagged an error, propose how to repair it.\n- Do not calculate; just say what to do next.' },
  { cls: 'ExecutorMathAgent', role: 'executor', tags: ['terminal', 'final_answer'], name: 'Executor', postfix: M_EXECUTOR_POSTFIX,
    frozen: 'You are the **Executor** agent. You carry out the step most recently proposed by the Planner (or the next obvious step if none is pending). You are the ONLY agent that may emit a <final_answer>...</final_answer> block.',
    trainable: 'Carry out exactly one step of the solution:\n- Do the computation the latest plan asks for and show the key working briefly.\n- If a Verifier flagged an error, fix only that error.\n- When your step yields the answer to the question, give it as <final_answer>\\boxed{...}</final_answer>.' },
  { cls: 'VerifierMathAgent', role: 'verifier', tags: ['math'], name: 'Verifier',
    frozen: 'You are the **Verifier** agent. You judge whether the most recently executed step is correct. You must NOT carry out new steps and must NOT emit <final_answer>.',
    trainable: 'Inspect the latest Executor step and report exactly one of:\n- **Correct.** + one line on the check you applied.\n- **Error:** <what is wrong>. **Fix:** <what the Executor should do next>.\nDo not restate the work.' },
];

// MATH answer checking: Hendrycks et al. (2021) `is_equiv` / `strip_string`, ported.
function lastBoxed(s) {
  const i = Math.max(s.lastIndexOf('\\boxed'), s.lastIndexOf('\\fbox')); if (i < 0) return null;
  if (s.slice(i).startsWith('\\boxed ')) return s.slice(i + 7).split('$')[0].trim();
  let j = i, depth = 0, start = -1;
  for (; j < s.length; j++) { if (s[j] === '{') { if (depth === 0) start = j; depth++; } else if (s[j] === '}') { depth--; if (depth === 0) return s.slice(start + 1, j); } }
  return null;
}
function fixFracs(str) {
  const subs = str.split('\\frac'); let out = subs[0];
  for (const sub of subs.slice(1)) {
    out += '\\frac';
    if (sub[0] === '{') { out += sub; continue; }
    if (sub.length < 2) return str;
    const a = sub[0], b = sub[1];
    if (b !== '{') out += '{' + a + '}{' + b + '}' + sub.slice(2); else out += '{' + a + '}' + b + sub.slice(2);
  }
  return out;
}
function fixAOverB(s) { const p = s.split('/'); if (p.length !== 2) return s; if (/^-?\d+$/.test(p[0]) && /^-?\d+$/.test(p[1]) && String(parseInt(p[0])) === p[0] && String(parseInt(p[1])) === p[1]) return '\\frac{' + p[0] + '}{' + p[1] + '}'; return s; }
function fixSqrt(s) { if (!s.includes('\\sqrt')) return s; const sp = s.split('\\sqrt'); let n = sp[0]; for (const x of sp.slice(1)) { if (x[0] !== '{') n += '\\sqrt{' + x[0] + '}' + x.slice(1); else n += '\\sqrt' + x; } return n; }
function stripString(s) {
  s = s.replace(/\n/g, '').replace(/\\!/g, '').replace(/\\\\/g, '\\').replace(/tfrac/g, 'frac').replace(/dfrac/g, 'frac').replace(/\\left/g, '').replace(/\\right/g, '');
  s = s.replace(/\^\{\\circ\}/g, '').replace(/\^\\circ/g, '').replace(/\\\$/g, '');
  if (s.includes('\\text{ ')) s = s.split('\\text{ ')[0];
  s = s.replace(/\\%/g, '').replace(/%/g, '');
  s = s.replace(/ \./g, ' 0.').replace(/\{\./g, '{0.');
  if (!s.length) return s;
  if (s[0] === '.') s = '0' + s;
  const eq = s.split('='); if (eq.length === 2 && eq[0].length <= 2) s = eq[1];
  s = fixSqrt(s); s = s.replace(/ /g, ''); s = fixFracs(s);
  if (s === '0.5') s = '\\frac{1}{2}';
  s = fixAOverB(s);
  return s;
}
function isEquiv(a, b) { if (a == null || b == null) return false; try { return stripString(a) === stripString(b); } catch (e) { return a === b; } }

// ---------------------------------------------------------------- adapters
function stepBudget(stepCount, maxSteps) {
  const remaining = Math.max(0, maxSteps - stepCount);
  return '**Step ' + (stepCount + 1) + ' of ' + maxSteps + '** — ' + remaining + ' step(s) left. The team has a strict budget of ' + maxSteps + ' turns to finish this problem.';
}
const ADAPTERS = {
  research: {
    key: 'research', roles: RESEARCH_ROLES, terminalRole: 'answer',
    initState: (task) => '## Scientific problem\n\n' + task.problem + '\n\n## Shared solution notes (contributions from each agent will appear below)\n',
    nextStepPrompt(o) {
      const note = o.terminal ? (o.allowAbstain ? R_TERMINAL_ABSTAIN : R_TERMINAL_NO_ABSTAIN) : '';
      let p = fill(R_NEXT_STEP_PROMPT, { step_budget: stepBudget(o.stepCount, o.maxSteps), state: o.state, agent_system_prompt: o.systemPrompt, terminal_mode_note: note, judge_note: o.useJudge ? R_JUDGE_NOTE : '' });
      if (o.postfix) p += '\n' + o.postfix;
      return p;
    },
    expected: (task) => task.rubric,
    async score(task, answer, ctx, run) {
      // env.check_answer_correct -> score_answer_against_rubric (any exception -> False, 0.0)
      if (!run.useJudge) return [false, 0.0, 'Judge disabled — cannot score long-form answers.'];
      const prompt = fill(RUBRIC_JUDGE_PROMPT, { problem: task.problem, rubric: task.rubric, actual_output: answer || '' });
      try { const resp = (await ctx.ask('judge', prompt)).trim(); const [s, r] = parseJudge(resp); return [s >= run.judgeThreshold, s, r]; }
      catch (e) { if (isFatal(e)) throw e; return [false, 0.0, 'Rubric judge error: ' + String((e && (e.code || e.message)) || e)]; }
    },
  },
  math: {
    key: 'math', roles: MATH_ROLES, terminalRole: 'executor',
    initState: (task) => '## Math problem\n\n' + task.problem + '\n\n## Shared solution notes (contributions from each agent will appear below)\n',
    nextStepPrompt(o) {
      const note = o.terminal ? (o.allowAbstain ? M_TERMINAL_ABSTAIN : M_TERMINAL_NO_ABSTAIN) : '';
      let p = fill(M_NEXT_STEP_PROMPT, { step_budget: stepBudget(o.stepCount, o.maxSteps), state: o.state, agent_system_prompt: o.systemPrompt, terminal_mode_note: note, token_budget: String(o.tokenBudget || 128) });
      if (o.postfix) p += '\n' + o.postfix;
      return p;
    },
    expected: (task) => task.answer,
    async score(task, answer) {
      const boxed = lastBoxed(answer || '');
      const ok = isEquiv(boxed, task.answer);
      return [ok, ok ? 1.0 : 0.0, boxed == null ? 'No \\boxed{} answer found.' : (ok ? 'Matches ' : 'Does not match ') + 'the reference answer ' + task.answer + ' (gave ' + boxed + ').'];
    },
  },
};
const FATAL = ['not_granted', 'rate_limited', 'session_expired', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed', 'cancelled', 'prompt_too_large', 'stopped'];
function isFatal(e) { return !!(e && FATAL.includes(e.code)); }

// ---------------------------------------------------------------- agent.py
const NOVICE = 'novice', VETERAN = 'veteran', TYCOON = 'tycoon';
class Agent {
  constructor(spec, ids, name) {
    this.id = ++ids.counter;
    this.cls = spec.cls; this.role = spec.role; this.agent_tags = spec.tags.slice();
    this.name = name || spec.name;
    this.frozen_system_prompt = spec.frozen; this.trainable_system_prompt = spec.trainable;
    this.prompt_postfix = spec.postfix || '';
    this.wealth = 0.0; this.capability_score = 0.0; this._bid = null; this._status = NOVICE;
    this.root_ancestor_class = spec.cls; this.father_agent_id = this.id; this.father_agent_name = this.name;
    this.parent_agent_id = null; this.parent_agent_name = null; this.spawn_method = 'initial';
    this.tasks_lived = 0; this.bankruptcy_episode = null; this._death_trace = '';
    this.recent_failure_trace = ''; this.recent_failure_task = ''; this.recent_failure_answer = '';
    this.born_episode = 0; this.wins = 0; // page: statistics only
  }
  getSystemPrompt() { return this.frozen_system_prompt ? this.frozen_system_prompt + '\n\n' + this.trainable_system_prompt : this.trainable_system_prompt; }
  gain_money(x) { this.wealth += x; }
  gain_capability(x) { this.capability_score += x; }
  lose_money(x) { this.wealth -= x; }
  initialize(w) { this.wealth = w; this.capability_score = 0.0; this._status = NOVICE; this._bid = 0.0; }
  check_bankruptcy() { return this.wealth < 0; }
  has_any_tag(tags) { return this.agent_tags.some((t) => tags.includes(t)); }
  record_death_trace(history) {
    const parts = [];
    for (const [step, d] of sortedHistory(history)) { const text = (d.text || '').trim(); if (!text) continue; parts.push((d.author === this.name ? '>>> ' : '    ') + '[Step ' + step + '] [' + d.author + '] ' + text); }
    this._death_trace = parts.join('\n\n');
  }
  record_recent_failure(trace, task, answer) { this.recent_failure_trace = trace; this.recent_failure_task = task; this.recent_failure_answer = answer; }
  snapshot() { return { wealth: this.wealth, capability_score: this.capability_score, bid: this._bid, status: this._status }; }
  serialize() {
    const o = {}; for (const k of Object.keys(this)) o[k] = Array.isArray(this[k]) ? this[k].slice() : this[k]; return o;
  }
  static deserialize(o) { const a = Object.create(Agent.prototype); Object.assign(a, o); a.agent_tags = (o.agent_tags || []).slice(); return a; }
}
function sortedHistory(h) { return Object.keys(h).map(Number).sort((a, b) => a - b).map((k) => [k, h[k]]); }
function specFor(adapter, cls) { return adapter.roles.find((r) => r.cls === cls); }

// ---------------------------------------------------------------- population.py
class Population {
  constructor() { this.map = new Map(); }
  add_agent(a) { this.map.set(a.id, a); }
  remove_agent(a) { this.map.delete(a.id); }
  get size() { return this.map.size; }
  get_all() { return [...this.map.values()]; }
  get_richest_agent() { let best = null; for (const a of this.map.values()) if (!best || a.wealth > best.wealth) best = a; return best; }
  get_poorest_agent() { let w = null; for (const a of this.map.values()) if (!w || a.wealth < w.wealth) w = a; return w; }
}

// ---------------------------------------------------------------- environment (researchworld/env.py)
const STEP_RE = /<step>([\s\S]*?)<\/step>/i, FINAL_RE = /<final_answer>([\s\S]*?)<\/final_answer>/i;
function makeAction(text, author, role) {
  text = text || '';
  const sm = STEP_RE.exec(text), fm = FINAL_RE.exec(text);
  const final = fm ? fm[1].trim() : null;
  return { text, author, role, step_text: sm ? sm[1].trim() : text.trim(), final_answer_text: final, is_final: final !== null };
}
class TextEnv {
  constructor(adapter, task, run) {
    this.adapter = adapter; this.task = task; this.run = run; this.max_steps = run.maxSteps;
    this.use_judge = run.useJudge; this.initialize();
  }
  initialize() {
    this.step_count = 0; this.terminated = false; this.action_history = {};
    this.final_answer = null; this._last_terminal_score = null; this._last_judge_reason = null; this._last_judge_passed = null;
    this._final_answer_author = null; this._last_final_reward = 0.0;
    this.state = this.adapter.initState(this.task);
  }
  lastStep() { const ks = Object.keys(this.action_history).map(Number); return ks.length ? this.action_history[Math.max(...ks)] : null; }
  get_last_author() { const s = this.lastStep(); return s ? s.author : null; }
  get_last_role() { const s = this.lastStep(); return s ? s.role : null; }
  get_terminal_score() { return this._last_terminal_score; }
  get_path_reward_score() { return this.get_terminal_score(); }
  get_task_description() { return this.task.problem; }
  get_correct_answer() { return this.adapter.expected(this.task); }
  is_successful() { return this._last_judge_passed; }
  async apply(action, ctx, emit) {
    if (this.terminated) return 0.0;
    this.step_count += 1;
    const stepText = (action.text || '').trim();
    this.action_history[this.step_count] = { author: action.author || '', role: action.role || '', text: stepText, is_final: action.is_final };
    const prefix = action.author ? '[Message from agent: ' + action.author + '] ' : '';
    if (stepText) this.state += '\n\n' + prefix + stepText;
    if (action.is_final && action.role === this.adapter.terminalRole) return this._handleFinal(action.final_answer_text || action.step_text, action.author, ctx, emit);
    return 0.0;
  }
  async _handleFinal(answer, author, ctx, emit) {
    this.final_answer = answer; this.terminated = true; this._final_answer_author = author || null;
    emit && emit('judge:start', {});
    const [passed, score, reason] = await this.adapter.score(this.task, answer, ctx, this.run);
    const sfr = score != null ? score : this.run.rewardCfg.missing_terminal_score;
    const reward = Reward.bonus(this.run.rewardCfg, sfr);
    this._last_final_reward = reward; this._last_terminal_score = score; this._last_judge_reason = reason || ''; this._last_judge_passed = passed;
    emit && emit('judge', { passed, score, reason, answer: String(answer).slice(0, 4000), author });
    return reward;
  }
}

// ---------------------------------------------------------------- agent behaviour (researchworld/agent.py ResearchAgent)
async function wakeLLM(agent, env, ctx) {
  const prompt = fill(WAKEUP_PROMPT, { agent_system_prompt: agent.getSystemPrompt(), state: env.state });
  const resp = ((await ctx.ask('wake', prompt)) || '').trim().toLowerCase();
  return resp.includes('boxed{yes}');
}
async function matchWakeup(agent, adapter, env, ctx) {
  const spec = specFor(adapter, agent.cls);
  if (spec.selfStart && !env.get_last_author()) return { yes: true, why: 'auto-start' };
  if (spec.wakeAfter) {
    const last = env.get_last_role();
    if (!last) return { yes: false, why: 'no prior actions' };
    if (!spec.wakeAfter.includes(last)) return { yes: false, why: 'last role was ' + last };
    const base = await baseWake(agent, env, ctx);
    if (base.yes) return base;
    if (spec.fallbackAfter.includes(last)) return { yes: true, why: 'fallback after ' + last };
    return base;
  }
  return baseWake(agent, env, ctx);
}
async function baseWake(agent, env, ctx) {
  if (env.get_last_role() === agent.role) return { yes: false, why: 'same role' };
  return { yes: await wakeLLM(agent, env, ctx), why: 'model' };
}
async function agentAct(agent, adapter, env, ctx, onText) {
  const prompt = adapter.nextStepPrompt({ state: env.state, systemPrompt: agent.getSystemPrompt(), stepCount: env.step_count, maxSteps: env.max_steps, useJudge: env.use_judge, terminal: !!env.terminal_mode, allowAbstain: env.allow_abstain_terminal_mode !== false, postfix: agent.prompt_postfix, tokenBudget: env.run.tokenBudget });
  let response = await ctx.ask('act', prompt, { onText });
  // page: the paper's "partial agents" have a short max output budget. The release caps
  // tokens with max_tokens; the page cannot, so it cuts the reply at the budget.
  if (env.run.maxActChars && response.length > env.run.maxActChars) response = response.slice(0, env.run.maxActChars);
  let action = makeAction(response, agent.name, agent.role);
  if (env.terminal_mode && agent.role === adapter.terminalRole && !action.is_final && action.step_text) {
    response = response.replace(/\s+$/, '') + '\n\n<final_answer>\n' + action.step_text.trim() + '\n</final_answer>';
    action = makeAction(response, agent.name, agent.role);
  }
  return action;
}
async function birthGood(parent, adapter, ctx, ids, rng) {
  const raw = await ctx.ask('birth', formatMutate(parent.frozen_system_prompt, parent.trainable_system_prompt));
  let tp = cleanTrainable(raw, parent.frozen_system_prompt);
  if (!tp || tp.length < 10) tp = parent.trainable_system_prompt;
  const base = parent.name.includes('-') ? parent.name.split('-')[0] : parent.name;
  const a = new Agent(specFor(adapter, parent.cls), ids, base + '-' + rng.randint(1000, 9999));
  a.frozen_system_prompt = parent.frozen_system_prompt; a.trainable_system_prompt = tp;
  return a;
}
async function birthBad(source, adapter, ctx, ids, rng, task, answer, trace) {
  const prompt = formatSpawn(source.frozen_system_prompt, source.trainable_system_prompt, trace || source.recent_failure_trace || source._death_trace, task || source.recent_failure_task, answer || source.recent_failure_answer);
  const raw = await ctx.ask('birth', prompt);
  let tp = cleanTrainable(raw, source.frozen_system_prompt);
  if (!tp || tp.length < 10) tp = source.trainable_system_prompt;
  const base = source.name.includes('-') ? source.name.split('-')[0] : source.name;
  const a = new Agent(specFor(adapter, source.cls), ids, base + '-' + rng.randint(1000, 9999));
  a.frozen_system_prompt = source.frozen_system_prompt; a.trainable_system_prompt = tp;
  return { agent: a, prompt };
}

// ---------------------------------------------------------------- mas.py
class HayekMAS {
  constructor(config, adapter, run, ctx, emit, rng, ids) {
    this.config = JSON.parse(JSON.stringify(config));
    this.adapter = adapter; this.run = run; this.ctx = ctx; this.emit = emit || (() => {}); this.rng = rng; this.ids = ids;
    const e = this.config.engine;
    this.max_steps_per_episode = e.max_steps_per_episode; this.max_trials_per_episode = e.max_trials_per_episode;
    this.birth_interval = e.birth_interval; this.num_births_per_interval = e.num_births_per_interval;
    this.min_num_agents = e.min_num_agents; this.max_num_agents = e.max_num_agents;
    this.bid_scheme = e.bid_scheme; this.reward_scheme = this.config.reward.reward_scheme;
    if (!['path_reward_only', 'path_reward_and_stepwise_reward'].includes(this.reward_scheme)) throw new Error('bad reward_scheme ' + this.reward_scheme);
    this.base_bid = e.base_bid; this.novice_bid_epsilon = e.novice_bid_epsilon; this.holland_alpha = e.holland_alpha; this.tycoon_wealth_threshold = e.tycoon_wealth_threshold;
    this.population = new Population(); this._training = null;
    this.episode_count = 0; this.total_rewards = 0.0; this.bankruptcy_count = 0; this.last_termination_reason = 'none';
    this._initial_agents = [];
    this.page = this.config.page || {}; // page: optional paper ablations (not in the release)
  }
  train() { this._training = true; return this; }
  eval() { this._training = false; return this; }
  async run_one_episode(env) { if (this._training) return this._train_forward(env); return this._eval_forward(env); }

  // ─── AGENT CREATION ───
  async birth_good_agent(parent) {
    this.emit('birth:start', { kind: 'good', parent: parent.name });
    try {
      const a = await birthGood(parent, this.adapter, this.ctx, this.ids, this.rng);
      a.root_ancestor_class = parent.root_ancestor_class || parent.cls; a.father_agent_id = parent.father_agent_id; a.father_agent_name = parent.father_agent_name;
      a.parent_agent_id = parent.id; a.parent_agent_name = parent.name; a.spawn_method = 'good_birth'; a.tasks_lived = 0; a.bankruptcy_episode = null;
      a._birthInfo = { kind: 'good', parent: parent.name, parentId: parent.id, before: parent.trainable_system_prompt };
      return a;
    } catch (err) { if (isFatal(err)) throw err; this.emit('warn', { text: 'Good-birth spawning failed: ' + (err.code || err.message || err) }); return null; }
  }
  async birth_bad_agent(source, env) {
    this.emit('birth:start', { kind: 'bad', parent: source.name });
    try {
      const task = env ? env.get_task_description() : '';
      const ans = env ? env.get_correct_answer() : '';
      const { agent: a } = await birthBad(source, this.adapter, this.ctx, this.ids, this.rng, task || source.recent_failure_task, ans || source.recent_failure_answer, source.recent_failure_trace || source._death_trace);
      a.root_ancestor_class = source.root_ancestor_class || source.cls; a.father_agent_id = source.father_agent_id; a.father_agent_name = source.father_agent_name;
      a.parent_agent_id = source.id; a.parent_agent_name = source.name; a.spawn_method = 'bad_birth'; a.tasks_lived = 0; a.bankruptcy_episode = null;
      a._birthInfo = { kind: 'bad', parent: source.name, parentId: source.id, before: source.trainable_system_prompt, trace: (source.recent_failure_trace || source._death_trace || '').slice(0, 6000), hadTrace: !!(source.recent_failure_trace || source._death_trace) };
      return a;
    } catch (err) { if (isFatal(err)) throw err; this.emit('warn', { text: 'Bad-birth spawning failed: ' + (err.code || err.message || err) }); return null; }
  }
  remove_bankrupt_agents(env) {
    const bankrupt = this.population.get_all().filter((a) => a.check_bankruptcy());
    for (const b of bankrupt) {
      b.bankruptcy_episode = this.episode_count;
      if (env && Object.keys(env.action_history).length) b.record_death_trace(env.action_history);
      this.population.remove_agent(b); this.bankruptcy_count += 1;
      this.emit('bankrupt', { id: b.id, name: b.name, role: b.role, wealth: b.wealth });
    }
    return bankrupt;
  }
  _can_add_agent() { return this.max_num_agents <= 0 || this.population.size < this.max_num_agents; }
  _add_born_agent(a, why) {
    if (!a) return false;
    if (!this._can_add_agent()) { this.emit('warn', { text: 'Population cap reached; skipping birth' }); return false; }
    a.initialize(this.config.engine.initial_wealth); a.born_episode = this.episode_count;
    this.population.add_agent(a);
    const info = a._birthInfo || {}; delete a._birthInfo;
    this.emit('birth', Object.assign({ why, agent: summarize(a), after: a.trainable_system_prompt }, info));
    return true;
  }
  _validate() {
    const { p_a, p_b, periodical_good_p } = this.config.evolution;
    if (!(p_a >= 0 && p_a <= 1) || !(p_b >= 0 && p_b <= 1) || p_a + p_b > 1 || !(periodical_good_p >= 0 && periodical_good_p <= 1)) throw new Error('bad evolution probabilities');
  }
  _build_agent_failure_trace(env, name) {
    const parts = [];
    for (const [step, d] of sortedHistory(env.action_history)) { const text = (d.text || '').trim(); if (!text) continue; parts.push((d.author === name ? '>>>' : '   ') + ' [Step ' + step + '] [Message from agent: ' + d.author + '] ' + text); }
    return parts.join('\n\n');
  }
  _episode_failed(env) { const s = env.is_successful(); if (s !== null && s !== undefined) return !s; const sc = env.get_terminal_score(); return sc == null || sc < 1.0; }
  _record_recent_failures(env) {
    if (!this._episode_failed(env)) return;
    const task = env.get_task_description(), ans = env.get_correct_answer();
    for (const a of this.population.get_all()) { const tr = this._build_agent_failure_trace(env, a.name); if (tr) a.record_recent_failure(tr, task, ans); }
  }
  async _resolve_bankruptcy_births(all, env) {
    if (!all.length) return;
    this._validate(); const { p_a, p_b } = this.config.evolution;
    for (const b of all) {
      const draw = this.rng.random();
      if (draw < p_a) { if (this.page.noExploitation) continue; const parent = this.population.get_richest_agent(); if (parent) this._add_born_agent(await this.birth_good_agent(parent), 'after bankruptcy, copy of the richest'); }
      else if (draw < p_a + p_b) { if (this.page.noExploration) continue; this._add_born_agent(await this.birth_bad_agent(b, env), 'after bankruptcy, repair of ' + b.name); }
    }
  }
  async _ensure_necessary_roles_exist(bankrupts, env) {
    if (!this._initial_agents.length) return;
    const original = new Set(this._initial_agents.map((a) => a.role)), living = new Set(this.population.get_all().map((a) => a.role));
    const missing = [...original].filter((r) => !living.has(r)); if (!missing.length) return;
    for (const role of missing) {
      const cands = bankrupts.filter((a) => a.role === role);
      if (!cands.length) throw new Error('Role ' + role + ' is missing from the population but no bankrupt agent of that role was found');
      const src = this.rng.choice(cands);
      if (!this._add_born_agent(await this.birth_bad_agent(src, env), 'role recovery: no ' + role + ' left')) throw new Error('Role recovery failed for ' + role);
    }
  }
  _get_terminal_score(env) { const s = env.get_terminal_score(); return s == null ? this.config.reward.missing_terminal_score : s; }
  _get_path_reward_score(env) { const s = env.get_path_reward_score(); return s == null ? this.config.reward.missing_terminal_score : s; }
  _get_episode_path_agents(env) {
    const lookup = new Map(); for (const a of this.population.get_all()) lookup.set(a.name, a); // dict: later name wins
    const out = []; for (const [, d] of sortedHistory(env.action_history)) { if (!d.author) continue; const a = lookup.get(d.author); if (a) out.push(a); }
    return out;
  }
  _apply_path_rewards(env) {
    const score = this._get_terminal_score(env), pay = this._get_path_reward_score(env), rc = this.config.reward;
    const path = this._get_episode_path_agents(env);
    let targets = path;
    if (rc.path_reward_per_unique_author) { const seen = new Set(); targets = path.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true))); }
    const per = Reward.perAgent(rc, pay, targets.length);
    for (const a of targets) { a.gain_money(per); a.gain_capability(per); }
    this.total_rewards += per * targets.length;
    this.emit('path', { score, signal: Reward.signal(rc, pay), per, n: targets.length, ids: targets.map((a) => a.id) });
    return { terminal_score: score, per, n: targets.length };
  }
  _is_terminal_mode_step(step) {
    const t = this.config.terminal; if (!t.enabled) return false;
    const s = Math.max(0, t.start_on_step_from_end); if (s <= 0) return false;
    return this.max_steps_per_episode - step <= s;
  }
  _restrict_terminal(cands) { const t = this.config.terminal; if (!t || !t.enabled) return cands; const tags = t.candidate_agent_tags || []; if (!tags.length) return cands; return cands.filter((a) => a.has_any_tag(tags)); }

  async _get_active(env) {
    // population.get_active + _match_with_retry. page: the page runs the checks
    // through one shared queue (Claude allows a couple of calls at once), so
    // "parallel" means "queued", with the same result in agent order.
    const cc = this.config.concurrency, agents = this.population.get_all();
    const attempts = Math.max(1, (cc.wakeup_retry_attempts || 0) + 1);
    this.emit('wake:start', { ids: agents.map((a) => a.id) });
    const check = async (a) => {
      for (let i = 0; i < attempts; i++) {
        try { const r = await matchWakeup(a, this.adapter, env, this.ctx); this.emit('wake:result', { id: a.id, yes: r.yes, why: r.why }); return r.yes; }
        catch (e) {
          if (isFatal(e)) throw e;
          if (i === attempts - 1) { this.emit('wake:result', { id: a.id, yes: !!cc.wakeup_fail_open, why: 'error' }); return !!cc.wakeup_fail_open; }
          await sleep(Math.max(0, cc.wakeup_retry_backoff_seconds) * 1000 * Math.pow(2, i));
        }
      }
      return !!cc.wakeup_fail_open;
    };
    const flags = await Promise.all(agents.map(check));
    return agents.filter((a, i) => flags[i]);
  }

  async _run_auction_action_loop(env) {
    let prev = null, chain = [];
    const rc = this.config.reward, chainSize = Math.max(1, rc.step_reward_chain_window | 0), split = !!rc.step_reward_split_chain, training = this._training;
    this.last_termination_reason = 'max_steps';
    for (let step = 0; step < this.max_steps_per_episode; step++) {
      if (this.ctx.shouldStop && this.ctx.shouldStop()) { const e = new Error('stopped'); e.code = 'stopped'; throw e; }
      const terminal = this._is_terminal_mode_step(step);
      env.terminal_mode = terminal; env.allow_abstain_terminal_mode = this.config.terminal.allow_abstain_terminal_mode;
      this.emit('step:start', { step, terminal });
      let active;
      if (terminal) { active = this._restrict_terminal(this.population.get_all()); this.emit('terminal', { ids: active.map((a) => a.id) }); }
      else active = await this._get_active(env);
      if (!active.length) { this.last_termination_reason = 'no_active_agents'; this.emit('noactive', { step }); break; }

      // ─── BID INITIALIZATION ───
      if (training) {
        if (this.bid_scheme === 'fixed') {
          for (const a of active) {
            if (a._status === NOVICE) { a._bid = this.base_bid + this.novice_bid_epsilon; a._status = VETERAN; this.emit('novice', { id: a.id, bid: a._bid }); }
            else if (a._status === VETERAN) a._bid = this.base_bid;
          }
        } else if (this.bid_scheme === 'fixed_with_eps') {
          const vb = active.filter((a) => a._status === VETERAN && a._bid != null).map((a) => a._bid);
          const high = vb.length ? Math.max(...vb) : this.base_bid;
          for (const a of active) if (a._status === NOVICE) { a._bid = high + this.novice_bid_epsilon; a._status = VETERAN; this.emit('novice', { id: a.id, bid: a._bid }); }
        } else if (this.bid_scheme === 'holland') {
          const tb = active.filter((a) => a._status === TYCOON && a._bid != null).map((a) => a._bid);
          const high = tb.length ? Math.max(...tb) : this.base_bid;
          for (const a of active) {
            if (a._status === NOVICE) { a._bid = high + this.novice_bid_epsilon; a._status = VETERAN; this.emit('novice', { id: a.id, bid: a._bid }); }
            else if (a._status === VETERAN) { if (a.wealth >= this.tycoon_wealth_threshold) { a._status = TYCOON; a._bid = this.holland_alpha * a.wealth; } else a._bid = this.base_bid; }
            else if (a._status === TYCOON) a._bid = this.holland_alpha * a.wealth;
          }
        } else throw new Error('Unknown bid_scheme: ' + this.bid_scheme);
      }

      // ─── AUCTION ───
      const maxBid = Math.max(...active.map((a) => a._bid));
      const top = active.filter((a) => a._bid === maxBid);
      // page: "w/o auction" ablation from the paper's Table 2 (not in the release): random active agent.
      const winner = this.page.noAuction ? this.rng.choice(active) : this.rng.choice(top);
      winner.wins = (winner.wins || 0) + 1;
      this.emit('auction', { step, terminal, bids: active.map((a) => ({ id: a.id, bid: a._bid })), winner: winner.id, ties: top.length, byAuction: !this.page.noAuction });

      // ─── PAYMENT (TRAINING ONLY) ───
      if (training) {
        const payment = winner._bid; winner.lose_money(payment);
        if (prev) prev.gain_money(payment);
        this.emit('pay', { from: winner.id, to: prev ? prev.id : null, amount: payment, same: !!(prev && prev.id === winner.id) });
      }

      // ─── ACTION ───
      chain.push(winner); if (chain.length > chainSize) chain = chain.slice(-chainSize);
      this.emit('act:start', { id: winner.id, name: winner.name, role: winner.role, step });
      const action = await agentAct(winner, this.adapter, env, this.ctx, (t) => this.emit('act:text', { id: winner.id, text: t }));
      this.emit('act', { id: winner.id, name: winner.name, role: winner.role, step, text: action.text, isFinal: action.is_final });

      // ─── REWARD ───
      const reward = await env.apply(action, this.ctx, this.emit);
      if (training && this.reward_scheme === 'path_reward_and_stepwise_reward') {
        if (split && reward !== 0) {
          const seen = new Set(), uniq = []; for (const a of chain) if (!seen.has(a.id)) { seen.add(a.id); uniq.push(a); }
          const share = reward / uniq.length; for (const a of uniq) { a.gain_money(share); a.gain_capability(share); }
          this.total_rewards += reward; this.emit('reward', { ids: uniq.map((a) => a.id), amount: share, why: 'step' });
        } else {
          winner.gain_money(reward); winner.gain_capability(reward); this.total_rewards += reward;
          if (reward !== 0) this.emit('reward', { ids: [winner.id], amount: reward, why: 'step' });
        }
      }
      if (env.terminated) { this.last_termination_reason = 'goal_reached'; break; }
      if (training) prev = winner;
    }
  }

  async _train_forward(env) {
    if (!this.population.size) throw new Error('No agents in population!');
    this.episode_count += 1;
    let allBankrupts = [];
    for (const a of this.population.get_all()) a.tasks_lived += 1;
    const snap = () => { const m = new Map(); for (const a of this.population.get_all()) m.set(a.id, a.snapshot()); return m; };
    let pre = snap(), preTotal = this.total_rewards, replays = 0, details = {};
    for (let trial = 0; trial < this.max_trials_per_episode; trial++) {
      if (trial > 0) { pre = snap(); preTotal = this.total_rewards; replays++; }
      this.emit('trial', { trial: trial + 1, of: this.max_trials_per_episode });
      env.initialize();
      await this._run_auction_action_loop(env);
      details = this._apply_path_rewards(env);
      this._record_recent_failures(env);
      this.emit('credit', { wealth: this.population.get_all().map((a) => ({ id: a.id, wealth: a.wealth })) });
      const bankrupt = this.remove_bankrupt_agents(env);
      await this._ensure_necessary_roles_exist(bankrupt, env);
      if (bankrupt.length) {
        allBankrupts = allBankrupts.concat(bankrupt);
        if (!this.population.size) throw new Error('population empty');
        for (const a of this.population.get_all()) if (pre.has(a.id)) { const s = pre.get(a.id); a.wealth = s.wealth; a.capability_score = s.capability_score; }
        this.total_rewards = preTotal;
        this.emit('rollback', { trial: trial + 1, last: trial === this.max_trials_per_episode - 1, wealth: this.population.get_all().map((a) => ({ id: a.id, wealth: a.wealth })) });
        continue;
      } else { this.emit('accepted', { trial: trial + 1 }); break; }
    }
    // ─── RENT ───
    const { rent, rent_interval } = this.config.engine;
    if (rent > 0 && rent_interval > 0 && this.episode_count % rent_interval === 0) {
      for (const a of this.population.get_all()) a.lose_money(rent);
      this.emit('rent', { amount: rent, ids: this.population.get_all().map((a) => a.id) });
      const rb = this.remove_bankrupt_agents(null);
      await this._ensure_necessary_roles_exist(rb, env);
      allBankrupts = allBankrupts.concat(rb);
    }
    await this._resolve_bankruptcy_births(allBankrupts, env);
    // ─── PERIODIC BIRTHS ───
    if (this.birth_interval > 0 && this.episode_count % this.birth_interval === 0 && this._can_add_agent()) {
      this._validate();
      for (let i = 0; i < this.num_births_per_interval; i++) {
        if (!this._can_add_agent()) break;
        if (this.rng.random() < this.config.evolution.periodical_good_p) { if (this.page.noExploitation) continue; const p = this.population.get_richest_agent(); if (p) this._add_born_agent(await this.birth_good_agent(p), 'periodic birth, copy of the richest'); }
        else { if (this.page.noExploration) continue; const s = this.population.get_poorest_agent(); if (s) this._add_born_agent(await this.birth_bad_agent(s, env), 'periodic birth, repair of the poorest'); }
      }
    }
    // ─── REPLENISH ───
    if (this.min_num_agents > 0 && this.population.size < this.min_num_agents) {
      for (const parent of this._initial_agents) {
        if (this.population.size >= this.min_num_agents) break;
        const src = this.population.get_richest_agent() || parent;
        const na = await this.birth_good_agent(src); if (na) this._add_born_agent(na, 'refill to the minimum population');
      }
    }
    return { replays, bankrupt: allBankrupts.length, details };
  }
  async _eval_forward(env) {
    this.episode_count += 1;
    if (!this.population.size) throw new Error('No agents in population!');
    env.initialize();
    await this._run_auction_action_loop(env);
  }
  serialize() {
    return { episode_count: this.episode_count, total_rewards: this.total_rewards, bankruptcy_count: this.bankruptcy_count, population: this.population.get_all().map((a) => a.serialize()), initial: this._initial_agents.map((a) => a.serialize()) };
  }
  load(o) {
    this.episode_count = o.episode_count; this.total_rewards = o.total_rewards; this.bankruptcy_count = o.bankruptcy_count;
    const byId = new Map();
    for (const d of o.population) { const a = Agent.deserialize(d); this.population.add_agent(a); byId.set(a.id, a); }
    this._initial_agents = (o.initial || []).map((d) => byId.get(d.id) || Agent.deserialize(d));
    return this;
  }
}
function summarize(a) { return { id: a.id, name: a.name, role: a.role, cls: a.cls, bid: a._bid, status: a._status, wealth: a.wealth, spawn: a.spawn_method, parent: a.parent_agent_name, trainable: a.trainable_system_prompt, frozen: a.frozen_system_prompt, born: a.born_episode, wins: a.wins || 0 }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- pipeline.py Trainer (+ runtime.py periodic test)
// state is a plain object, saved after every training task (pipeline._save_progress)
// so a run can resume from the last completed task, as the release does.
function newRunState(preset, data) {
  const cfg = configFromDict(preset.mas);
  return {
    version: 1, preset: preset.key, adapter: preset.adapter, label: preset.label, cfg, run: preset.run,
    trainIds: preset.trainIds, testIds: preset.testIds, numEpochs: preset.run.num_epochs,
    epoch: 0, taskIndex: 0, tasksCompleted: 0, totalProcessed: 0, totalSuccess: 0,
    rng: (preset.seed || 2606) >>> 0, idCounter: 0, mas: null, tests: [], episodes: [], pretrainDone: false, done: false, calls: 0,
  };
}
function runOptions(state) {
  const r = state.run;
  return { maxSteps: state.cfg.engine.max_steps_per_episode, useJudge: r.judge !== false, judgeThreshold: r.judge_threshold != null ? r.judge_threshold : 0.5, rewardCfg: state.cfg.reward, tokenBudget: r.token_budget || null, maxActChars: r.max_act_chars || 0 };
}
class Trainer {
  constructor(state, data, ctx, emit) {
    this.state = state; this.data = data; this.ctx = ctx; this.emit = emit || (() => {});
    this.adapter = ADAPTERS[state.adapter];
    this.pool = state.adapter === 'research' ? data.research : data.math;
    const byId = (list) => { const m = new Map(list.map((t) => [t.id, t])); return (ids) => ids.map((i) => m.get(i)).filter(Boolean); };
    this.tasks = byId(this.pool.train)(state.trainIds); this.testTasks = byId(this.pool.test)(state.testIds);
    this.rng = makeRng(state.rng); this.ids = { counter: state.idCounter };
    this.opts = runOptions(state);
    this.mas = new HayekMAS(state.cfg, this.adapter, this.opts, ctx, emit, this.rng, this.ids);
    if (state.mas) this.mas.load(state.mas);
    else {
      for (const spec of this.adapter.roles) { const a = new Agent(spec, this.ids); a.initialize(state.cfg.engine.initial_wealth); this.mas.population.add_agent(a); }
      this.mas._initial_agents = this.mas.population.get_all();
    }
    this.mas.train();
  }
  checkpoint() {
    const s = this.state; s.rng = this.rng.s; s.idCounter = this.ids.counter; s.mas = this.mas.serialize();
    return s;
  }
  check_success(env) { if (!env.final_answer) return false; const c = env.is_successful(); return c != null ? c : false; }
  async runTask() {
    // one training task (pipeline.train inner loop body); returns false when finished
    const s = this.state;
    if (!s.pretrainDone) {
      s.pretrainDone = true;
      if (s.cfg.evaluation.periodic_test_enabled && s.cfg.evaluation.periodic_test_before_training) { await this.periodicTest(0, 0); this.emit('checkpoint', this.checkpoint()); return true; }
    }
    if (s.epoch >= s.numEpochs) { s.done = true; this.emit('done', {}); return false; }
    const task = this.tasks[s.taskIndex];
    this.emit('task:start', { mode: 'train', epoch: s.epoch, index: s.taskIndex, of: this.tasks.length, tasksCompleted: s.tasksCompleted, task: taskMeta(task), agents: this.mas.population.get_all().map(summarize), episode: this.mas.episode_count + 1 });
    const env = new TextEnv(this.adapter, task, this.opts);
    const info = await this.mas.run_one_episode(env);
    const success = this.check_success(env);
    s.totalProcessed++; s.tasksCompleted++; if (success) s.totalSuccess++;
    s.taskIndex++; if (s.taskIndex >= this.tasks.length) { s.taskIndex = 0; s.epoch++; }
    this.emit('task:end', { mode: 'train', success, score: env.get_terminal_score(), reason: env._last_judge_reason, termination: this.mas.last_termination_reason, replays: info.replays, agents: this.mas.population.get_all().map(summarize), tasksCompleted: s.tasksCompleted, episode: this.mas.episode_count });
    this.emit('checkpoint', this.checkpoint());
    const ev = s.cfg.evaluation, n = ev.periodic_test_every_n_tasks;
    if (ev.periodic_test_enabled && n > 0 && s.tasksCompleted % n === 0) { await this.periodicTest(s.epoch, s.tasksCompleted); this.emit('checkpoint', this.checkpoint()); }
    if (s.epoch >= s.numEpochs) { s.done = true; this.emit('done', {}); return false; }
    return true;
  }
  async periodicTest(epoch, tasksCompleted) {
    // runtime.run_periodic_test: frozen copies of the population, one per test task.
    const snapshot = JSON.parse(JSON.stringify(this.mas.serialize()));
    const tasks = this.testTasks; const results = new Array(tasks.length);
    this.emit('test:start', { tasksCompleted, n: tasks.length, epoch });
    const workers = Math.max(1, Math.min(this.state.run.test_workers || 3, this.state.cfg.evaluation.periodic_test_max_workers || 1));
    let next = 0;
    const runOne = async (i) => {
      const task = tasks[i];
      const rng = makeRng((this.state.rng ^ (tasksCompleted * 7919 + i * 104729)) >>> 0);
      const tEmit = (type, p) => this.emit('test:event', { i, type, p });
      const mas = new HayekMAS(this.state.cfg, this.adapter, this.opts, this.ctx, tEmit, rng, { counter: 1e9 }).load(JSON.parse(JSON.stringify(snapshot))).eval();
      const env = new TextEnv(this.adapter, task, this.opts);
      this.emit('test:task:start', { i, task: taskMeta(task) });
      await mas.run_one_episode(env);
      const path = sortedHistory(env.action_history).map(([, d]) => d.role);
      results[i] = { id: task.id, level: task.level || null, subject: task.subject || '', success: this.check_success(env), score: env.get_terminal_score(), reason: (env._last_judge_reason || '').slice(0, 600), answer: (env.final_answer || '').slice(0, 1500), path, steps: env.step_count, termination: mas.last_termination_reason };
      this.emit('test:task', Object.assign({ i }, results[i]));
    };
    const worker = async () => { while (next < tasks.length) { const i = next++; await runOne(i); } };
    await Promise.all(Array.from({ length: Math.min(workers, tasks.length) }, worker));
    const succ = results.filter((r) => r.success).length, scores = results.map((r) => r.score).filter((x) => x != null);
    const rec = { epoch, tasksCompleted, accuracy: tasks.length ? succ / tasks.length : 0, success: succ, total: tasks.length, avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null, results, population: this.mas.population.size };
    this.state.tests.push(rec);
    this.emit('test:end', rec);
    return rec;
  }
}
function taskMeta(t) { return { id: t.id, level: t.level || null, subject: t.subject || '', problem: t.problem, expected: t.answer || null }; }

// ---------------------------------------------------------------- presets
function pickTests(list, perLevel) { if (!perLevel) return list.map((t) => t.id); const out = []; for (let L = 1; L <= 5; L++) out.push(...list.filter((t) => t.level === L).slice(0, perLevel).map((t) => t.id)); return out; }
function pickTrain(list, perLevel) { const out = []; for (let L = 1; L <= 5; L++) out.push(...list.filter((t) => t.level === L).slice(0, perLevel).map((t) => t.id)); return out; }
function buildPresets(data) {
  const mathMas = (over) => {
    const m = JSON.parse(JSON.stringify(RELEASED_RESEARCH_MAS));
    // Paper Eq. 2: novice bid = top competing bid + epsilon (code: fixed_with_eps).
    m.engine.bid_scheme = 'fixed_with_eps';
    m.evaluation.periodic_test_before_training = true; m.evaluation.periodic_test_every_n_tasks = 20;
    return Object.assign(m, over || {});
  };
  return [
    { key: 'released', adapter: 'research', label: 'Released code, exact', blurb: 'The authors\' own experiment exactly as released: global_configs/train_research.json, 5 agents, 40 training tasks for 2 epochs, all 19 test tasks after every 3 training tasks, rubric judge, threshold 0.5.',
      mas: RELEASED_RESEARCH_MAS, run: { num_epochs: 2, judge: true, judge_threshold: 0.5, test_workers: 3 }, trainIds: data.research.train.map((t) => t.id), testIds: data.research.test.map((t) => t.id), estCalls: 70000 },
    { key: 'releasedLight', adapter: 'research', label: 'Released code, lighter testing', blurb: 'Identical training. Only the measuring changes: 5 of the 19 test tasks, before training and after every 10 training tasks.',
      mas: Object.assign(JSON.parse(JSON.stringify(RELEASED_RESEARCH_MAS)), { evaluation: Object.assign({}, RELEASED_RESEARCH_MAS.evaluation, { periodic_test_before_training: true, periodic_test_every_n_tasks: 10 }) }),
      run: { num_epochs: 2, judge: true, judge_threshold: 0.5, test_workers: 3 }, trainIds: data.research.train.map((t) => t.id), testIds: data.research.test.slice(0, 5).map((t) => t.id), estCalls: 12000 },
    { key: 'paperMath', adapter: 'math', label: 'Paper\'s MATH setup', blurb: 'Paper Sec. 3.1: planner, executor and verifier with a 128-token budget, 20 problems per level fed easy to hard (100 tasks, 1 pass). Tested on 25 MATH-500 problems before training and after each level. Economics from the released config, bids by Eq. 2.',
      mas: mathMas(), run: { num_epochs: 1, judge: false, token_budget: 128, max_act_chars: 480, test_workers: 3 }, trainIds: pickTrain(data.math.train, 20), testIds: pickTests(data.math.test, 5), estCalls: 9000 },
    { key: 'quick', adapter: 'math', label: 'Quick look', blurb: 'Same engine and MATH setup, shrunk to see it work: 15 training problems (3 per level), 10 test problems before and after.',
      mas: mathMas({ evaluation: Object.assign({}, RELEASED_RESEARCH_MAS.evaluation, { periodic_test_before_training: true, periodic_test_every_n_tasks: 15 }) }), run: { num_epochs: 1, judge: false, token_budget: 128, max_act_chars: 480, test_workers: 3 }, trainIds: pickTrain(data.math.train, 3), testIds: pickTests(data.math.test, 2), estCalls: 900 },
  ];
}

return { makeRng, defaultConfig, configFromDict, Reward, RELEASED_RESEARCH_MAS, RELEASED_RESEARCH_RUN, GOOD_AGENT_BIRTH_PROMPT, BAD_AGENT_BIRTH_PROMPT, WAKEUP_PROMPT, RUBRIC_JUDGE_PROMPT, RESEARCH_ROLES, MATH_ROLES, ADAPTERS, Agent, Population, TextEnv, HayekMAS, Trainer, newRunState, buildPresets, makeAction, parseJudge, cleanTrainable, formatMutate, formatSpawn, lastBoxed, stripString, isEquiv, summarize, isFatal, sortedHistory };
});
