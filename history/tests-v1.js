/* Tests for every mechanism. Runs in Node (node run-tests.js) and in the page (Under the hood -> Run tests). */
(function (root) {
  'use strict';
  function makeTests(EoM) {
    const { Economy, articleLedger, batch } = EoM;
    const T = [];
    const test = (group, name, source, fn) => T.push({ group, name, source, fn });
    const eq = (a, b, msg) => { if (Math.abs(a - b) > 1e-9) throw new Error((msg || '') + ' expected ' + b + ', got ' + a); };
    const ok = (c, msg) => { if (!c) throw new Error(msg || 'assertion failed'); };
    // An empty economy we can fill by hand. No rent, no births unless asked.
    const bare = (extra) => new Economy(Object.assign({ skipFounders: true, rent: 0, birthInterval: 0, minAgents: 0, reward: 10 }, extra || {}));

    // ---------- Eq. 1: payments ----------
    test('Payments (Eq. 1)', 'Article Figure 1: success path ends 12, 13, 13', 'Learn Article Fig. 1, paper Eq. 1', () => {
      const r = articleLedger('ok');
      eq(r.balances[0], 12, 'A'); eq(r.balances[1], 13, 'B'); eq(r.balances[2], 13, 'C'); eq(r.house, 2, 'house');
    });
    test('Payments (Eq. 1)', 'Article bug path: C misses, ends 12, 13, 3', 'Learn Article opening story', () => {
      const r = articleLedger('bug');
      eq(r.balances[0], 12, 'A'); eq(r.balances[1], 13, 'B'); eq(r.balances[2], 3, 'C');
    });
    test('Payments (Eq. 1)', 'First actor pays the house', 'Eq. 1, "for the first winner the payment is made to the house"', () => {
      const e = bare(); const a = e.addVeteran('diagnose', 1, 6, 50);
      e.runEpisode({ forced: [false], adapt: false });
      eq(e.house, 6); eq(a.wealth, 44);
    });
    test('Payments (Eq. 1)', 'Winner pays its bid to the previous winner, not to anyone else', 'Eq. 1', () => {
      const e = bare();
      const d = e.addVeteran('diagnose', 1, 3, 50), x = e.addVeteran('diagnose', 1, 1, 50), ed = e.addVeteran('edit', 1, 8, 50);
      e.runEpisode({ forced: [true, false], adapt: false });
      eq(d.wealth, 50 - 3 + 8, 'previous winner'); eq(ed.wealth, 42, 'payer'); eq(x.wealth, 50, 'bystander');
    });
    test('Payments (Eq. 1)', 'Money is conserved: wealth change = rewards - house - rent + newborn endowments - wealth of the removed', 'Eq. 1 + Alg. 1 accounting', () => {
      const e = new Economy({ seed: 11 });
      for (let i = 0; i < 400; i++) {
        const before = e.totalWealth(); const houseBefore = e.house;
        const rec = e.runEpisode();
        let rewards = 0, rent = 0, births = 0, removed = 0;
        for (const ev of rec.events) {
          if (ev.type === 'reward') rewards += ev.amount;
          if (ev.type === 'rent') rent += ev.amount * ev.n;
          if (ev.type === 'birth') births += e.cfg.initialWealth;
          if (ev.type === 'bankrupt') removed += ev.wealth;
        }
        const expected = before + rewards - (e.house - houseBefore) - rent + births - removed;
        if (Math.abs(e.totalWealth() - expected) > 1e-6) throw new Error('leak at task ' + rec.episode);
      }
    });

    // ---------- auction and trigger ----------
    test('Auction', 'Highest eligible bid wins', 'Sec. 2.2, argmax of bids', () => {
      const e = bare();
      e.addVeteran('diagnose', 1, 3, 50); const w = e.addVeteran('diagnose', 1, 9, 50); e.addVeteran('diagnose', 1, 5, 50);
      const rec = e.runEpisode({ forced: [false], adapt: false });
      eq(rec.events.find(v => v.type === 'auction').winner, w.id);
    });
    test('Auction', 'Ties are broken at random', 'Sec. 2.2, "ties broken randomly"', () => {
      const seen = new Set();
      for (let s = 0; s < 60; s++) {
        const e = bare({ seed: s });
        const a = e.addVeteran('diagnose', 1, 5, 50), b = e.addVeteran('diagnose', 1, 5, 50);
        seen.add(e.runEpisode({ forced: [false], adapt: false }).events.find(v => v.type === 'auction').winner);
      }
      ok(seen.size === 2, 'both tied agents should win sometimes');
    });
    test('Auction', 'Trigger: only agents whose stage is up can bid', 'Sec. 2.2 eligible set E_t', () => {
      const e = bare();
      const d = e.addVeteran('diagnose', 1, 1, 50); e.addVeteran('edit', 1, 99, 50);
      const rec = e.runEpisode({ forced: [false], adapt: false });
      const au = rec.events.find(v => v.type === 'auction');
      eq(au.winner, d.id); eq(au.bids.length, 1);
    });
    test('Auction', 'Without the auction (ablation) a random eligible agent acts', 'Table 2 "w/o auction" (our reading)', () => {
      let low = 0;
      for (let s = 0; s < 80; s++) {
        const e = bare({ seed: s, auction: false });
        const lo = e.addVeteran('diagnose', 1, 1, 50); e.addVeteran('diagnose', 1, 9, 50);
        if (e.runEpisode({ forced: [false], adapt: false }).events.find(v => v.type === 'auction').winner === lo.id) low++;
      }
      ok(low > 20 && low < 60, 'low bidder won ' + low + '/80');
    });

    // ---------- reward ----------
    test('Reward', 'Outcome reward goes only to the final actor', 'Alg. 1 line 5', () => {
      const e = bare({ reward: 30 });
      const d = e.addVeteran('diagnose', 1, 0, 50), ed = e.addVeteran('edit', 1, 0, 50), c = e.addVeteran('check', 1, 0, 50);
      e.runEpisode({ forced: [true, true, true], adapt: false });
      eq(c.wealth, 80); eq(d.wealth, 50); eq(ed.wealth, 50);
    });
    test('Reward', 'No reward when the chain breaks', 'Toy task rule', () => {
      const e = bare({ reward: 30 });
      e.addVeteran('diagnose', 1, 0, 50); e.addVeteran('edit', 1, 0, 50); const c = e.addVeteran('check', 1, 0, 50);
      const rec = e.runEpisode({ forced: [true, true, false], adapt: false });
      eq(c.wealth, 50); ok(rec.outcome === 'fail'); ok(!rec.events.some(v => v.type === 'reward'));
    });
    test('Reward', 'Chain-split option shares the reward equally (released-code style)', 'Code: path_reward_and_stepwise_reward (simplified)', () => {
      const e = bare({ reward: 30, rewardScheme: 'chainSplit' });
      const d = e.addVeteran('diagnose', 1, 0, 50), ed = e.addVeteran('edit', 1, 0, 50), c = e.addVeteran('check', 1, 0, 50);
      e.runEpisode({ forced: [true, true, true], adapt: false });
      eq(d.wealth, 60); eq(ed.wealth, 60); eq(c.wealth, 60);
    });

    // ---------- Eq. 2: bids ----------
    test('Bids (Eq. 2)', 'Novice bids the top veteran bid + epsilon and wins its first auction', 'Eq. 2, code fixed_with_eps', () => {
      const e = bare({ epsilon: 0.5 });
      e.addVeteran('diagnose', 1, 7, 50);
      const n = e._add(e._make('diagnose', 0.5, 'test', null));
      const rec = e.runEpisode({ forced: [false], adapt: false });
      eq(n.bid, 7.5); eq(rec.events.find(v => v.type === 'auction').winner, n.id); ok(n.status === 'veteran');
    });
    test('Bids (Eq. 2)', 'Novice with no veteran rival bids base bid + epsilon', 'Code: high_bid falls back to base_bid', () => {
      const e = bare({ baseBid: 5, epsilon: 0.5 });
      const n = e._add(e._make('diagnose', 0.5, 'test', null));
      e.runEpisode({ forced: [false], adapt: false });
      eq(n.bid, 5.5);
    });
    test('Bids (Eq. 2)', 'Bids never change after they are set', 'Sec. 2.3, "frozen" bids', () => {
      const e = new Economy({ seed: 5 });
      for (let i = 0; i < 50; i++) e.runEpisode();
      const snap = new Map(e.agents.filter(a => a.bid != null).map(a => [a.id, a.bid]));
      for (let i = 0; i < 200; i++) e.runEpisode();
      for (const a of e.agents) if (snap.has(a.id)) eq(a.bid, snap.get(a.id), a.name);
    });
    test('Bids (Eq. 2)', "'fixed' scheme: every veteran settles to the same base bid", 'Code, released research config', () => {
      const e = bare({ bidScheme: 'fixed', baseBid: 5, epsilon: 0.5 });
      const v = e.addVeteran('diagnose', 1, 9, 50);
      e.runEpisode({ forced: [false], adapt: false });
      eq(v.bid, 5);
    });

    // ---------- rent and bankruptcy ----------
    test('Rent and bankruptcy', 'Rent is charged to every agent every K_r tasks', 'Alg. 1 line 14', () => {
      const e = bare({ rent: 2, rentInterval: 3 });
      const a = e.addVeteran('diagnose', 0, 0, 50), b = e.addVeteran('edit', 0, 0, 50);
      e.runEpisode({ forced: [false] }); e.runEpisode({ forced: [false] }); eq(b.wealth, 50);
      e.runEpisode({ forced: [false] }); eq(b.wealth, 48); eq(a.wealth, 48);
    });
    test('Rent and bankruptcy', 'Below zero is removed, exactly zero survives', 'Code check_bankruptcy: wealth < 0 (matches Sec. 2.3)', () => {
      const e = bare();
      const z = e.addVeteran('edit', 1, 1, 0), neg = e.addVeteran('check', 1, 1, -0.01);
      e.addVeteran('diagnose', 1, 0, 50);
      e.runEpisode({ forced: [false] });
      ok(z.alive, 'zero survives'); ok(!neg.alive, 'negative removed');
    });
    test('Rent and bankruptcy', 'An idle agent dies from rent alone', 'Sec. 2.3 "prolonged inactivity"', () => {
      const e = bare({ rent: 2, rentInterval: 1 });
      e.addVeteran('diagnose', 1, 0, 1000); const idle = e.addVeteran('edit', 0.9, 1, 9);
      for (let i = 0; i < 6; i++) e.runEpisode({ forced: [false] });
      ok(!idle.alive);
    });
    test('Rent and bankruptcy', 'Lemma 2: an overbidder goes bankrupt in finite time', 'Appendix C.5, Lemma 2', () => {
      for (let s = 0; s < 8; s++) {
        const e = new Economy({ seed: 200 + s });
        for (let i = 0; i < 300; i++) e.runEpisode();
        const o = e.addOverbidder('diagnose');
        for (let i = 0; i < 600 && o.alive; i++) e.runEpisode();
        ok(!o.alive, 'seed ' + s + ': overbidder still alive');
      }
    });
    test('Rent and bankruptcy', 'Every role always has at least one agent', 'Code _ensure_necessary_roles_exist', () => {
      for (let s = 0; s < 10; s++) {
        const e = new Economy({ seed: s });
        for (let i = 0; i < 600; i++) {
          e.runEpisode();
          for (const r of EoM.ROLES) if (!e.agents.some(a => a.role === r)) throw new Error('missing ' + r + ' at task ' + i);
        }
      }
    });

    // ---------- evolution ----------
    test('Evolution', 'Exploitation: a good birth copies the richest agent with a small mutation', 'Sec. 2.3, code _select_best_agent_for_good_birth', () => {
      const e = new Economy({ seed: 3, mutationSigma: 0.05 });
      for (let i = 0; i < 300; i++) {
        const rich = e.richest(); const rq = rich.q, rr = rich.role;
        const rec = e.runEpisode();
        // the richest can change during the task, so check against each birth's own parent
        for (const ev of rec.events.filter(v => v.type === 'birth' && v.kind === 'good')) {
          const c = e.byId(ev.id), p = e.byId(ev.parent);
          ok(c.role === p.role, 'same role'); ok(Math.abs(c.q - p.q) < 0.3, 'small mutation');
        }
      }
    });
    test('Evolution', 'Exploration: a bad birth amends the poorest or a bankrupt agent', 'Sec. 2.3, code _select_worst_agent_for_bad_birth', () => {
      const e = new Economy({ seed: 4 });
      let n = 0;
      for (let i = 0; i < 400; i++) {
        const rec = e.runEpisode();
        for (const ev of rec.events.filter(v => v.type === 'birth' && v.kind === 'bad')) {
          const p = e.byId(ev.parent), c = e.byId(ev.id);
          ok(c.role === p.role, 'same role');
          if (ev.why === 'periodic') ok(ev.sourceWasPoorest, 'periodic bad birth uses the poorest');
          else ok(!p.alive, 'bankruptcy and role-recovery births amend a bankrupt agent');
          n++;
        }
      }
      ok(n > 0, 'some bad births happened');
    });
    test('Evolution', 'Population stays between the min and max', 'Alg. 1 [N_min, N_max]', () => {
      const e = new Economy({ seed: 9 });
      for (let i = 0; i < 1000; i++) {
        e.runEpisode();
        ok(e.agents.length <= e.cfg.maxAgents, 'over max'); ok(e.agents.length >= e.cfg.minAgents, 'under min');
      }
    });
    test('Evolution', 'Ablation switches really remove that kind of birth', 'Table 2 ablations', () => {
      const a = new Economy({ seed: 2, exploitation: false }), b = new Economy({ seed: 2, exploration: false });
      for (let i = 0; i < 800; i++) {
        for (const v of a.runEpisode().events) ok(!(v.type === 'birth' && v.kind === 'good'), 'good birth with exploitation off');
        for (const v of b.runEpisode().events) ok(!(v.type === 'birth' && v.kind === 'bad' && v.why !== 'role-recovery'), 'bad birth with exploration off');
      }
    });

    // ---------- measurement and replay ----------
    test('Measurement', 'Frozen test success = product of the top bidders\' skills', 'Alg. 2 (no payments at test time)', () => {
      const e = bare();
      e.addVeteran('diagnose', 0.5, 3, 50); e.addVeteran('diagnose', 0.9, 1, 50);
      e.addVeteran('edit', 0.8, 4, 50); e.addVeteran('check', 0.6, 2, 50);
      eq(e.expectedSuccess(), 0.5 * 0.8 * 0.6);
      const before = e.totalWealth(); e.expectedSuccess(); eq(e.totalWealth(), before, 'measuring moves no money');
    });
    test('Measurement', 'Same seed gives the exact same run (replay works)', 'Engineering', () => {
      const a = new Economy({ seed: 42 }), b = new Economy({ seed: 42 });
      for (let i = 0; i < 300; i++) { const x = a.runEpisode(), y = b.runEpisode(); if (JSON.stringify(x.events) !== JSON.stringify(y.events)) throw new Error('diverged at ' + i); }
    });

    // ---------- replication results (toy, many seeds) ----------
    test('Replication (toy)', 'Starting from weak agents, the full economy gets more capable', 'Sec. 3.2 claim, toy version', () => {
      const r = batch({}, 16, 1200);
      const start = r.curves.reduce((t, c) => t + c[0], 0) / r.curves.length;
      ok(r.mean > 2.5 * start, 'start ' + start.toFixed(3) + ' end ' + r.mean.toFixed(3));
    });
    test('Replication (toy)', 'Full system beats every ablation on average', 'Table 2 shape, toy version', () => {
      const full = batch({}, 24, 1200).mean;
      for (const cfg of [{ auction: false }, { exploration: false }, { exploitation: false }]) {
        const m = batch(cfg, 24, 1200).mean;
        ok(full > m, JSON.stringify(cfg) + ' ' + m.toFixed(3) + ' vs full ' + full.toFixed(3));
      }
    });
    test('Replication (toy)', 'Theorem 1: the long-run price of each step sits at or below its value', 'Appendix C.1, Theorem 1', () => {
      let n = 0, under = 0;
      for (let s = 0; s < 10; s++) {
        const e = new Economy({ seed: 500 + s });
        for (let i = 0; i < 1500; i++) {
          const rec = e.runEpisode();
          if (i >= 1000) for (const p of rec.prices) { if (p.bid == null) continue; n++; if (p.bid <= p.value + e.cfg.epsilon) under++; }
        }
      }
      ok(under / n > 0.6, 'share at or below value: ' + (under / n).toFixed(2));
    });

    return T;
  }

  function runTests(EoM) {
    const results = [];
    for (const t of makeTests(EoM)) {
      const t0 = Date.now();
      try { t.fn(); results.push({ ...t, pass: true, ms: Date.now() - t0 }); }
      catch (err) { results.push({ ...t, pass: false, error: String(err && err.message || err), ms: Date.now() - t0 }); }
    }
    return results;
  }

  const api = { makeTests, runTests };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EoMTests = api;
})(typeof window !== 'undefined' ? window : globalThis);
