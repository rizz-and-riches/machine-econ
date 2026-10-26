/* Economy of Minds, rebuilt for the browser.
 * A re-implementation of the EoM engine (Qi et al., arXiv 2606.02859):
 *   Eq. 1  bucket-brigade payment
 *   Eq. 2  novice bid rule ("fixed_with_eps" in the released code)
 *   Alg. 1 training loop: auction, payments, outcome reward, bankruptcy,
 *          rent, bankruptcy births, periodic births, replenish.
 * The LLM agents are replaced by a toy: each agent has a role and a skill q
 * (the chance its step succeeds). Everything economic follows the paper and
 * the released code (github.com/zhentingqi/EoM, commit d272266).
 * No DOM code in here, so the same file runs in Node tests and in the page.
 */
(function (root) {
  'use strict';

  // ---------- seeded randomness (same seed -> same run) ----------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const ROLES = ['diagnose', 'edit', 'check'];
  const ROLE_LABEL = { diagnose: 'Diagnose', edit: 'Edit', check: 'Check' };
  const ROLE_SHORT = { diagnose: 'D', edit: 'E', check: 'C' };

  // CloudCast train config values (hayekmas/adapters/cloudcast/configs/train.json),
  // money scaled x100 so the numbers are readable: 0.7 -> 70, 0.05 -> 5, ...
  const DEFAULTS = {
    seed: 7,
    initialWealth: 70,     // initial_wealth 0.7
    baseBid: 5,            // base_bid 0.05
    epsilon: 0.5,          // novice_bid_epsilon 0.005
    rent: 2,               // rent 0.02
    // Alg. 1 charges rent every K_r tasks and births every K_b tasks. CloudCast
    // charges per episode, and a CloudCast episode has up to 22 auctions. Our toy
    // task has 3, so 7 toy tasks ~ 1 CloudCast episode (21 auctions).
    rentInterval: 7,       // rent_interval 1 CloudCast episode ~ 7 toy tasks
    minAgents: 6,          // min_num_agents 6
    maxAgents: 20,         // max_num_agents 20
    birthInterval: 21,     // birth_interval 3 CloudCast episodes ~ 21 toy tasks
    birthsPerInterval: 1,  // num_births_per_interval 1
    pA: 0.4,               // p_a: bankruptcy -> good birth (exploitation)
    pB: 0.4,               // p_b: bankruptcy -> bad birth (exploration)
    periodicGoodP: 0.6,    // periodical_good_p
    bidScheme: 'fixed_with_eps', // or 'fixed' (released research config)
    rewardScheme: 'outcome',     // 'outcome' = Eq.1/Alg.1, 'chainSplit' = simplified released-code split
    // ---- toy choices (ours, not the paper's) ----
    reward: 40,            // outcome reward when the whole chain succeeds
    foundersPerRole: 2,    // 6 founders = min_num_agents
    founderQ: [0.3, 0.6],  // "initialized with weak agents"
    exploreQ: [0.1, 0.95], // amended agent: fresh random skill (no LLM to learn from failure)
    mutationSigma: 0.08,   // good birth: parent skill + noise
    // ---- ablations (paper Table 2) ----
    auction: true,         // false: a random eligible agent acts (our assumption)
    exploration: true,     // false: no bad (amend) births
    exploitation: true,    // false: no good (mutate-richest) births
  };

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  class Economy {
    constructor(cfg) {
      this.cfg = Object.assign({}, DEFAULTS, cfg || {});
      this.rand = mulberry32(this.cfg.seed);
      this.agents = [];        // living agents
      this.graveyard = [];     // removed agents (for the inspector)
      this.nextId = 1;
      this.episode = 0;        // episode_count, incremented at the start of each episode
      this.house = 0;          // where the first actor's bid goes
      this.totalReward = 0;
      this.rentCollected = 0;
      this.bankruptCount = 0;
      this.log = [];           // per-episode summaries
      if (!this.cfg.skipFounders) {
        for (const role of ROLES) {
          for (let i = 0; i < this.cfg.foundersPerRole; i++) {
            this._add(this._make(role, this._uniform(this.cfg.founderQ), 'founder', null));
          }
        }
      }
    }

    // ---------- small helpers ----------
    _uniform(range) { return range[0] + this.rand() * (range[1] - range[0]); }
    _gauss() {
      const u = 1 - this.rand(), v = this.rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
    _pick(arr) { return arr[Math.floor(this.rand() * arr.length)]; }

    _make(role, q, kind, parent) {
      const id = this.nextId++;
      return {
        id, name: ROLE_SHORT[role] + '-' + id, role,
        q: clamp(q, 0.02, 0.98),
        bid: null, status: 'novice',
        wealth: this.cfg.initialWealth,
        born: this.episode, kind,
        parentId: parent ? parent.id : null,
        parentName: parent ? parent.name : null,
        wins: 0, successes: 0, earned: 0, paid: 0, rewardIn: 0, rentPaid: 0,
        alive: true, diedAt: null,
      };
    }
    _add(agent) { this.agents.push(agent); return agent; }
    canAdd() { return this.agents.length < this.cfg.maxAgents; }
    byId(id) { return this.agents.find(a => a.id === id) || this.graveyard.find(a => a.id === id) || null; }
    richest() { return this.agents.reduce((b, a) => (!b || a.wealth > b.wealth ? a : b), null); }
    poorest() { return this.agents.reduce((b, a) => (!b || a.wealth < b.wealth ? a : b), null); }

    // Agent with a hand-set bid (article ledger, overbidder demo).
    addVeteran(role, q, bid, wealth, kind) {
      const a = this._make(role, q, kind || 'scripted', null);
      a.bid = bid; a.status = 'veteran';
      if (wealth != null) a.wealth = wealth;
      return this._add(a);
    }

    // Lemma 2 demo: an agent whose bid is above the value it creates.
    addOverbidder(role) {
      role = role || 'diagnose';
      const same = this.agents.filter(a => a.role === role && a.bid != null);
      const top = same.length ? Math.max(...same.map(a => a.bid)) : this.cfg.baseBid;
      return this.addVeteran(role, 0.35, top + 15, null, 'overbidder');
    }

    // ---------- the trigger: who wakes up at this stage ----------
    eligible(stage) { return this.agents.filter(a => a.role === ROLES[stage]); }

    // ---------- Eq. 2 novice bid rule (code: BID INITIALIZATION) ----------
    setBids(active, events) {
      const c = this.cfg;
      if (c.bidScheme === 'fixed_with_eps') {
        const vet = active.filter(a => a.status === 'veteran' && a.bid != null).map(a => a.bid);
        const high = vet.length ? Math.max(...vet) : c.baseBid;
        for (const a of active) {
          if (a.status === 'novice') {
            a.bid = high + c.epsilon;
            a.status = 'veteran';
            events.push({ type: 'novice', id: a.id, bid: a.bid, high });
          }
        }
      } else if (c.bidScheme === 'fixed') {
        for (const a of active) {
          if (a.status === 'novice') {
            a.bid = c.baseBid + c.epsilon;
            a.status = 'veteran';
            events.push({ type: 'novice', id: a.id, bid: a.bid, high: c.baseBid });
          } else {
            a.bid = c.baseBid; // every veteran settles to the same bid
          }
        }
      } else {
        throw new Error('Unknown bidScheme: ' + c.bidScheme);
      }
    }

    // ---------- the auction ----------
    pickWinner(active) {
      if (!this.cfg.auction) return { winner: this._pick(active), tied: active.length };
      const max = Math.max(...active.map(a => (a.bid == null ? -Infinity : a.bid)));
      const top = active.filter(a => a.bid === max);
      return { winner: this._pick(top), tied: top.length };
    }

    // ---------- one episode (Alg. 1, PLANNING + adaptation) ----------
    // opts.forced: array of booleans per stage to force step outcomes (tests, ledger demo)
    // opts.adapt: false skips rent/bankruptcy/births (ledger demo)
    runEpisode(opts) {
      opts = opts || {};
      const c = this.cfg;
      this.episode += 1;
      const events = [];
      const before = this.agents.map(a => ({ id: a.id, wealth: a.wealth }));
      let stage = 0, prev = null, outcome = 'fail';
      const chain = [];

      while (stage < ROLES.length) {
        const active = this.eligible(stage);
        if (!active.length) { events.push({ type: 'no-eligible', stage }); break; }
        this.setBids(active, events);
        const { winner, tied } = this.pickWinner(active);
        events.push({
          type: 'auction', stage, winner: winner.id, tied, byAuction: c.auction,
          bids: active.map(a => ({ id: a.id, bid: a.bid })),
        });

        // Eq. 1: winner pays its bid to the previous winner (or the house)
        const pay = winner.bid;
        winner.wealth -= pay; winner.paid += pay;
        if (prev) {
          prev.wealth += pay; prev.earned += pay;
          events.push({ type: 'pay', from: winner.id, to: prev.id, amount: pay, stage });
        } else {
          this.house += pay;
          events.push({ type: 'pay', from: winner.id, to: 'house', amount: pay, stage });
        }

        winner.wins += 1;
        chain.push(winner);
        const success = opts.forced ? !!opts.forced[stage] : this.rand() < winner.q;
        events.push({ type: 'act', id: winner.id, stage, success });
        if (!success) break;          // visible failure: the chain breaks here
        winner.successes += 1;
        prev = winner;
        stage += 1;
      }
      if (stage === ROLES.length) outcome = 'success';

      // outcome reward (Alg. 1 line 5: to the final actor)
      if (outcome === 'success' && c.reward > 0) {
        this.totalReward += c.reward;
        if (c.rewardScheme === 'chainSplit') {
          const uniq = [...new Map(chain.map(a => [a.id, a])).values()];
          const share = c.reward / uniq.length;
          for (const a of uniq) {
            a.wealth += share; a.rewardIn += share;
            events.push({ type: 'reward', to: a.id, amount: share });
          }
        } else {
          const last = chain[chain.length - 1];
          last.wealth += c.reward; last.rewardIn += c.reward;
          events.push({ type: 'reward', to: last.id, amount: c.reward });
        }
      }

      if (opts.adapt !== false) this._adapt(events);

      const rec = {
        episode: this.episode, outcome, events, before,
        chain: chain.map(a => a.id),
        testSuccess: this.expectedSuccess(),
        population: this.agents.length,
        prices: this.prices(),
      };
      this.log.push({ episode: rec.episode, outcome, testSuccess: rec.testSuccess, population: rec.population, prices: rec.prices });
      if (this.log.length > 5000) this.log.shift();
      return rec;
    }

    // ---------- bankruptcy, rent, births (Alg. 1 lines 6-17, code _train_forward) ----------
    _removeBankrupt(events) {
      const dead = this.agents.filter(a => a.wealth < 0); // code: check_bankruptcy -> wealth < 0
      for (const a of dead) {
        a.alive = false; a.diedAt = this.episode;
        this.graveyard.push(a);
        events.push({ type: 'bankrupt', id: a.id, wealth: a.wealth });
      }
      if (dead.length) {
        this.agents = this.agents.filter(a => a.wealth >= 0);
        this.bankruptCount += dead.length;
        if (this.graveyard.length > 400) this.graveyard.splice(0, this.graveyard.length - 400);
      }
      return dead;
    }

    // code: _ensure_necessary_roles_exist -> amend a bankrupt agent of the missing role
    _ensureRoles(dead, events) {
      for (const role of ROLES) {
        if (this.agents.some(a => a.role === role)) continue;
        const src = this._pick(dead.filter(a => a.role === role));
        this._birthBad(src, events, 'role-recovery');
      }
    }

    _birthGood(parent, events, why) {
      if (!parent || !this.canAdd()) return null;
      const child = this._make(parent.role, parent.q + this.cfg.mutationSigma * this._gauss(), 'good', parent);
      this._add(child);
      events.push({ type: 'birth', id: child.id, kind: 'good', parent: parent.id, why });
      return child;
    }

    _birthBad(source, events, why) {
      if (!source || (!this.canAdd() && why !== 'role-recovery')) return null;
      const poor = this.poorest();
      const sourceWasPoorest = !!poor && poor.id === source.id;
      const child = this._make(source.role, this._uniform(this.cfg.exploreQ), 'bad', source);
      this._add(child);
      events.push({ type: 'birth', id: child.id, kind: 'bad', parent: source.id, why, sourceWasPoorest });
      return child;
    }

    _adapt(events) {
      const c = this.cfg;
      const allDead = [];

      // bankruptcy after the episode
      const dead1 = this._removeBankrupt(events);
      allDead.push(...dead1);
      this._ensureRoles(dead1, events);

      // rent
      if (c.rent > 0 && c.rentInterval > 0 && this.episode % c.rentInterval === 0) {
        for (const a of this.agents) { a.wealth -= c.rent; a.rentPaid += c.rent; }
        this.rentCollected += c.rent * this.agents.length;
        events.push({ type: 'rent', amount: c.rent, n: this.agents.length });
        const dead2 = this._removeBankrupt(events);
        allDead.push(...dead2);
        this._ensureRoles(dead2, events);
      }

      // births caused by bankruptcies (code: _resolve_bankruptcy_births)
      for (const b of allDead) {
        if (!this.canAdd()) break;
        const u = this.rand();
        if (u < c.pA) { if (c.exploitation) this._birthGood(this.richest(), events, 'bankruptcy'); }
        else if (u < c.pA + c.pB) { if (c.exploration) this._birthBad(b, events, 'bankruptcy'); }
      }

      // periodic births (code: _periodic_births)
      if (c.birthInterval > 0 && this.episode % c.birthInterval === 0) {
        for (let i = 0; i < c.birthsPerInterval && this.canAdd(); i++) {
          if (this.rand() < c.periodicGoodP) { if (c.exploitation) this._birthGood(this.richest(), events, 'periodic'); }
          else if (c.exploration) this._birthBad(this.poorest(), events, 'periodic');
        }
      }

      // replenish to the minimum (code: good birth from the richest;
      // with exploitation removed we fall back to a fresh founder-style agent)
      let guard = 0;
      while (this.agents.length < c.minAgents && guard++ < 50) {
        if (c.exploitation) this._birthGood(this.richest(), events, 'replenish');
        else {
          const role = ROLES[this.agents.length % ROLES.length];
          const a = this._add(this._make(role, this._uniform(c.founderQ), 'template', null));
          events.push({ type: 'birth', id: a.id, kind: 'template', parent: null, why: 'replenish' });
        }
      }
    }

    // ---------- measuring capability (Alg. 2: frozen evaluation) ----------
    // Frozen population, no payments. With the auction on, each stage goes to the
    // top bidder(s); success chance = product of their skills. Exact, so no noise.
    winnersFor(stage) {
      const active = this.eligible(stage);
      if (!active.length) return [];
      if (!this.cfg.auction) return active;
      const withBid = active.filter(a => a.bid != null);
      if (!withBid.length) return active;
      const max = Math.max(...withBid.map(a => a.bid));
      return withBid.filter(a => a.bid === max);
    }
    expectedSuccess() {
      let p = 1;
      for (let s = 0; s < ROLES.length; s++) {
        const w = this.winnersFor(s);
        if (!w.length) return 0;
        p *= w.reduce((t, a) => t + a.q, 0) / w.length;
      }
      return p;
    }

    // Theorem 1 view: the going price per stage and the value of acting there.
    // value(stage) = q(top bidder) x what the next stage pays it (or the reward at the end)
    prices() {
      const out = [];
      const top = [];
      for (let s = 0; s < ROLES.length; s++) {
        const w = this.winnersFor(s);
        const bid = w.length && w[0].bid != null ? w[0].bid : null;
        const q = w.length ? w.reduce((t, a) => t + a.q, 0) / w.length : 0;
        top.push({ bid, q });
      }
      for (let s = 0; s < ROLES.length; s++) {
        const next = s < ROLES.length - 1 ? (top[s + 1].bid || 0) : this.cfg.reward;
        out.push({ role: ROLES[s], bid: top[s].bid, value: top[s].q * next, q: top[s].q });
      }
      return out;
    }

    // Plain-language "why" for one agent (inspector)
    explain(id) {
      const a = this.byId(id);
      if (!a) return null;
      const s = ROLES.indexOf(a.role);
      const pr = this.prices();
      const next = s < ROLES.length - 1 ? (pr[s + 1].bid || 0) : this.cfg.reward;
      const value = a.q * next;
      const top = this.winnersFor(s);
      return {
        agent: a,
        next, value,
        margin: a.bid == null ? null : value - a.bid,
        isTop: top.some(t => t.id === a.id),
      };
    }

    totalWealth() { return this.agents.reduce((t, a) => t + a.wealth, 0); }
  }

  // Your Learn Article, Figure 1: A, B, C with bids 2, 4, 7, start 10, reward 10.
  function articleLedger(path) {
    const e = new Economy({ skipFounders: true, reward: 10, rent: 0, birthInterval: 0, minAgents: 0 });
    const A = e.addVeteran('diagnose', 1, 2, 10, 'article');
    const B = e.addVeteran('edit', 1, 4, 10, 'article');
    const C = e.addVeteran('check', 1, 7, 10, 'article');
    A.name = 'A'; B.name = 'B'; C.name = 'C';
    const forced = path === 'bug' ? [true, true, false] : [true, true, true];
    const rec = e.runEpisode({ forced, adapt: false });
    return { balances: [A.wealth, B.wealth, C.wealth], house: e.house, events: rec.events, economy: e, rec };
  }

  // Many seeds, one config: used for the Table 2 replication.
  function batch(cfg, seeds, episodes) {
    const finals = [];
    const curves = [];
    for (let k = 0; k < seeds; k++) {
      const e = new Economy(Object.assign({}, cfg, { seed: 1000 + k }));
      const curve = [];
      for (let i = 0; i < episodes; i++) curve.push(e.runEpisode().testSuccess);
      // "final" = mean test success over the last 20% of training (less noisy than one point)
      const tail = curve.slice(Math.floor(episodes * 0.8));
      finals.push(tail.reduce((t, x) => t + x, 0) / tail.length);
      curves.push(curve);
    }
    const mean = finals.reduce((t, x) => t + x, 0) / finals.length;
    const sd = Math.sqrt(finals.reduce((t, x) => t + (x - mean) ** 2, 0) / Math.max(1, finals.length - 1));
    return { mean, sd, finals, curves };
  }

  const api = { Economy, DEFAULTS, ROLES, ROLE_LABEL, ROLE_SHORT, mulberry32, articleLedger, batch };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EoM = api;
})(typeof window !== 'undefined' ? window : globalThis);
