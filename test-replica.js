// Tests for replica-core.js, the port of the released EoM engine.
// A scripted stand-in model drives whole episodes; each test checks one rule
// against what the Python code does. Run: node test-replica.js
const C = require('./replica-core.js');
const data = require('./replica_data.json');
const results = [];
async function test(name, src, fn) { const t0 = Date.now(); try { await fn(); results.push([true, name, src, Date.now() - t0]); } catch (e) { results.push([false, name, src, Date.now() - t0, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)]); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const near = (a, b, m) => assert(Math.abs(a - b) < 1e-9, (m || '') + ' expected ' + b + ' got ' + a);

const roleOf = (prompt) => { const m = /You are the \*\*(\w+)\*\*/.exec(prompt); return m ? m[1].toLowerCase() : '?'; };
// opts: wake(role, prompt) -> bool, act(role, prompt) -> text, judge -> text, birth -> text
function stub(o) {
  o = o || {}; const calls = { wake: 0, act: 0, judge: 0, birth: 0 }, log = [];
  const ask = async (kind, prompt) => {
    calls[kind]++; log.push({ kind, prompt });
    const role = roleOf(prompt);
    if (kind === 'wake') return o.wake ? (o.wake(role, prompt) ? 'ok \\boxed{yes}' : 'no \\boxed{no}') : 'sure \\boxed{yes}';
    if (kind === 'act') { if (o.act) return o.act(role, prompt); return role === 'answer' || role === 'executor' ? '<step>done</step>\n<final_answer>\\boxed{' + (o.answer || '42') + '}</final_answer>' : '<step>' + role + ' work</step>'; }
    if (kind === 'judge') return o.judge || 'SCORE: 1.0\nREASON: fine';
    if (kind === 'birth') return o.birth != null ? o.birth : 'Do: check every step twice.\nDo not: rush.';
    return '';
  };
  return { ask, calls, log, shouldStop: () => false };
}
function cfg(over) {
  const m = JSON.parse(JSON.stringify(C.RELEASED_RESEARCH_MAS));
  for (const k of Object.keys(over || {})) Object.assign(m[k] = m[k] || {}, over[k]);
  return C.configFromDict(m);
}
const runOpts = (c, extra) => Object.assign({ maxSteps: c.engine.max_steps_per_episode, useJudge: true, judgeThreshold: 0.5, rewardCfg: c.reward }, extra || {});
function makeMas(adapterKey, c, ctx, events, seed, extra) {
  const ad = C.ADAPTERS[adapterKey], ids = { counter: 0 }, rng = C.makeRng(seed || 7);
  const opts = runOpts(c, extra);
  const mas = new C.HayekMAS(c, ad, opts, ctx, (type, p) => events.push(Object.assign({ type }, p)), rng, ids);
  for (const spec of ad.roles) { const a = new C.Agent(spec, ids); a.initialize(c.engine.initial_wealth); mas.population.add_agent(a); }
  mas._initial_agents = mas.population.get_all();
  return { mas, ad, opts };
}
const rtask = data.research.train[0], mtask = data.math.train[0];
const env = (ad, task, opts) => new C.TextEnv(ad, task, opts);
const total = (mas) => mas.population.get_all().reduce((t, a) => t + a.wealth, 0);

(async () => {
  await test('The config is the released train_research.json', 'global_configs/train_research.json', async () => {
    const c = C.configFromDict(C.RELEASED_RESEARCH_MAS);
    const want = { max_steps_per_episode: 10, max_trials_per_episode: 2, birth_interval: 3, num_births_per_interval: 2, min_num_agents: 2, max_num_agents: 20, bid_scheme: 'fixed', base_bid: 0.1, novice_bid_epsilon: 0.1, initial_wealth: 0.5, rent: 0.2, rent_interval: 3 };
    for (const [k, v] of Object.entries(want)) assert(c.engine[k] === v, k);
    assert(c.reward.reward_scheme === 'path_reward_and_stepwise_reward' && c.reward.terminal_output_bonus_scale === 0.5 && c.reward.missing_terminal_score === 0);
    assert(c.evolution.p_a === 0.334 && c.evolution.p_b === 0.334 && c.evolution.periodical_good_p === 0.5);
    assert(c.evaluation.periodic_test_every_n_tasks === 3 && c.evaluation.periodic_test_before_training === false);
    assert(c.concurrency.wakeup_retry_attempts === 2 && c.concurrency.wakeup_fail_open === false, 'defaults from ConcurrencyConfig');
    assert(c.terminal.enabled && c.terminal.start_on_step_from_end === 1);
  });

  await test('Payment: the winner pays its bid to the previous winner, the first winner pays nobody', 'mas.py _run_auction_action_loop', async () => {
    const c = cfg({ engine: { rent: 0, birth_interval: 0 } }), ev = [], ctx = stub();
    const { mas, ad, opts } = makeMas('research', c, ctx, ev);
    const before = total(mas); await mas.train().run_one_episode(env(ad, rtask, opts));
    const pays = ev.filter((e) => e.type === 'pay'), auc = ev.filter((e) => e.type === 'auction');
    assert(pays.length === auc.length && pays.length >= 2, 'one payment per turn');
    assert(pays[0].to === null, 'first payment goes nowhere');
    for (let i = 1; i < pays.length; i++) assert(pays[i].to === auc[i - 1].winner, 'pays the previous winner');
    const voidPaid = pays.filter((p) => p.to === null).reduce((t, p) => t + p.amount, 0);
    const rewards = ev.filter((e) => e.type === 'reward').reduce((t, e) => t + e.amount * e.ids.length, 0);
    const path = ev.filter((e) => e.type === 'path').reduce((t, e) => t + e.per * e.n, 0);
    near(total(mas) - before, -voidPaid + rewards + path, 'money is conserved apart from the void, rewards and path rewards');
  });

  await test('Bids (fixed): a novice bids base + epsilon once, then base as a veteran', 'mas.py bid_scheme == "fixed"', async () => {
    const c = cfg({ engine: { rent: 0, birth_interval: 0 } }), ev = [];
    const { mas, ad, opts } = makeMas('research', c, stub(), ev);
    await mas.train().run_one_episode(env(ad, rtask, opts));
    const seen = new Set();
    for (const a of ev.filter((e) => e.type === 'auction')) for (const b of a.bids) {
      if (!seen.has(b.id)) { near(b.bid, 0.2, 'first auction'); seen.add(b.id); }
      else near(b.bid, 0.1, 'later auctions');
    }
    assert(mas.population.get_all().every((a) => a._status === 'veteran' || a.wins === 0), 'status moves to veteran');
  });

  await test('Bids (fixed_with_eps, paper Eq. 2): novice = top awake veteran bid + epsilon', 'mas.py bid_scheme == "fixed_with_eps"', async () => {
    const c = cfg({ engine: { rent: 0, birth_interval: 0, bid_scheme: 'fixed_with_eps', novice_bid_epsilon: 0.05 } }), ev = [];
    const { mas, ad, opts } = makeMas('research', c, stub(), ev);
    await mas.train().run_one_episode(env(ad, rtask, opts));
    const bidOf = new Map(); let checked = 0;
    for (const a of ev.filter((e) => e.type === 'auction')) {
      const vets = a.bids.filter((b) => bidOf.has(b.id)).map((b) => bidOf.get(b.id));
      const high = vets.length ? Math.max(...vets) : 0.1;
      for (const b of a.bids) { if (!bidOf.has(b.id)) { near(b.bid, high + 0.05); bidOf.set(b.id, b.bid); checked++; } else near(b.bid, bidOf.get(b.id), 'bid frozen'); }
    }
    assert(checked >= 3);
  });

  await test('Auction: the highest awake bid wins, ties broken at random', 'mas.py AUCTION', async () => {
    const ev = [];
    for (let s = 1; s <= 6; s++) { const c = cfg({ engine: { rent: 0, birth_interval: 0 } }); const { mas, ad, opts } = makeMas('research', c, stub(), ev, s); await mas.train().run_one_episode(env(ad, rtask, opts)); }
    const auc = ev.filter((e) => e.type === 'auction');
    for (const a of auc) { const mx = Math.max(...a.bids.map((b) => b.bid)); assert(a.bids.find((b) => b.id === a.winner).bid === mx); }
    const firsts = new Set(auc.filter((a) => a.step === 0).map((a) => a.winner));
    assert(firsts.size === 2, 'Literature and Planner tie on the empty workspace and both get picked across seeds');
  });

  await test('Wake-up: same role never twice in a row, Literature and Planner self-start', 'researchworld/agent.py match_wakeup_condition', async () => {
    const ev = [], ctx = stub();
    const c = cfg({ engine: { rent: 0, birth_interval: 0 } }); const { mas, ad, opts } = makeMas('research', c, ctx, ev, 3);
    await mas.train().run_one_episode(env(ad, rtask, opts));
    const first = ev.filter((e) => e.type === 'wake:result').slice(0, 5);
    const byId = new Map(mas.population.get_all().map((a) => [a.id, a.role]));
    for (const w of first) { const r = byId.get(w.id); if (r === 'literature' || r === 'planner') assert(w.yes && w.why === 'auto-start'); if (r === 'answer') assert(!w.yes && w.why === 'no prior actions'); }
    const acts = ev.filter((e) => e.type === 'act');
    for (let i = 1; i < acts.length; i++) assert(acts[i].role !== acts[i - 1].role, 'same role twice');
    const autoCalls = ctx.log.filter((l) => l.kind === 'wake').length;
    assert(autoCalls > 0, 'other roles ask the model');
  });

  await test('Wake-up: the Answer agent wakes only after a deriver or verifier, and always after a deriver', 'AnswerResearchAgent._WAKE_AFTER/_FALLBACK_AFTER', async () => {
    const ev = [], ctx = stub({ wake: (role) => role !== 'answer' });
    const c = cfg({ engine: { rent: 0, birth_interval: 0 } }); const { mas, ad, opts } = makeMas('research', c, ctx, ev, 5);
    await mas.train().run_one_episode(env(ad, rtask, opts));
    const ans = mas.population.get_all().find((a) => a.role === 'answer').id;
    let lastRole = null;
    for (const e of ev) {
      if (e.type === 'wake:result' && e.id === ans) {
        if (!lastRole) assert(!e.yes);
        else if (lastRole === 'deriver') assert(e.yes && e.why === 'fallback after deriver', 'fallback');
        else if (lastRole === 'verifier') assert(!e.yes, 'model said no after a verifier');
        else assert(!e.yes && /last role/.test(e.why));
      }
      if (e.type === 'act') lastRole = e.role;
    }
  });

  await test('Reward: answer agent gets 0.5 x (2s-1), every turn on the path gets (2s-1)/N', 'env._handle_final_answer + mas._apply_path_rewards', async () => {
    for (const [judge, s] of [['SCORE: 1.0\nREASON: x', 1], ['SCORE: 0.25\nREASON: x', 0.25]]) {
      const ev = []; const c = cfg({ engine: { rent: 0, birth_interval: 0, initial_wealth: 50 } });
      const { mas, ad, opts } = makeMas('research', c, stub({ judge }), ev, 2);
      await mas.train().run_one_episode(env(ad, rtask, opts));
      const step = ev.find((e) => e.type === 'reward'); near(step.amount, 0.5 * (2 * s - 1), 'answer bonus');
      const p = ev.find((e) => e.type === 'path'); const n = ev.filter((e) => e.type === 'act').length;
      assert(p.n === n, 'one share per action, repeats included'); near(p.per, (2 * s - 1) / n, 'path share');
    }
  });

  await test('Reward: no final answer counts as score 0, so everyone on the path loses', 'missing_terminal_score = 0, centred', async () => {
    const ev = []; const c = cfg({ engine: { rent: 0, birth_interval: 0, initial_wealth: 50 }, terminal: { enabled: false } });
    const { mas, ad, opts } = makeMas('research', c, stub({ act: (r) => '<step>' + r + ' says the state is insufficient</step>' }), ev, 2);
    await mas.train().run_one_episode(env(ad, rtask, opts));
    const p = ev.find((e) => e.type === 'path'); near(p.per, -1 / p.n); assert(p.n === 10, 'all 10 turns used');
    assert(!ev.some((e) => e.type === 'judge'));
  });

  await test('Terminal mode: last turn skips wake-up, only terminal-tagged agents bid, the answer is forced', 'mas._is_terminal_mode_step + ResearchAgent.act', async () => {
    const ev = [], ctx = stub({ act: (r) => '<step>' + r + ' partial work</step>' });
    const c = cfg({ engine: { rent: 0, birth_interval: 0, initial_wealth: 50 } }); const { mas, ad, opts } = makeMas('research', c, ctx, ev, 4);
    await mas.train().run_one_episode(env(ad, rtask, opts));
    const term = ev.find((e) => e.type === 'terminal'); assert(term, 'terminal step reached');
    const ans = mas.population.get_all().filter((a) => a.role === 'answer').map((a) => a.id);
    assert(term.ids.every((i) => ans.includes(i)), 'only answer agents');
    const lastAct = ev.filter((e) => e.type === 'act').pop(); assert(lastAct.role === 'answer' && lastAct.isFinal && /<final_answer>/.test(lastAct.text), 'wrapped into a final answer');
    const ws = ev.filter((e) => e.type === 'step:start'); const lastStep = ws[ws.length - 1];
    assert(lastStep.terminal && lastStep.step === 9);
  });

  await test('Bankruptcy below zero, then rollback and a replay with bids kept', 'mas._train_forward replay loop', async () => {
    const ev = []; const c = cfg({ engine: { rent: 0, birth_interval: 0, initial_wealth: 0.15, min_num_agents: 0 }, evolution: { p_a: 0, p_b: 0 } });
    const { mas, ad, opts } = makeMas('research', c, stub({ judge: 'SCORE: 0\nREASON: wrong' }), ev, 9);
    await mas.train().run_one_episode(env(ad, rtask, opts));
    const bk = ev.filter((e) => e.type === 'bankrupt'); assert(bk.length >= 1, 'someone went bankrupt');
    assert(bk.every((b) => b.wealth < 0), 'strictly below zero');
    const rb = ev.find((e) => e.type === 'rollback'); assert(rb, 'rolled back');
    for (const w of rb.wealth) if (w.id <= 5) near(w.wealth, 0.15, 'survivors restored to the snapshot');
    assert(ev.filter((e) => e.type === 'trial').length === 2, 'replayed once (max_trials 2)');
  });

  await test('Role recovery: a role that dies out is reborn from its bankrupt member', 'mas._ensure_necessary_roles_exist', async () => {
    const ev = []; const c = cfg({ engine: { rent: 0, birth_interval: 0, initial_wealth: 0.15, min_num_agents: 0, max_trials_per_episode: 1 }, evolution: { p_a: 0, p_b: 0 } });
    const { mas, ad, opts } = makeMas('research', c, stub({ judge: 'SCORE: 0\nREASON: wrong' }), ev, 9);
    await mas.train().run_one_episode(env(ad, rtask, opts));
    const roles = new Set(mas.population.get_all().map((a) => a.role));
    for (const r of ['literature', 'planner', 'deriver', 'verifier', 'answer']) assert(roles.has(r), 'role ' + r + ' present');
    const rec = ev.filter((e) => e.type === 'birth' && /role recovery/.test(e.why)); assert(rec.length >= 1 && rec.every((b) => b.kind === 'bad'));
  });

  await test('Rent every 3 tasks, then births: 2 per 3 tasks, half copies of the richest', 'mas._train_forward RENT + _periodic_births', async () => {
    const ev = []; const c = cfg({ engine: { initial_wealth: 50 } });
    const { mas, ad, opts } = makeMas('research', c, stub(), ev, 11);
    mas.train();
    for (let i = 0; i < 9; i++) await mas.run_one_episode(env(ad, data.research.train[i], opts));
    const rents = ev.filter((e) => e.type === 'rent'); assert(rents.length === 3, 'rent at episodes 3, 6, 9');
    const births = ev.filter((e) => e.type === 'birth' && /periodic/.test(e.why)); assert(births.length === 6, 'two births per interval, got ' + births.length);
    for (const b of births.filter((x) => x.kind === 'good')) assert(/^\w+-\d{4}$/.test(b.agent.name), 'child named Base-NNNN');
    assert(mas.population.size === 11);
  });

  await test('Population cap: no births past max_num_agents', 'mas._can_add_agent', async () => {
    const ev = []; const c = cfg({ engine: { initial_wealth: 50, max_num_agents: 6 } });
    const { mas, ad, opts } = makeMas('research', c, stub(), ev, 11); mas.train();
    for (let i = 0; i < 9; i++) await mas.run_one_episode(env(ad, data.research.train[i], opts));
    assert(mas.population.size <= 6);
  });

  await test('Good birth: the copy gets a new trainable prompt, frozen prompt untouched', 'ResearchAgent.birth_good_agent', async () => {
    const ev = [], ctx = stub({ birth: '<trainable_system_prompt>"Try small cases first."</trainable_system_prompt>' });
    const c = cfg({ engine: { initial_wealth: 50 }, evolution: { periodical_good_p: 1 } });
    const { mas, ad, opts } = makeMas('research', c, ctx, ev, 1); mas.train();
    for (let i = 0; i < 3; i++) await mas.run_one_episode(env(ad, data.research.train[i], opts));
    const b = ev.find((e) => e.type === 'birth'); assert(b.kind === 'good');
    const child = mas.population.get_all().find((a) => a.id === b.agent.id);
    assert(child.trainable_system_prompt === 'Try small cases first.', 'tags and quotes stripped: ' + child.trainable_system_prompt);
    const parent = mas.population.get_all().find((a) => a.name === b.parent); assert(child.frozen_system_prompt === parent.frozen_system_prompt && child.cls === parent.cls);
    assert(ctx.log.some((l) => l.kind === 'birth' && l.prompt.startsWith('You are an expert prompt engineer. You will modify an agent\'s system prompt to improve')));
  });

  await test('Good birth fallback: a reply under 10 characters keeps the parent prompt', 'ResearchAgent.birth_good_agent', async () => {
    const ev = []; const c = cfg({ engine: { initial_wealth: 50 }, evolution: { periodical_good_p: 1 } });
    const { mas, ad, opts } = makeMas('research', c, stub({ birth: 'short' }), ev, 1); mas.train();
    for (let i = 0; i < 3; i++) await mas.run_one_episode(env(ad, data.research.train[i], opts));
    const b = ev.find((e) => e.type === 'birth'); assert(b.after === b.before);
  });

  await test('Bad birth: the repair prompt gets the task, the right answer and a >>> marked trace', 'ResearchAgent.birth_bad_agent', async () => {
    const ev = [], ctx = stub({ judge: 'SCORE: 0\nREASON: wrong' });
    const c = cfg({ engine: { initial_wealth: 50 }, evolution: { periodical_good_p: 0 } });
    const { mas, ad, opts } = makeMas('research', c, ctx, ev, 1); mas.train();
    for (let i = 0; i < 3; i++) await mas.run_one_episode(env(ad, data.research.train[i], opts));
    const p = ctx.log.find((l) => l.kind === 'birth').prompt;
    assert(p.includes('<task>\n' + data.research.train[2].problem), 'current task');
    assert(p.includes(data.research.train[2].rubric.slice(0, 200)), 'rubric as the correct answer');
    assert(/>>> \[Step \d+\] \[Message from agent: /.test(p), 'source turns marked >>>');
  });

  await test('Frozen test: no money moves, no births, population unchanged', 'mas._eval_forward', async () => {
    const ev = []; const c = cfg({}); const { mas, ad, opts } = makeMas('research', c, stub(), ev, 1);
    const before = JSON.stringify(mas.population.get_all().map((a) => [a.id, a.wealth, a._bid]));
    await mas.eval().run_one_episode(env(ad, rtask, opts));
    assert(!ev.some((e) => ['pay', 'reward', 'path', 'rent', 'birth'].includes(e.type)));
    assert(JSON.stringify(mas.population.get_all().map((a) => [a.id, a.wealth, a._bid])) === before);
  });

  await test('Rubric judge parsing matches _parse_judge_response', 'researchworld/env.py', async () => {
    const P = C.parseJudge;
    near(P('SCORE: 0.734\nREASON: ok')[0], 0.734); near(P('score: 1.7')[0], 1); near(P('SCORE: abc')[0], 0); near(P('SCORE: 0.5, roughly')[0], 0.5);
    assert(P('SCORE: 0.2')[1] === 'Score 0.200 (no reason parsed).');
  });

  await test('MATH answers: Hendrycks normalisation', 'MATH is_equiv / strip_string', async () => {
    const E = C.isEquiv;
    assert(E('\\frac12', '\\frac{1}{2}') && E('0.5', '\\frac{1}{2}') && E('\\dfrac{3}{4}', '\\frac{3}{4}') && E('10^\\circ', '10') && E('x = 5', '5') && E('1/3', '\\frac{1}{3}') && E('\\sqrt2', '\\sqrt{2}'));
    assert(!E('3', '4') && !E(null, '4'));
    assert(C.lastBoxed('so \\boxed{\\frac{1}{2}} and \\boxed{7}') === '7' && C.lastBoxed('\\boxed{\\frac{a}{b}}') === '\\frac{a}{b}');
  });

  await test('MATH setup: three roles, the executor answers, replies cut at the token budget', 'paper Sec. 3.1 / App. D.2', async () => {
    const ev = [], long = 'x'.repeat(2000);
    const ctx = stub({ answer: mtask.answer, act: (r) => (r === 'executor' ? '<step>' + long + '</step><final_answer>\\boxed{' + mtask.answer + '}</final_answer>' : '<step>' + r + '</step>') });
    const c = cfg({ engine: { rent: 0, birth_interval: 0 } });
    const { mas, ad, opts } = makeMas('math', c, ctx, ev, 3, { maxActChars: 480, tokenBudget: 128, useJudge: false });
    assert(mas.population.get_all().map((a) => a.role).join() === 'planner,executor,verifier');
    await mas.train().run_one_episode(env(ad, mtask, opts));
    const acts = ev.filter((e) => e.type === 'act'), steps = ev.filter((e) => e.type === 'step:start');
    acts.forEach((a, i) => { if (!steps[i].terminal) assert(a.text.length <= 480, 'cut to budget'); });
    assert(acts.some((a) => a.role === 'executor' && !a.isFinal), 'a cut reply loses its final answer, like max_tokens would');
    const pl = mas.population.get_all().find((a) => a.role === 'planner').id;
    assert(ev.find((e) => e.type === 'wake:result' && e.id === pl).why === 'auto-start', 'planner self-starts (it still has to win the tie)');
  });

  await test('Trainer: periodic test every n tasks, resume from a checkpoint gives the same run', 'pipeline.Trainer.train + _save_progress', async () => {
    const presets = C.buildPresets(data), pre = presets.find((p) => p.key === 'quick');
    const mk = () => { const ctx = stub(); return ctx; };
    const runAll = async (stopAt) => {
      let st = C.newRunState(pre, data); let ctx = mk(); let tr = new C.Trainer(st, data, ctx, () => {});
      let n = 0; let saved = null;
      while (await tr.runTask()) { n++; if (n === stopAt) { saved = JSON.stringify(tr.checkpoint()); tr = new C.Trainer(JSON.parse(saved), data, ctx, () => {}); } }
      return tr.checkpoint();
    };
    const a = await runAll(-1), b = await runAll(6);
    assert(a.tests.length === 2, 'tested before training and after 15 tasks, got ' + a.tests.length);
    assert(a.tests[0].tasksCompleted === 0 && a.tests[1].tasksCompleted === 15);
    const strip = (s) => JSON.stringify({ m: s.mas, t: s.tests.map((x) => x.accuracy), n: s.tasksCompleted });
    assert(strip(a) === strip(b), 'resumed run differs');
  });

  await test('Presets: the exact preset uses every released value and all 40 + 19 tasks', 'train_research.json + adapter config', async () => {
    const p = C.buildPresets(data).find((x) => x.key === 'released');
    assert(JSON.stringify(p.mas) === JSON.stringify(C.RELEASED_RESEARCH_MAS));
    assert(p.trainIds.length === 40 && p.testIds.length === 19 && p.run.num_epochs === 2 && p.run.judge_threshold === 0.5);
    const m = C.buildPresets(data).find((x) => x.key === 'paperMath');
    assert(m.trainIds.length === 100 && m.mas.engine.bid_scheme === 'fixed_with_eps');
    const lv = m.trainIds.map((id) => data.math.train.find((t) => t.id === id).level); for (let i = 1; i < lv.length; i++) assert(lv[i] >= lv[i - 1], 'easy to hard');
  });

  const ok = results.filter((r) => r[0]).length;
  for (const r of results) console.log((r[0] ? 'PASS ' : 'FAIL ') + r[1] + '  (' + r[3] + ' ms)' + (r[0] ? '' : '\n     ' + r[4]));
  console.log('\n' + ok + '/' + results.length + ' passed');
  process.exitCode = ok === results.length ? 0 : 1;
})();
