/* Economy of Minds, rebuilt. Engine v2.
 *
 * A re-implementation of the full EoM training and evaluation loop
 * (Qi et al., arXiv 2606.02859, Sec. 2, Alg. 1, Alg. 2) checked against the
 * authors' released code (github.com/zhentingqi/EoM, commit d272266),
 * using the research adapter ("researchworld") as the template:
 *   roles        planner, executor ("deriver" in the code), verifier, answer
 *   wake-up      hard rules from the code + a per-agent wake-up "prompt"
 *   auction      highest eligible bid wins, random ties              (Sec. 2.2)
 *   payment      winner pays its bid to the previous winner            (Eq. 1)
 *   bids         newcomer bids top competing bid + epsilon, then frozen (Eq. 2)
 *   reward       outcome reward to the final actor                    (Alg. 1)
 *   trials       replay the task with rollback when someone goes bankrupt (Alg. 1)
 *   rent, bankruptcy, bankruptcy births, periodic births, replenish, role recovery
 *   mutate       copy the richest with a small change           (exploitation)
 *   amend        repair a failed agent using its failure trace  (exploration)
 *   evaluation   frozen population, no money moves                     (Alg. 2)
 *
 * What is NOT the paper: there is no language model. An agent's "prompt" is a
 * small genome (when to wake up + a few behaviour numbers), the task is a toy
 * multi-step problem, and the prompt rewriter is a rule that edits the genome.
 * No DOM code here: the same file runs in Node tests and in the page.
 */
(function (root) {
  'use strict';

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  // ---------------- roles and situations ----------------
  const ROLES = ['planner', 'executor', 'verifier', 'answer'];
  const ROLE_LABEL = { planner: 'Planner', executor: 'Executor', verifier: 'Verifier', answer: 'Answer' };
  const ROLE_SHORT = { planner: 'P', executor: 'E', verifier: 'V', answer: 'A' };

  // What the shared workspace can look like when an agent decides whether to wake up.
  const SITUATIONS = [
    { id: 'start',        label: 'Empty workspace' },
    { id: 'afterPlan',    label: 'A plan was just written' },
    { id: 'execMore',     label: 'A step was just solved, more to go' },
    { id: 'execAll',      label: 'The last step was just solved, unchecked' },
    { id: 'flagged',      label: 'A verifier flagged an error' },
    { id: 'passedMore',   label: 'Checked OK, more steps to go' },
    { id: 'passedAll',    label: 'Checked OK, every step solved' },
    { id: 'afterAbstain', label: 'The answer agent said it is not ready' },
  ];
  const SIT = {}; SITUATIONS.forEach((s, i) => { SIT[s.id] = i; });

  // ---------------- the toy task ----------------
  // A problem of level 1..5 has k steps. Each executed step is right or wrong (hidden).
  const LEVELS = {
    parts: [1, 2, 2, 3, 3],
    base: [0.80, 0.72, 0.64, 0.56, 0.48],   // chance a plain step is right, before skill and plan
  };

  // ---------------- defaults ----------------
  // Money values follow the released research config (global_configs/train_research.json), x100:
  // initial_wealth 0.5, base_bid 0.1, rent 0.2 every 3 episodes, births 2 every 3 episodes,
  // min 2 / max 20 agents, p_a = p_b = 0.334, periodical_good_p 0.5, max_steps 10, max_trials 2.
  const DEFAULTS = {
    seed: 5,
    initialWealth: 50,
    baseBid: 10,
    epsilon: 1,               // Eq. 2 "small positive perturbation" (10% of the base bid, as in CloudCast)
    bidScheme: 'fixed_with_eps', // 'fixed' = the released research config
    rent: 20, rentInterval: 3,
    birthInterval: 3, birthsPerInterval: 2,
    minAgents: 2, maxAgents: 20,
    pA: 0.334, pB: 0.334, periodicGoodP: 0.5,
    maxSteps: 10, maxTrials: 2,
    terminalSteps: 1,          // last step: only the answer agent may act (terminal mode)
    reward: 100,               // a correct final answer scores 1.0, x100
    // 'released' = the released research config: score s = +1 (right) or -1 (wrong or no answer),
    //   answer agent gets 0.5*s, and s is split over every action on the path (path_reward_and_stepwise_reward,
    //   center_env_reward, terminal_output_bonus_scale 0.5, path_reward_scale 1.0, per action).
    // 'outcome'  = the paper's Eq. 1 / Alg. 1: only the final actor gets the reward, and only on success.
    // 'chainSplit' = success reward shared equally by the unique agents on the path.
    rewardScheme: 'released',
    answerBonusScale: 0.5, pathRewardScale: 1.0,
    sameRoleBlock: true,       // research adapter: never the same role twice in a row
    // ---- the prompt generator (toy stand-in for the LLM) ----
    mutationSigma: 0.05, wakeFlipP: 0.15, amendRandomP: 0.25,
    // ---- ablations (Table 2) ----
    auction: true, exploration: true, exploitation: true,
    founders: { planner: 1, executor: 2, verifier: 1, answer: 1 },
  };

  // ---------------- genomes ("prompts") ----------------
  const PARAMS = {
    planner:  { thorough: [0, 1] },
    executor: { skill: [-0.3, 0.35], selfCheck: [0, 0.9] },
    verifier: { detect: [0, 0.98], falseAlarm: [0, 0.5] },
    answer:   { patience: [0, 1], care: [0, 1] },
  };
  const DEFAULT_WAKE = {
    planner: ['start'],
    executor: ['afterPlan', 'flagged', 'passedMore', 'afterAbstain'],
    verifier: ['execMore', 'execAll'],
    answer: ['passedAll'],
  };
  function wakeMask(ids) { let m = 0; for (const id of ids) m |= 1 << SIT[id]; return m; }

  // ---------------- the economy ----------------
  class Economy {
    constructor(cfg) {
      this.cfg = Object.assign({}, DEFAULTS, cfg || {});
      this.cfg.founders = Object.assign({}, DEFAULTS.founders, (cfg && cfg.founders) || {});
      this.rand = mulberry32(this.cfg.seed);
      this.agents = []; this.graveyard = [];
      this.nextId = 1; this.episode = 0; this.house = 0;
      this.totalReward = 0; this.rentCollected = 0; this.bankruptCount = 0;
      this.birthsByRole = { planner: 0, executor: 0, verifier: 0, answer: 0 };
      this.births = { good: 0, bad: 0, replenish: 0, recovery: 0 };
      this.paths = [];   // auction-derived topology of each training episode
      this.sitStats = SITUATIONS.map(() => ({ wins: 0, payoffSum: 0, bidSum: 0, ema: null, emaBid: null }));
      this.templates = [];
      if (!this.cfg.skipFounders) {
        for (const role of ROLES) for (let i = 0; i < this.cfg.founders[role]; i++) {
          const a = this._add(this._make(role, this.founderGenome(role), 'founder', null));
          this.templates.push(a);
        }
      }
    }
    _u(r) { return r[0] + this.rand() * (r[1] - r[0]); }
    _g() { const u = 1 - this.rand(), v = this.rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
    _pick(a) { return a[Math.floor(this.rand() * a.length)]; }

    founderGenome(role) {
      const r = this.rand.bind(this);
      const g = { wake: wakeMask(DEFAULT_WAKE[role]) };
      // weak, imperfect starting "prompts": one extra wake situation often, sometimes one missing
      if (r() < 0.6) g.wake |= 1 << Math.floor(r() * SITUATIONS.length);
      if (r() < 0.2) { const ids = DEFAULT_WAKE[role]; g.wake &= ~(1 << SIT[ids[Math.floor(r() * ids.length)]]); }
      if (role === 'planner') g.thorough = this._u([0.2, 0.5]);
      if (role === 'executor') { g.skill = this._u([-0.2, 0]); g.selfCheck = this._u([0, 0.15]); }
      if (role === 'verifier') { g.detect = this._u([0.3, 0.6]); g.falseAlarm = this._u([0.1, 0.3]); }
      if (role === 'answer') { g.patience = this._u([0.5, 0.8]); g.care = this._u([0.3, 0.6]); }
      return g;
    }
    _clampGenome(role, g) {
      for (const [k, r] of Object.entries(PARAMS[role])) g[k] = clamp(g[k], r[0], r[1]);
      g.wake &= (1 << SITUATIONS.length) - 1;
      return g;
    }
    _make(role, genome, kind, parent) {
      const id = this.nextId++;
      return {
        id, name: ROLE_SHORT[role] + '-' + id, role, genome: this._clampGenome(role, Object.assign({}, genome)),
        bid: null, status: 'novice', wealth: this.cfg.initialWealth,
        born: this.episode, kind, parentId: parent ? parent.id : null, parentName: parent ? parent.name : null,
        generation: parent ? (parent.generation || 0) + 1 : 0,
        wins: 0, earned: 0, paid: 0, rewardIn: 0, rentPaid: 0, alive: true, diedAt: null,
        lastFailure: null, amendNote: null,
      };
    }
    _add(a) { this.agents.push(a); return a; }
    canAdd() { return this.agents.length < this.cfg.maxAgents; }
    byId(id) { return this.agents.find((a) => a.id === id) || this.graveyard.find((a) => a.id === id) || null; }
    richest() { return this.agents.reduce((b, a) => (!b || a.wealth > b.wealth ? a : b), null); }
    poorest() { return this.agents.reduce((b, a) => (!b || a.wealth < b.wealth ? a : b), null); }
    addVeteran(role, genome, bid, wealth, kind) {
      const a = this._make(role, Object.assign(this.founderGenome(role), genome || {}), kind || 'scripted', null);
      a.bid = bid; a.status = 'veteran'; if (wealth != null) a.wealth = wealth;
      return this._add(a);
    }

    // ---------------- the environment ----------------
    newState(task) {
      return { level: task.level, k: LEVELS.parts[task.level - 1], base: LEVELS.base[task.level - 1],
        planQ: 0, parts: [], flag: false, lastRole: null, done: false, success: false, submittedIncomplete: false, slip: false };
    }
    situation(st) {
      if (!st.lastRole) return SIT.start;
      if (st.lastRole === 'answer') return SIT.afterAbstain;
      if (st.flag) return SIT.flagged;
      const more = st.parts.length < st.k;
      if (st.lastRole === 'planner') return st.parts.length === 0 ? SIT.afterPlan : more ? SIT.passedMore : SIT.passedAll;
      if (st.lastRole === 'executor') return more ? SIT.execMore : SIT.execAll;
      return more ? SIT.passedMore : SIT.passedAll; // verifier passed
    }
    stepAccuracy(a, st) { return clamp(st.base + a.genome.skill + 0.12 * st.planQ, 0.02, 0.97); }
    // apply one agent's action; returns a note for the trace and the narrator
    act(a, st, rng) {
      const g = a.genome;
      const note = { role: a.role, id: a.id, sit: this.situation(st) };
      if (a.role === 'planner') {
        note.kind = st.planQ > 0 ? 'replan' : 'plan';
        st.planQ = Math.max(st.planQ, g.thorough);
        note.planQ = st.planQ; note.useful = note.kind === 'plan' && st.parts.length === 0;
      } else if (a.role === 'executor') {
        const acc = this.stepAccuracy(a, st);
        const draw = () => { let ok = rng() < acc; let selfFixed = false; if (!ok && rng() < g.selfCheck) { ok = rng() < acc; selfFixed = ok; } return { ok, selfFixed }; };
        if (st.flag) { const d = draw(); note.kind = 'fix'; note.index = st.parts.length - 1; st.parts[note.index] = d.ok; note.ok = d.ok; note.selfFixed = d.selfFixed; st.flag = false; note.useful = true; }
        else if (st.parts.length < st.k) { const d = draw(); note.kind = 'step'; note.index = st.parts.length; st.parts.push(d.ok); note.ok = d.ok; note.selfFixed = d.selfFixed; note.useful = true; }
        else { const d = draw(); note.kind = 'polish'; note.index = st.parts.length - 1; st.parts[note.index] = d.ok; note.ok = d.ok; note.useful = false; }
        note.acc = acc;
      } else if (a.role === 'verifier') {
        if (!st.parts.length) { note.kind = 'nothing'; note.useful = false; }
        else {
          const last = st.parts[st.parts.length - 1];
          note.kind = 'check'; note.partOk = last;
          st.flag = last ? rng() < g.falseAlarm : rng() < g.detect;
          note.flagged = st.flag; note.useful = true;
        }
      } else { // answer
        const complete = st.parts.length >= st.k;
        if (!complete && !st.forceSubmit && rng() < g.patience) { note.kind = 'abstain'; note.useful = true; }
        else {
          note.kind = 'submit'; st.done = true;
          const allOk = complete && st.parts.every(Boolean);
          st.slip = allOk && rng() < 0.15 * (1 - g.care);
          st.success = allOk && !st.slip; st.submittedIncomplete = !complete;
          note.success = st.success; note.complete = complete; note.slip = st.slip; note.useful = true;
        }
      }
      st.lastRole = a.role;
      return note;
    }

    // ---------------- wake-up (hard rules from the code + the agent's wake "prompt") ----------------
    wakes(a, st, step) {
      const c = this.cfg, s = this.situation(st);
      if (step >= c.maxSteps - c.terminalSteps) return a.role === 'answer';  // terminal mode bypasses wake-up
      if (c.sameRoleBlock && st.lastRole === a.role) return false;
      if (a.role === 'planner' && s === SIT.start) return true;              // planner self-starts
      if (a.role === 'answer') {
        if (st.lastRole !== 'executor' && st.lastRole !== 'verifier') return false;
        if (st.lastRole === 'executor') return true;                        // _FALLBACK_AFTER = {deriver}
      }
      return ((a.genome.wake >> s) & 1) === 1;
    }
    eligible(st, step, pop) { return (pop || this.agents).filter((a) => this.wakes(a, st, step)); }

    // ---------------- Eq. 2 ----------------
    setBids(active, events) {
      const c = this.cfg;
      if (c.bidScheme === 'fixed_with_eps') {
        const vet = active.filter((a) => a.status === 'veteran' && a.bid != null).map((a) => a.bid);
        const high = vet.length ? Math.max(...vet) : c.baseBid;
        for (const a of active) if (a.status === 'novice') { a.bid = high + c.epsilon; a.status = 'veteran'; events && events.push({ type: 'novice', id: a.id, bid: a.bid, high }); }
      } else {
        for (const a of active) {
          if (a.status === 'novice') { a.bid = c.baseBid + c.epsilon; a.status = 'veteran'; events && events.push({ type: 'novice', id: a.id, bid: a.bid, high: c.baseBid }); }
          else a.bid = c.baseBid;
        }
      }
    }
    pickWinner(active, rng) {
      if (!this.cfg.auction) return active[Math.floor(rng() * active.length)];
      const withBid = active.filter((a) => a.bid != null);
      const pool = withBid.length ? withBid : active;
      const max = Math.max(...pool.map((a) => (a.bid == null ? -Infinity : a.bid)));
      const top = pool.filter((a) => a.bid === max || (max === -Infinity));
      return top[Math.floor(rng() * top.length)];
    }

    // ---------------- PLANNING (Alg. 1 lines 19-30, Alg. 2 lines 7-18) ----------------
    // training: bids are set and money moves. Otherwise (Alg. 2) nothing moves.
    runPlanning(task, opts) {
      const training = opts.training, rng = opts.rng || this.rand, events = opts.events || [];
      const pop = opts.pop || this.agents;
      const st = this.newState(task);
      let prev = null; const path = []; const notes = []; const wins = [];
      for (let step = 0; step < this.cfg.maxSteps; step++) {
        if (step >= this.cfg.maxSteps - this.cfg.terminalSteps) st.forceSubmit = true;
        const active = this.eligible(st, step, pop);
        const sit = this.situation(st);
        if (!active.length) { events.push({ type: 'no-eligible', step, sit }); break; }
        if (training) this.setBids(active, events);
        const w = this.pickWinner(active, rng);
        events.push({ type: 'auction', step, sit, winner: w.id, byAuction: this.cfg.auction, terminal: !!st.forceSubmit,
          bids: active.map((a) => ({ id: a.id, bid: a.bid })) });
        if (training) {
          const pay = w.bid;
          w.wealth -= pay; w.paid += pay;
          if (prev) { prev.wealth += pay; prev.earned += pay; events.push({ type: 'pay', from: w.id, to: prev.id, amount: pay, step }); wins[wins.length - 1].next = pay; }
          else { this.house += pay; events.push({ type: 'pay', from: w.id, to: 'house', amount: pay, step }); }
          w.wins += 1;
        }
        const note = this.act(w, st, rng);
        note.step = step; notes.push(note); path.push(w.role);
        wins.push({ id: w.id, sit, bid: w.bid, next: 0 });
        events.push(Object.assign({ type: 'act' }, note));
        prev = w;
        if (st.done) break;
      }
      return { st, path, notes, wins, lastActor: prev, events };
    }

    // ---------------- one training episode (Alg. 1 lines 2-18) ----------------
    runEpisode(task, opts) {
      opts = opts || {};
      const c = this.cfg;
      this.episode += 1;
      const events = [];
      const allDead = [];
      let plan = null, trial = 0, accepted = false;
      for (trial = 1; trial <= c.maxTrials; trial++) {
        // SNAPSHOT of wealth, refreshed before every replay (code: pre_episode_snapshot)
        const snap = new Map(this.agents.map((a) => [a.id, a.wealth]));
        const rewardBefore = this.totalReward;
        events.push({ type: 'trial', trial, task });
        plan = this.runPlanning(task, { training: true, events });
        // rewards
        const success = plan.st.success;
        if (c.rewardScheme === 'released') {
          // centered score: +1 right, -1 wrong or missing (missing_terminal_score 0 -> -1)
          const sig = (success ? 1 : -1) * c.reward;
          const submitter = plan.notes.length && plan.notes[plan.notes.length - 1].kind === 'submit' ? plan.lastActor : null;
          if (submitter) { const b = c.answerBonusScale * sig; submitter.wealth += b; submitter.rewardIn += b; events.push({ type: 'reward', to: submitter.id, amount: b, why: 'answer' }); }
          const n = plan.wins.length;
          if (n) {
            const per = (c.pathRewardScale * sig) / n;
            const tally = new Map();
            for (const w of plan.wins) { const a = this.byId(w.id); a.wealth += per; a.rewardIn += per; tally.set(w.id, (tally.get(w.id) || 0) + per); w.reward = (w.reward || 0) + per; }
            for (const [id, amt] of tally) events.push({ type: 'reward', to: id, amount: amt, why: 'path' });
          }
          if (submitter) plan.wins[plan.wins.length - 1].reward += c.answerBonusScale * sig;
          if (success) this.totalReward += c.reward * (c.answerBonusScale + c.pathRewardScale);
        } else if (success && c.reward > 0) {
          this.totalReward += c.reward;
          if (c.rewardScheme === 'chainSplit') {
            const ids = [...new Set(plan.wins.map((w) => w.id))];
            const share = c.reward / ids.length;
            for (const id of ids) { const a = this.byId(id); a.wealth += share; a.rewardIn += share; events.push({ type: 'reward', to: id, amount: share }); }
          } else {
            const a = plan.lastActor; a.wealth += c.reward; a.rewardIn += c.reward;
            events.push({ type: 'reward', to: a.id, amount: c.reward });
          }
          plan.wins[plan.wins.length - 1].reward = c.reward;
        }
        this._recordFailures(plan, task);
        const dead = this._removeBankrupt(events);
        if (!dead.length) { accepted = true; break; }
        allDead.push(...dead);
        this._ensureRoles(dead, events);
        // ROLLBACK: survivors get their wealth back (bids and status kept), then the task is replayed
        for (const a of this.agents) if (snap.has(a.id)) a.wealth = snap.get(a.id);
        this.totalReward = rewardBefore;
        events.push({ type: 'rollback', trial, last: trial === c.maxTrials });
      }
      // Theorem 1 bookkeeping: resale-adjusted payoff of each win, by situation
      for (const w of plan.wins) {
        const s = this.sitStats[w.sit]; const G = (w.next || 0) + (w.reward || 0);
        s.wins++; s.payoffSum += G; s.bidSum += w.bid || 0;
        s.ema = s.ema == null ? G : s.ema * 0.97 + G * 0.03;
        s.emaBid = s.emaBid == null ? (w.bid || 0) : s.emaBid * 0.97 + (w.bid || 0) * 0.03;
      }
      // rent
      if (c.rent > 0 && c.rentInterval > 0 && this.episode % c.rentInterval === 0) {
        for (const a of this.agents) { a.wealth -= c.rent; a.rentPaid += c.rent; }
        this.rentCollected += c.rent * this.agents.length;
        events.push({ type: 'rent', amount: c.rent, n: this.agents.length });
        const dead = this._removeBankrupt(events); allDead.push(...dead); this._ensureRoles(dead, events);
      }
      this._adapt(allDead, events);
      const path = plan.path.slice();
      this.paths.push({ episode: this.episode, level: task.level, path, success: plan.st.success });
      if (this.paths.length > 4000) this.paths.shift();
      return { episode: this.episode, task, success: plan.st.success, path, events, trials: Math.min(trial, c.maxTrials), accepted, plan };
    }

    // failure context for exploration births (code: _record_recent_failures)
    _recordFailures(plan, task) {
      if (plan.st.success) return;
      const byAgent = new Map();
      plan.notes.forEach((n, i) => {
        const a = this.byId(n.id); if (!a) return;
        let f = null;
        if (n.role === 'executor' && (n.kind === 'step' || n.kind === 'fix') && !n.ok) f = { type: 'wrongStep' };
        else if (n.role === 'executor' && n.kind === 'polish') f = { type: 'wasted', sit: n.sit };
        else if (n.role === 'verifier' && n.kind === 'check' && !n.partOk && !n.flagged) f = { type: 'missedError' };
        else if (n.role === 'verifier' && n.kind === 'check' && n.partOk && n.flagged) f = { type: 'falseAlarm' };
        else if (n.role === 'verifier' && n.kind === 'nothing') f = { type: 'wasted', sit: n.sit };
        else if (n.role === 'planner' && n.kind === 'replan') f = { type: 'wasted', sit: n.sit };
        else if (n.role === 'planner' && n.planQ < 0.5) f = { type: 'weakPlan' };
        else if (n.role === 'answer' && n.kind === 'submit' && !n.complete) f = { type: 'answeredEarly', sit: n.sit };
        else if (n.role === 'answer' && n.kind === 'submit' && n.slip) f = { type: 'answerSlip' };
        if (f && !byAgent.has(n.id)) byAgent.set(n.id, f);
      });
      for (const [id, f] of byAgent) { const a = this.byId(id); f.task = task; f.episode = this.episode; a.lastFailure = f; }
    }

    _removeBankrupt(events) {
      const dead = this.agents.filter((a) => a.wealth < 0);   // code: check_bankruptcy -> wealth < 0
      for (const a of dead) { a.alive = false; a.diedAt = this.episode; this.graveyard.push(a); events.push({ type: 'bankrupt', id: a.id, wealth: a.wealth }); }
      if (dead.length) {
        this.agents = this.agents.filter((a) => a.wealth >= 0);
        this.bankruptCount += dead.length;
        if (this.graveyard.length > 600) this.graveyard.splice(0, this.graveyard.length - 600);
      }
      return dead;
    }
    _ensureRoles(dead, events) {   // code: _ensure_necessary_roles_exist
      for (const role of ROLES) {
        if (this.cfg.founders[role] === 0) continue;
        if (this.agents.some((a) => a.role === role)) continue;
        const pool = dead.filter((a) => a.role === role);
        const src = pool.length ? this._pick(pool) : this.templates.find((t) => t.role === role);
        if (src) this._birthBad(src, events, 'role-recovery', true);
      }
    }

    // ---------------- the prompt generator G (toy stand-in for the LLM) ----------------
    // MUTATE: keep what works, add a small variation (good birth)
    _birthGood(parent, events, why) {
      if (!parent || !this.canAdd()) return null;
      const c = this.cfg, g = Object.assign({}, parent.genome);
      for (const k of Object.keys(PARAMS[parent.role])) g[k] += c.mutationSigma * this._g();
      let note = 'small change to its behaviour';
      if (this.rand() < c.wakeFlipP) { const s = Math.floor(this.rand() * SITUATIONS.length); g.wake ^= 1 << s; note = ((g.wake >> s) & 1 ? 'now also wakes when: ' : 'no longer wakes when: ') + SITUATIONS[s].label.toLowerCase(); }
      const child = this._add(this._make(parent.role, g, 'good', parent));
      child.amendNote = note;
      this.births.good++; this.birthsByRole[child.role]++;
      events.push({ type: 'birth', id: child.id, kind: 'good', parent: parent.id, why, note });
      return child;
    }
    // AMEND: read the failure trace and fix the weakness it shows (bad birth)
    _birthBad(source, events, why, force) {
      if (!source || (!force && !this.canAdd())) return null;
      const c = this.cfg, role = source.role, g = Object.assign({}, source.genome);
      const f = source.lastFailure;
      let note;
      const up = (k, lo, hi) => { g[k] += lo + this.rand() * (hi - lo); };
      if (this.rand() < c.amendRandomP) { Object.assign(g, this.founderGenome(role)); for (const k of Object.keys(PARAMS[role])) g[k] = PARAMS[role][k][0] + this.rand() * (PARAMS[role][k][1] - PARAMS[role][k][0]); note = 'tries a completely different approach'; }
      else if (!f) {   // never acted: try waking up somewhere new
        const s = Math.floor(this.rand() * SITUATIONS.length); g.wake |= 1 << s; note = 'never got a turn, so it now also wakes when: ' + SITUATIONS[s].label.toLowerCase();
      } else if (f.type === 'wrongStep') { up('skill', 0.02, 0.12); up('selfCheck', 0.05, 0.2); note = 'made a wrong step, so it now works more carefully and re-checks its own steps'; }
      else if (f.type === 'missedError') { up('detect', 0.05, 0.2); note = 'missed an error, so it now checks harder'; }
      else if (f.type === 'falseAlarm') { g.falseAlarm -= 0.03 + this.rand() * 0.07; note = 'flagged correct work, so it is now less trigger-happy'; }
      else if (f.type === 'weakPlan') { up('thorough', 0.05, 0.2); note = 'wrote a thin plan, so it now plans more thoroughly'; }
      else if (f.type === 'answeredEarly') { up('patience', 0.1, 0.3); if (f.sit != null && f.sit !== SIT.execMore) g.wake &= ~(1 << f.sit); note = 'answered before the work was done, so it now waits'; }
      else if (f.type === 'answerSlip') { up('care', 0.05, 0.2); note = 'slipped when writing the answer, so it now copies results more carefully'; }
      else if (f.type === 'wasted') { if (f.sit != null) g.wake &= ~(1 << f.sit); note = 'acted when there was nothing useful to do, so it no longer wakes when: ' + SITUATIONS[f.sit].label.toLowerCase(); }
      else note = 'small repair';
      const child = this._add(this._make(role, g, 'bad', source));
      child.amendNote = note;
      if (why === 'role-recovery') this.births.recovery++; else this.births.bad++;
      this.birthsByRole[role]++;
      events.push({ type: 'birth', id: child.id, kind: 'bad', parent: source.id, why, note, failure: f ? f.type : null });
      return child;
    }

    // ADAPTATION (Alg. 1 lines 31-46, code _resolve_bankruptcy_births / _periodic_births)
    _adapt(allDead, events) {
      const c = this.cfg;
      for (const b of allDead) {
        if (!this.canAdd()) break;
        const u = this.rand();
        if (u < c.pA) { if (c.exploitation) this._birthGood(this.richest(), events, 'bankruptcy'); }
        else if (u < c.pA + c.pB) { if (c.exploration) this._birthBad(b, events, 'bankruptcy'); }
      }
      if (c.birthInterval > 0 && this.episode % c.birthInterval === 0) {
        for (let i = 0; i < c.birthsPerInterval && this.canAdd(); i++) {
          if (this.rand() < c.periodicGoodP) { if (c.exploitation) this._birthGood(this.richest(), events, 'periodic'); }
          else if (c.exploration) this._birthBad(this.poorest(), events, 'periodic');
        }
      }
      let guard = 0;
      while (this.agents.length < c.minAgents && guard++ < 40) {
        const src = this.richest() || this.templates[0];
        if (c.exploitation && src) { const ch = this._birthGood(src, events, 'replenish'); if (ch) { this.births.good--; this.births.replenish++; } }
        else { const t = this._pick(this.templates); const a = this._add(this._make(t.role, this.founderGenome(t.role), 'template', null)); this.births.replenish++; this.birthsByRole[a.role]++; events.push({ type: 'birth', id: a.id, kind: 'template', parent: null, why: 'replenish' }); }
      }
    }

    // ---------------- EVALUATION (Alg. 2) ----------------
    // Frozen copy, no payments, no rent, no births. Each test task uses its own
    // seeded randomness, so every checkpoint faces the same dice (common random numbers).
    evaluate(testSet) {
      const frozen = this.agents.map((a) => Object.assign({}, a, { genome: Object.assign({}, a.genome) }));
      const byLevel = [0, 0, 0, 0, 0], nByLevel = [0, 0, 0, 0, 0];
      let ok = 0; const paths = [];
      for (const t of testSet) {
        const r = this.runPlanning(t, { training: false, rng: mulberry32(t.seed), pop: frozen, events: [] });
        if (r.st.success) { ok++; byLevel[t.level - 1]++; }
        nByLevel[t.level - 1]++;
        paths.push(r.path);
      }
      return { acc: ok / testSet.length, byLevel: byLevel.map((v, i) => (nByLevel[i] ? v / nByLevel[i] : 0)), paths };
    }

    // what the frozen team would most likely do: the top bidder per situation
    topBidderAt(sitIndex, roleFilter) {
      let best = null;
      for (const a of this.agents) {
        if (roleFilter && a.role !== roleFilter) continue;
        if (((a.genome.wake >> sitIndex) & 1) !== 1) continue;
        if (a.bid == null) continue;
        if (!best || a.bid > best.bid) best = a;
      }
      return best;
    }
    totalWealth() { return this.agents.reduce((t, a) => t + a.wealth, 0); }

    // plain-language reading of an agent's "prompt"
    describe(a) {
      const g = a.genome, s = [];
      const wakes = SITUATIONS.filter((x, i) => (g.wake >> i) & 1).map((x) => x.label.toLowerCase());
      if (a.role === 'planner') s.push('Plans with thoroughness ' + g.thorough.toFixed(2) + '.');
      if (a.role === 'executor') s.push('Solves a step with skill ' + (g.skill >= 0 ? '+' : '') + g.skill.toFixed(2) + ' and re-checks its own work ' + Math.round(g.selfCheck * 100) + '% of the time.');
      if (a.role === 'verifier') s.push('Catches ' + Math.round(g.detect * 100) + '% of errors, wrongly flags ' + Math.round(g.falseAlarm * 100) + '% of correct steps.');
      if (a.role === 'answer') s.push('Waits if the work is unfinished ' + Math.round(g.patience * 100) + '% of the time, copies results with care ' + g.care.toFixed(2) + '.');
      return { text: s.join(' '), wakes };
    }
  }

  // ---------------- task streams ----------------
  function curriculum(seed, perLevel, order) {
    const out = []; const levels = order === 'hard' ? [5, 4, 3, 2, 1] : order === 'mixed' ? null : [1, 2, 3, 4, 5];
    let s = seed * 7919;
    if (levels) for (const L of levels) for (let i = 0; i < perLevel; i++) out.push({ level: L, seed: (s += 101) >>> 0 });
    else { const r = mulberry32(seed); for (let i = 0; i < perLevel * 5; i++) out.push({ level: 1 + Math.floor(r() * 5), seed: (s += 101) >>> 0 }); }
    return out;
  }
  function testSet(perLevel) {
    const out = []; let s = 424242;
    for (let L = 1; L <= 5; L++) for (let i = 0; i < perLevel; i++) out.push({ level: L, seed: (s += 977) >>> 0 });
    return out;
  }

  // One full training run, like one of the paper's runs: train on the stream, test at checkpoints.
  function trainRun(cfg, o) {
    o = Object.assign({ perLevel: 20, order: 'easy', every: 10, testPerLevel: 40 }, o || {});
    const e = new Economy(cfg);
    const tasks = curriculum(e.cfg.seed, o.perLevel, o.order);
    const tests = testSet(o.testPerLevel);
    const checkpoints = [{ episode: 0, ...e.evaluate(tests) }];
    tasks.forEach((t, i) => {
      e.runEpisode(t);
      if ((i + 1) % o.every === 0 || i === tasks.length - 1) checkpoints.push({ episode: i + 1, ...e.evaluate(tests) });
    });
    const accs = checkpoints.map((c) => c.acc);
    return { economy: e, checkpoints, initial: accs[0], final: accs[accs.length - 1], best: Math.max(...accs.slice(1)),
      meanAfter: accs.slice(1).reduce((a, b) => a + b, 0) / (accs.length - 1) };
  }

  // Your Learn Article, Figure 1, through the same payment code (Eq. 1).
  function articleLedger(path) {
    const e = new Economy({ skipFounders: true, reward: 10, rent: 0, birthInterval: 0, minAgents: 0, maxSteps: 3, terminalSteps: 0, sameRoleBlock: false });
    const A = e.addVeteran('planner', {}, 2, 10, 'article');
    const B = e.addVeteran('executor', {}, 4, 10, 'article');
    const C = e.addVeteran('answer', {}, 7, 10, 'article');
    A.name = 'A'; B.name = 'B'; C.name = 'C';
    const events = []; let prev = null;
    for (const w of [A, B, C]) {
      events.push({ type: 'auction', winner: w.id, bids: [{ id: w.id, bid: w.bid }], byAuction: true });
      w.wealth -= w.bid;
      if (prev) { prev.wealth += w.bid; events.push({ type: 'pay', from: w.id, to: prev.id, amount: w.bid }); }
      else { e.house += w.bid; events.push({ type: 'pay', from: w.id, to: 'house', amount: w.bid }); }
      const ok = path === 'bug' && w === C ? false : true;
      events.push({ type: 'act', id: w.id, ok, role: w.role });
      prev = w;
    }
    if (path !== 'bug') { C.wealth += 10; events.push({ type: 'reward', to: C.id, amount: 10 }); }
    return { balances: [A.wealth, B.wealth, C.wealth], house: e.house, events, economy: e };
  }

  const api = { Economy, DEFAULTS, ROLES, ROLE_LABEL, ROLE_SHORT, SITUATIONS, SIT, LEVELS, PARAMS, mulberry32, curriculum, testSet, trainRun, articleLedger, wakeMask };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EoM = api;
})(typeof window !== 'undefined' ? window : globalThis);
