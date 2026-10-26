/* Tests for engine v2. Runs in Node (node run-tests.js) and in the page (Under the hood -> Run all tests). */
(function (root) {
  'use strict';
  function makeTests(EoM) {
    const { Economy, articleLedger, trainRun, SIT, mulberry32, testSet, curriculum } = EoM;
    const T = [];
    const test = (group, name, source, fn) => T.push({ group, name, source, fn });
    const eq = (a, b, msg) => { if (Math.abs(a - b) > 1e-9) throw new Error((msg || '') + ' expected ' + b + ', got ' + a); };
    const ok = (c, msg) => { if (!c) throw new Error(msg || 'assertion failed'); };
    const bare = (extra) => new Economy(Object.assign({ skipFounders: true, rent: 0, birthInterval: 0, minAgents: 0, maxTrials: 1 }, extra || {}));
    const task = (level, seed) => ({ level: level || 1, seed: seed || 1 });
    const g = (o) => Object.assign({ wake: 0 }, o);

    // ---------- Eq. 1 ----------
    test('Payments (Eq. 1)', 'Article Figure 1: success path ends 12, 13, 13', 'Learn Article Fig. 1, Eq. 1', () => {
      const r = articleLedger('ok'); eq(r.balances[0], 12); eq(r.balances[1], 13); eq(r.balances[2], 13); eq(r.house, 2);
    });
    test('Payments (Eq. 1)', 'Article bug path ends 12, 13, 3', 'Learn Article opening story', () => {
      const r = articleLedger('bug'); eq(r.balances[0], 12); eq(r.balances[1], 13); eq(r.balances[2], 3);
    });
    test('Payments (Eq. 1)', 'First actor pays the house, later winners pay the previous winner', 'Eq. 1', () => {
      const e = bare({ rewardScheme: 'outcome', reward: 0 });
      const p = e.addVeteran('planner', g({ thorough: 1 }), 6, 50);
      const x = e.addVeteran('executor', g({ wake: 1 << SIT.afterPlan, skill: 0.35, selfCheck: 0 }), 9, 50);
      e.runPlanning(task(5), { training: true, rng: () => 0.99, events: [] });
      eq(e.house, 6, 'house'); eq(p.wealth, 50 - 6 + 9, 'planner paid by executor'); ok(x.wealth <= 41, 'executor paid');
    });
    test('Payments (Eq. 1)', 'Money is conserved: change = rewards - house - rent + newborn endowments - removed wealth', 'Eq. 1 + Alg. 1 accounting', () => {
      const e = new Economy({ seed: 11, maxTrials: 1 });
      const tasks = curriculum(11, 40, 'easy');
      let checked = 0;
      for (const t of tasks) {
        const before = e.totalWealth(), h0 = e.house;
        const rec = e.runEpisode(t);
        if (rec.events.some((v) => v.type === 'rollback')) continue;   // rollback restores wealth on purpose (tested below)
        checked++;
        let rw = 0, rent = 0, born = 0, rem = 0;
        for (const v of rec.events) { if (v.type === 'reward') rw += v.amount; if (v.type === 'rent') rent += v.amount * v.n; if (v.type === 'birth') born += e.cfg.initialWealth; if (v.type === 'bankrupt') rem += v.wealth; }
        const exp = before + rw - (e.house - h0) - rent + born - rem;
        if (Math.abs(e.totalWealth() - exp) > 1e-6) throw new Error('leak at episode ' + rec.episode);
      }
      ok(checked > 100, 'checked ' + checked + ' episodes');
    });

    // ---------- auction ----------
    test('Auction', 'Highest eligible bid wins', 'Sec. 2.2', () => {
      const e = bare();
      e.addVeteran('planner', g({}), 3, 50); const w = e.addVeteran('planner', g({}), 9, 50); e.addVeteran('planner', g({}), 5, 50);
      const ev = []; e.runPlanning(task(), { training: true, rng: e.rand, events: ev });
      eq(ev.find((v) => v.type === 'auction').winner, w.id);
    });
    test('Auction', 'Ties are broken at random', 'Sec. 2.2', () => {
      const seen = new Set();
      for (let s = 0; s < 40; s++) { const e = bare({ seed: s }); e.addVeteran('planner', g({}), 5, 50); e.addVeteran('planner', g({}), 5, 50);
        const ev = []; e.runPlanning(task(), { training: true, rng: e.rand, events: ev }); seen.add(ev.find((v) => v.type === 'auction').winner); }
      ok(seen.size === 2);
    });
    test('Auction', 'Without the auction (ablation) a random eligible agent acts', 'Table 2 "w/o auction" (our reading)', () => {
      let low = 0;
      for (let s = 0; s < 80; s++) { const e = bare({ seed: s, auction: false }); const lo = e.addVeteran('planner', g({}), 1, 50); e.addVeteran('planner', g({}), 9, 50);
        const ev = []; e.runPlanning(task(), { training: true, rng: e.rand, events: ev }); if (ev.find((v) => v.type === 'auction').winner === lo.id) low++; }
      ok(low > 20 && low < 60, 'low bidder won ' + low + '/80');
    });

    // ---------- wake-up ----------
    test('Wake-up', 'The planner starts on its own in an empty workspace', 'Code: planner auto-start', () => {
      const e = bare(); const p = e.addVeteran('planner', g({ wake: 0 }), 1, 50);
      ok(e.wakes(p, e.newState(task()), 0));
    });
    test('Wake-up', 'The same role never acts twice in a row', 'Code: research adapter wake-up', () => {
      const e = bare(); const x = e.addVeteran('executor', g({ wake: 0xff }), 1, 50);
      const st = e.newState(task(3)); st.lastRole = 'executor'; st.parts = [true];
      ok(!e.wakes(x, st, 1));
    });
    test('Wake-up', 'The answer agent wakes only after an executor or verifier, and always right after an executor', 'Code: _WAKE_AFTER, _FALLBACK_AFTER', () => {
      const e = bare(); const a = e.addVeteran('answer', g({ wake: 0 }), 1, 50);
      const st = e.newState(task(3));
      st.lastRole = 'planner'; ok(!e.wakes(a, st, 1), 'not after planner');
      st.lastRole = 'executor'; st.parts = [true]; ok(e.wakes(a, st, 2), 'always after executor');
      st.lastRole = 'verifier'; ok(!e.wakes(a, st, 3), 'after verifier only if its prompt says so');
      a.genome.wake = 1 << SIT.passedMore; ok(e.wakes(a, st, 3));
    });
    test('Wake-up', 'Otherwise an agent wakes only in the situations its prompt lists', 'Sec. 2.1 trigger predicate', () => {
      const e = bare(); const v = e.addVeteran('verifier', g({ wake: 1 << SIT.execMore }), 1, 50);
      const st = e.newState(task(3)); st.lastRole = 'executor'; st.parts = [true];
      ok(e.wakes(v, st, 1));
      st.lastRole = 'planner'; st.parts = []; ok(!e.wakes(v, st, 1));
    });
    test('Wake-up', 'In the final step only answer agents may act (terminal mode)', 'Code: terminal mode', () => {
      const e = bare(); const x = e.addVeteran('executor', g({ wake: 0xff }), 1, 50); const a = e.addVeteran('answer', g({ wake: 0 }), 1, 50);
      const st = e.newState(task(3)); st.lastRole = 'planner';
      ok(!e.wakes(x, st, 9)); ok(e.wakes(a, st, 9));
    });

    // ---------- the task ----------
    test('Task', 'A correct answer needs every step done and right', 'Toy task rule', () => {
      const e = bare(); const a = e.addVeteran('answer', g({ patience: 0, care: 1 }), 1, 50);
      let st = e.newState(task(4)); st.parts = [true, false, true]; e.act(a, st, () => 0.5); ok(!st.success);
      st = e.newState(task(4)); st.parts = [true, true, true]; e.act(a, st, () => 0.5); ok(st.success);
      st = e.newState(task(4)); st.parts = [true, true]; e.act(a, st, () => 0.5); ok(!st.success && st.submittedIncomplete);
    });
    test('Task', 'A patient answer agent waits when the work is unfinished', 'Research prompt: abstain if insufficient', () => {
      const e = bare(); const a = e.addVeteran('answer', g({ patience: 1, care: 1 }), 1, 50);
      const st = e.newState(task(4)); st.parts = [true]; const n = e.act(a, st, () => 0.5);
      ok(n.kind === 'abstain' && !st.done);
    });
    test('Task', 'A flagged step is fixed by the next executor', 'Research prompt: fix only the flagged error', () => {
      const e = bare(); const x = e.addVeteran('executor', g({ skill: 0.35, selfCheck: 0 }), 1, 50);
      const st = e.newState(task(2)); st.parts = [false]; st.flag = true;
      const n = e.act(x, st, () => 0.01);
      ok(n.kind === 'fix' && st.parts[0] === true && !st.flag && st.parts.length === 1);
    });
    test('Task', 'A verifier flags a wrong step with its detection rate', 'Toy task rule', () => {
      const e = bare(); const v = e.addVeteran('verifier', g({ detect: 0.7, falseAlarm: 0 }), 1, 50);
      let hits = 0; const r = mulberry32(3);
      for (let i = 0; i < 2000; i++) { const st = e.newState(task(2)); st.parts = [false]; e.act(v, st, r); if (st.flag) hits++; }
      ok(Math.abs(hits / 2000 - 0.7) < 0.04, 'rate ' + hits / 2000);
    });

    // ---------- rewards ----------
    test('Reward', 'Released config: a right answer pays the answer agent 0.5 x 100 and splits 100 over the path', 'Code: path_reward_and_stepwise_reward', () => {
      const e = bare({ rewardScheme: 'released' });
      const p = e.addVeteran('planner', g({ thorough: 1 }), 0, 50);
      const x = e.addVeteran('executor', g({ wake: 1 << SIT.afterPlan, skill: 0.35, selfCheck: 0.9 }), 0, 50);
      const a = e.addVeteran('answer', g({ patience: 0, care: 1 }), 0, 50);
      e.runEpisode({ level: 1, seed: 1 });
      if (e.paths[0].success) { eq(p.wealth, 50 + 100 / 3); eq(x.wealth, 50 + 100 / 3); eq(a.wealth, 50 + 100 / 3 + 50); }
      else throw new Error('expected a success with these settings');
    });
    test('Reward', 'Released config: a wrong or missing answer costs everyone on the path', 'Code: centered score, missing_terminal_score 0', () => {
      const e = bare({ rewardScheme: 'released' });
      const p = e.addVeteran('planner', g({ thorough: 0 }), 0, 5000);
      const x = e.addVeteran('executor', g({ wake: 1 << SIT.afterPlan, skill: -0.3, selfCheck: 0 }), 0, 5000);
      const a = e.addVeteran('answer', g({ patience: 0, care: 0 }), 0, 5000);
      let fails = 0;
      for (let i = 0; i < 20; i++) { const b = [p.wealth, x.wealth, a.wealth]; const rec = e.runEpisode({ level: 5, seed: i }); if (!rec.success) { fails++; ok(p.wealth < b[0] && x.wealth < b[1] && a.wealth < b[2], 'everyone loses on failure'); } }
      ok(fails > 0);
    });
    test('Reward', 'Paper rule (Eq. 1): only the final actor is paid, and only on success', 'Alg. 1 line 5', () => {
      const e = bare({ rewardScheme: 'outcome', reward: 30 });
      const p = e.addVeteran('planner', g({ thorough: 1 }), 0, 50);
      const x = e.addVeteran('executor', g({ wake: 1 << SIT.afterPlan, skill: 0.35, selfCheck: 0.9 }), 0, 50);
      const a = e.addVeteran('answer', g({ patience: 0, care: 1 }), 0, 50);
      const rec = e.runEpisode({ level: 1, seed: 1 });
      ok(rec.success); eq(a.wealth, 80); eq(p.wealth, 50); eq(x.wealth, 50);
    });

    // ---------- Eq. 2 ----------
    test('Bids (Eq. 2)', 'A newcomer bids the top veteran bid + epsilon and wins its first auction', 'Eq. 2, code fixed_with_eps', () => {
      const e = bare({ epsilon: 1 });
      e.addVeteran('planner', g({}), 7, 50);
      const n = e._add(e._make('planner', e.founderGenome('planner'), 'test', null));
      const ev = []; e.runPlanning(task(), { training: true, rng: e.rand, events: ev });
      eq(n.bid, 8); eq(ev.find((v) => v.type === 'auction').winner, n.id);
    });
    test('Bids (Eq. 2)', 'With no veteran rival a newcomer bids base + epsilon', 'Code: high_bid falls back to base_bid', () => {
      const e = bare({ baseBid: 10, epsilon: 1 }); const n = e._add(e._make('planner', e.founderGenome('planner'), 'test', null));
      e.runPlanning(task(), { training: true, rng: e.rand, events: [] }); eq(n.bid, 11);
    });
    test('Bids (Eq. 2)', 'Bids never change once set', 'Sec. 2.3', () => {
      const e = new Economy({ seed: 5 }); const tasks = curriculum(5, 20, 'easy');
      tasks.slice(0, 30).forEach((t) => e.runEpisode(t));
      const snap = new Map(e.agents.filter((a) => a.bid != null).map((a) => [a.id, a.bid]));
      tasks.slice(30).forEach((t) => e.runEpisode(t));
      for (const a of e.agents) if (snap.has(a.id)) eq(a.bid, snap.get(a.id), a.name);
    });
    test('Bids (Eq. 2)', "'fixed' scheme: every veteran settles to the base bid", 'Released research config', () => {
      const e = bare({ bidScheme: 'fixed', baseBid: 10 }); const v = e.addVeteran('planner', g({}), 25, 50);
      e.runPlanning(task(), { training: true, rng: e.rand, events: [] }); eq(v.bid, 10);
    });

    // ---------- rent, bankruptcy, trials ----------
    test('Rent and bankruptcy', 'Rent is charged to every agent every K_r episodes', 'Alg. 1', () => {
      const e = bare({ rent: 20, rentInterval: 3, rewardScheme: 'outcome' });
      const a = e.addVeteran('verifier', g({}), 0, 100), b = e.addVeteran('verifier', g({}), 0, 100);
      e.runEpisode(task()); e.runEpisode(task()); eq(b.wealth, 100);
      e.runEpisode(task()); eq(b.wealth, 80); eq(a.wealth, 80);
    });
    test('Rent and bankruptcy', 'Below zero is removed, exactly zero survives', 'Code check_bankruptcy: wealth < 0', () => {
      const e = bare({ rewardScheme: 'outcome' }); const z = e.addVeteran('verifier', g({}), 0, 0); const n = e.addVeteran('verifier', g({}), 0, -0.01);
      e.runEpisode(task()); ok(z.alive); ok(!n.alive);
    });
    test('Rent and bankruptcy', 'Bankruptcy in a trial rolls survivors back and replays the task', 'Alg. 1 lines 3-12, code ROLLBACK', () => {
      const e = bare({ maxTrials: 2, rewardScheme: 'outcome', reward: 0 });
      e.addVeteran('planner', g({ thorough: 1 }), 30, 1);      // will go bankrupt paying its bid
      const keeper = e.addVeteran('verifier', g({}), 0, 77);
      const rec = e.runEpisode(task());
      ok(rec.events.some((v) => v.type === 'rollback'), 'rolled back'); ok(rec.events.filter((v) => v.type === 'trial').length === 2, 'replayed');
      eq(keeper.wealth, 77, 'survivor restored');
    });
    test('Rent and bankruptcy', 'Lemma 2: an overbidder goes bankrupt in finite time', 'Appendix C.5', () => {
      for (let s = 0; s < 6; s++) {
        const e = new Economy({ seed: 300 + s }); const tasks = curriculum(300 + s, 40, 'easy');
        tasks.slice(0, 40).forEach((t) => e.runEpisode(t));
        const top = Math.max(...e.agents.filter((a) => a.role === 'planner' && a.bid != null).map((a) => a.bid), 10);
        const o = e.addVeteran('planner', { thorough: 0.1 }, top + 40, null, 'overbidder');
        for (const t of tasks.slice(40)) { if (!o.alive) break; e.runEpisode(t); }
        ok(!o.alive, 'seed ' + s);
      }
    });
    test('Rent and bankruptcy', 'Every role always keeps at least one agent', 'Code _ensure_necessary_roles_exist', () => {
      for (let s = 0; s < 8; s++) { const e = new Economy({ seed: s }); for (const t of curriculum(s, 20, 'easy')) { e.runEpisode(t); for (const r of EoM.ROLES) if (!e.agents.some((a) => a.role === r)) throw new Error('missing ' + r); } }
    });

    // ---------- evolution ----------
    test('Evolution', 'Exploitation copies the richest agent with a small change', 'Sec. 2.3, code _select_best_agent_for_good_birth', () => {
      const e = new Economy({ seed: 3 }); let n = 0;
      for (const t of curriculum(3, 20, 'easy')) {
        const rec = e.runEpisode(t);
        for (const v of rec.events.filter((x) => x.type === 'birth' && x.kind === 'good')) {
          const c = e.byId(v.id), p = e.byId(v.parent); ok(c.role === p.role);
          for (const k of Object.keys(EoM.PARAMS[c.role])) ok(Math.abs(c.genome[k] - p.genome[k]) < 0.35, 'small change in ' + k);
          n++;
        }
      }
      ok(n > 0);
    });
    test('Evolution', 'Exploration reads the failure trace and repairs that weakness', 'Sec. 2.3, BAD_AGENT_BIRTH_PROMPT', () => {
      const e = bare({ amendRandomP: 0 });
      const x = e.addVeteran('executor', g({ skill: 0, selfCheck: 0.1 }), 1, -1); x.lastFailure = { type: 'wrongStep' };
      const c = e._birthBad(x, [], 'bankruptcy', true); ok(c.genome.selfCheck > 0.1 && c.genome.skill > 0, 'executor repaired');
      const v = e.addVeteran('verifier', g({ detect: 0.3, falseAlarm: 0.2 }), 1, -1); v.lastFailure = { type: 'missedError' };
      ok(e._birthBad(v, [], 'bankruptcy', true).genome.detect > 0.3, 'verifier repaired');
      const a = e.addVeteran('answer', g({ patience: 0.2, wake: 1 << SIT.passedMore }), 1, -1); a.lastFailure = { type: 'answeredEarly', sit: SIT.passedMore };
      const ca = e._birthBad(a, [], 'bankruptcy', true); ok(ca.genome.patience > 0.2 && !((ca.genome.wake >> SIT.passedMore) & 1), 'answer now waits');
      const idle = e.addVeteran('planner', g({ wake: 0 }), 1, -1);
      ok(e._birthBad(idle, [], 'bankruptcy', true).genome.wake !== 0, 'idle agent tries waking somewhere new');
    });
    test('Evolution', 'Population stays within its bounds', 'Alg. 1 [N_min, N_max]', () => {
      const e = new Economy({ seed: 9 });
      for (const t of curriculum(9, 40, 'mixed')) { e.runEpisode(t); ok(e.agents.length <= e.cfg.maxAgents + 4, 'over max'); ok(e.agents.length >= e.cfg.minAgents, 'under min'); }
    });
    test('Evolution', 'Ablation switches remove that kind of birth', 'Table 2', () => {
      const a = new Economy({ seed: 2, exploitation: false }), b = new Economy({ seed: 2, exploration: false });
      for (const t of curriculum(2, 20, 'easy')) {
        for (const v of a.runEpisode(t).events) ok(!(v.type === 'birth' && v.kind === 'good'), 'good birth with exploitation off');
        for (const v of b.runEpisode(t).events) ok(!(v.type === 'birth' && v.kind === 'bad' && v.why !== 'role-recovery'), 'bad birth with exploration off');
      }
    });

    // ---------- measurement ----------
    test('Measurement', 'Testing moves no money and changes no agent', 'Alg. 2', () => {
      const e = new Economy({ seed: 4 }); curriculum(4, 10, 'easy').forEach((t) => e.runEpisode(t));
      const before = JSON.stringify(e.agents); const h = e.house; e.evaluate(testSet(10));
      ok(JSON.stringify(e.agents) === before && e.house === h);
    });
    test('Measurement', 'Each checkpoint faces the same dice, so scores are comparable', 'Common random numbers', () => {
      const e = new Economy({ seed: 4 }); const ts = testSet(10);
      eq(e.evaluate(ts).acc, e.evaluate(ts).acc);
    });
    test('Measurement', 'Same seed, same run', 'Replay', () => {
      const a = trainRun({ seed: 42 }, { perLevel: 6, testPerLevel: 6 }), b = trainRun({ seed: 42 }, { perLevel: 6, testPerLevel: 6 });
      ok(JSON.stringify(a.checkpoints.map((c) => c.acc)) === JSON.stringify(b.checkpoints.map((c) => c.acc)));
    });

    // ---------- replication (toy) ----------
    test('Replication (toy)', 'Starting from weak agents, training makes the team more capable', 'Sec. 3.2, toy version', () => {
      let gain = 0; const n = 10;
      for (let s = 0; s < n; s++) { const r = trainRun({ seed: 100 + s }); gain += r.final - r.initial; }
      ok(gain / n > 0.15, 'average gain ' + (gain / n).toFixed(3));
    });
    test('Replication (toy)', 'Removing the auction makes the team worse', 'Table 2 right, toy version', () => {
      const n = 20, avg = (cfg) => { let t = 0; for (let s = 0; s < n; s++) t += trainRun(Object.assign({ seed: 100 + s }, cfg)).final; return t / n; };
      const full = avg({}), noA = avg({ auction: false });
      ok(full > noA + 0.03, 'full ' + full.toFixed(3) + ' vs no auction ' + noA.toFixed(3));
    });
    test('Replication (toy)', 'Too much rent or a too-large reward hurts, like Table 2 left', 'Table 2 left, toy version', () => {
      const n = 20, avg = (cfg) => { let t = 0; for (let s = 0; s < n; s++) t += trainRun(Object.assign({ seed: 100 + s }, cfg)).final; return t / n; };
      const orig = avg({});
      for (const cfg of [{ rent: 200 }, { reward: 400 }]) { const m = avg(cfg); ok(orig > m, JSON.stringify(cfg) + ' ' + m.toFixed(3) + ' vs ' + orig.toFixed(3)); }
    });
    return T;
  }
  function runTests(EoM) {
    const out = [];
    for (const t of makeTests(EoM)) {
      const t0 = Date.now();
      try { t.fn(); out.push({ ...t, pass: true, ms: Date.now() - t0 }); }
      catch (err) { out.push({ ...t, pass: false, error: String((err && err.message) || err), ms: Date.now() - t0 }); }
    }
    return out;
  }
  const api = { makeTests, runTests };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EoMTests = api;
})(typeof window !== 'undefined' ? window : globalThis);
