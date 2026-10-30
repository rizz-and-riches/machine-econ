// The replica's page: presets, the Claude call queue, checkpoints, saved runs,
// replays and the animated floor. The engine itself is replica-core.js.
(function () {
'use strict';
const RC = window.EoMReplica, DATA = window.EoMReplicaData;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
const money = (x) => (x == null ? '-' : (x < 0 ? '-' : '') + Math.abs(x).toFixed(2));
const signed = (x) => (x >= 0 ? '+' : '-') + Math.abs(x).toFixed(2);
const pct = (x) => (x == null ? '-' : Math.round(x * 100) + '%');
const ROLE_COLOR = { literature: '#6f86aa', planner: '#5b7398', deriver: '#a3b4ce', executor: '#a3b4ce', verifier: '#c8d2e2', answer: '#eaedf3' };
const ROLE_LABEL = { literature: 'Literature', planner: 'Planner', deriver: 'Deriver', executor: 'Executor', verifier: 'Verifier', answer: 'Answer' };
const ROLE_JOB = { literature: 'lists the background facts', planner: 'plans the next step', deriver: 'does one derivation', executor: 'carries out one step', verifier: 'checks the latest step', answer: 'writes the final answer' };

const presets = RC.buildPresets(DATA);
const presetBy = (k) => presets.find((p) => p.key === k);
let presetKey = 'quick';
const ui = { tiers: { act: 'quick', wake: 'quick', judge: 'quick' }, conc: 2, ablate: { noAuction: false, noExploration: false, noExploitation: false }, knobs: {} };
let sampleFn = null, db = null, downloads = null;
let run = null;           // the live run
let replay = null;        // {id, stop}
const saved = { list: [] };

// ======================= presets and settings =======================
const KNOBS = [
  ['engine', 'rent', 'Rent'], ['engine', 'rent_interval', 'Rent every (tasks)'], ['engine', 'base_bid', 'Base bid'], ['engine', 'novice_bid_epsilon', 'Newcomer premium (epsilon)'],
  ['engine', 'initial_wealth', 'Starting credits'], ['engine', 'max_steps_per_episode', 'Turns per task'], ['engine', 'max_trials_per_episode', 'Tries per task'], ['engine', 'birth_interval', 'Births every (tasks)'],
  ['engine', 'num_births_per_interval', 'Births each time'], ['engine', 'max_num_agents', 'Most agents'], ['engine', 'bid_scheme', 'Bid rule', ['fixed', 'fixed_with_eps', 'holland']],
  ['evolution', 'p_a', 'After bankruptcy: copy chance'], ['evolution', 'p_b', 'After bankruptcy: repair chance'], ['evolution', 'periodical_good_p', 'Periodic births: copy share'],
  ['reward', 'terminal_output_bonus_scale', 'Answer bonus scale'], ['reward', 'path_reward_scale', 'Path reward scale'], ['evaluation', 'periodic_test_every_n_tasks', 'Test every (tasks)'],
];
const presetVal = (p, sec, key) => { const m = p.mas; const src = sec === 'evaluation' ? m.evaluation : sec === 'engine' ? m.engine : m[sec]; const c = RC.configFromDict(m); return src && src[key] !== undefined ? src[key] : c[sec][key]; };
function renderPresets() {
  const host = $('rpPresets'); host.innerHTML = '';
  for (const p of presets) {
    const b = document.createElement('button'); b.className = 'rp-preset'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(p.key === presetKey)); b.dataset.k = p.key;
    const tasks = p.trainIds.length * p.run.num_epochs;
    b.innerHTML = '<span class="tag ' + (p.key === 'released' ? 'exact' : '') + '">' + (p.key === 'released' ? 'Exact' : p.key === 'releasedLight' ? 'Exact training' : p.key === 'paperMath' ? 'Paper setup' : 'Short demo') + '</span><b>' + esc(p.label) + '</b><p>' + esc(p.blurb) + '</p><span class="est">' + tasks + ' training tasks, ' + p.testIds.length + ' test tasks. About ' + p.estCalls.toLocaleString() + ' model calls.</span>';
    b.addEventListener('click', () => { if (run && run.running) return; presetKey = p.key; ui.knobs = {}; renderPresets(); renderKnobs(); idleFloor(); });
    host.appendChild(b);
  }
}
function renderKnobs() {
  const p = presetBy(presetKey), host = $('rpKnobs'); host.innerHTML = '';
  for (const [sec, key, label, opts] of KNOBS) {
    const id = 'rk_' + sec + '_' + key, base = presetVal(p, sec, key), cur = ui.knobs[sec + '.' + key] !== undefined ? ui.knobs[sec + '.' + key] : base;
    const lab = document.createElement('label'); lab.htmlFor = id; lab.textContent = label;
    let inp;
    if (opts) { inp = document.createElement('select'); for (const o of opts) { const op = document.createElement('option'); op.value = o; op.textContent = o; inp.appendChild(op); } inp.value = cur; }
    else { inp = document.createElement('input'); inp.type = 'number'; inp.step = 'any'; inp.value = cur; }
    inp.id = id; if (cur !== base) inp.classList.add('changed');
    inp.addEventListener('change', () => { const v = opts ? inp.value : parseFloat(inp.value); if (v === base || (typeof v === 'number' && isNaN(v))) delete ui.knobs[sec + '.' + key]; else ui.knobs[sec + '.' + key] = v; renderKnobs(); });
    lab.appendChild(inp); host.appendChild(lab);
  }
  advNote();
}
function advNote() {
  const ch = Object.keys(ui.knobs), ab = Object.entries(ui.ablate).filter(([, v]) => v).map(([k]) => k);
  const tiersChanged = ui.tiers.act !== 'quick' || ui.tiers.wake !== 'quick' || ui.tiers.judge !== 'quick';
  $('rpAdvNote').innerHTML = (ch.length || ab.length)
    ? '<b class="brass">Variant:</b> changed from the preset: ' + esc(ch.concat(ab.map((a) => ({ noAuction: 'no auction', noExploration: 'no exploration', noExploitation: 'no exploitation' }[a]))).join(', ')) + '. Runs save with these settings.'
    : 'Nothing changed from the preset. ' + (tiersChanged ? 'Model tiers changed.' : 'All model calls use the quick tier, the closest Claude gets to the paper\'s small models.');
}
function buildPreset() {
  const p = JSON.parse(JSON.stringify(presetBy(presetKey)));
  for (const [k, v] of Object.entries(ui.knobs)) { const [sec, key] = k.split('.'); const target = sec === 'evaluation' ? (p.mas.evaluation = p.mas.evaluation || {}) : (p.mas[sec] = p.mas[sec] || {}); target[key] = v; }
  const ab = Object.entries(ui.ablate).filter(([, v]) => v);
  if (ab.length) p.mas.page = Object.fromEntries(ab);
  p.seed = (Date.now() % 2147483647) >>> 0;
  p.label = p.label + (Object.keys(ui.knobs).length || ab.length ? ' (variant)' : '');
  return p;
}
function bindSettings() {
  $('rpTierAct').addEventListener('change', (e) => { ui.tiers.act = e.target.value; advNote(); });
  $('rpTierWake').addEventListener('change', (e) => { ui.tiers.wake = e.target.value; advNote(); });
  $('rpTierJudge').addEventListener('change', (e) => { ui.tiers.judge = e.target.value; advNote(); });
  $('rpConc').addEventListener('change', (e) => { ui.conc = +e.target.value; });
  const sw = (id, key) => $(id).addEventListener('click', () => { const on = $(id).getAttribute('aria-checked') !== 'true'; $(id).setAttribute('aria-checked', String(on)); ui.ablate[key] = on; advNote(); });
  sw('rpNoAuction', 'noAuction'); sw('rpNoExplore', 'noExploration'); sw('rpNoExploit', 'noExploitation');
}

// ======================= Claude call queue =======================
const gate = { active: 0, waiting: [] };
const acquire = () => new Promise((r) => { if (gate.active < ui.conc) { gate.active++; r(); } else gate.waiting.push(r); });
const release = () => { const n = gate.waiting.shift(); if (n) n(); else gate.active--; };
const stopErr = () => ({ code: 'stopped' });
async function ask(kind, prompt, opts) {
  opts = opts || {};
  const sig = run && run.abort.signal;
  if (sig && sig.aborted) throw stopErr();
  await acquire();
  try {
    if (sig && sig.aborted) throw stopErr();
    for (let tries = 0; ; tries++) {
      try {
        const tier = ui.tiers[kind === 'birth' ? 'act' : kind] || 'quick';
        const r = await sampleFn(prompt, { modelTier: tier, cache: false, signal: sig, onText: opts.onText ? (u) => opts.onText(u.text) : undefined });
        countCall(); return (r && r.text) || '';
      } catch (e) {
        if (e && e.code === 'cancelled') throw stopErr();
        if (e && (e.code === 'empty_completion' || e.code === 'refused')) { countCall(); return ''; }
        if (e && e.code === 'upstream_error' && tries < 1) { await sleep(4000); continue; }
        throw e;
      }
    }
  } finally { release(); }
}
function countCall() { if (run) { run.state.calls = (run.state.calls || 0) + 1; run.callsThisSession++; } meters(); }

// ======================= saving (db) =======================
let saveChain = Promise.resolve(), dbOk = true;
const pad = (n) => String(n).padStart(5, '0');
function queueSave(fn) { if (!db || !dbOk) return; saveChain = saveChain.then(fn).catch((e) => { if (e && (e.code === 'invalid_argument' || e.code === 'not_granted' || e.code === 'revoked')) { dbOk = false; $('rpRunsNote').textContent = 'This view cannot save runs, so this run lives only in this tab.'; } }); }
function fit(str, max) { return str.length <= max ? str : str.slice(0, Math.floor(max * 0.6)) + '\n[... cut to fit storage ...]\n' + str.slice(str.length - Math.floor(max * 0.35)); }
function shrinkEvents(events) {
  let lim = 6000, js;
  for (;;) {
    const ev = events.map((e) => (e.type === 'act' ? Object.assign({}, e, { text: fit(e.text || '', lim) }) : e.type === 'judge' ? Object.assign({}, e, { answer: fit(e.answer || '', lim) }) : e.type === 'task:start' ? Object.assign({}, e, { task: Object.assign({}, e.task, { problem: fit(e.task.problem || '', lim * 2) }), agents: e.agents.map(trimAgent) }) : e.type === 'task:end' ? Object.assign({}, e, { agents: e.agents.map(trimAgent) }) : e));
    js = JSON.stringify(ev); if (js.length < 230000 || lim < 300) return js; lim = Math.floor(lim / 2);
  }
}
const trimAgent = (a) => Object.assign({}, a, { trainable: (a.trainable || '').slice(0, 3000), frozen: (a.frozen || '').slice(0, 1500) });
const agentHash = new Map();
function saveCheckpoint(stateJson) {
  if (!run) return;
  const id = run.id, st = JSON.parse(stateJson), pop = st.mas.population;
  const ids = pop.map((a) => a.id);
  const lite = Object.assign({}, st, { mas: Object.assign({}, st.mas, { population: null, initial: st.mas.initial.map((a) => Object.assign({}, a, { recent_failure_trace: '', recent_failure_task: '', recent_failure_answer: '', _death_trace: '' })) }), agentIds: ids, tests: st.tests.map((t) => Object.assign({}, t, { results: undefined })) });
  const summary = runSummary(st);
  queueSave(async () => {
    for (const a of pop) {
      let js = JSON.stringify(a);
      if (js.length > 240000) { a.recent_failure_trace = fit(a.recent_failure_trace || '', 120000); a._death_trace = fit(a._death_trace || '', 40000); js = JSON.stringify(a); }
      if (agentHash.get(id + ':' + a.id) === js) continue;
      await db.doc('runs/' + id + '/agents/' + a.id).set({ json: js }); agentHash.set(id + ':' + a.id, js);
    }
    await db.doc('runs/' + id + '/ckpt/state').set({ json: JSON.stringify(lite) });
    await db.doc('runs/' + id).set(summary);
  });
}
function runSummary(st) {
  const p = presetBy(st.preset) || {};
  return { label: st.label || p.label || st.preset, preset: st.preset, adapter: st.adapter, created: run.created, updated: Date.now(), status: st.done ? 'done' : run.running ? 'running' : 'stopped', tasksCompleted: st.tasksCompleted, totalTasks: st.trainIds.length * st.numEpochs, calls: st.calls || 0, pop: st.mas ? st.mas.population.length : null, tests: st.tests.map((t) => ({ tasksCompleted: t.tasksCompleted, accuracy: t.accuracy, avgScore: t.avgScore, success: t.success, total: t.total })), tiers: Object.assign({}, ui.tiers), births: st.births || 0, variant: !!(st.cfg.page) || /variant/.test(st.label || ''), bankruptcies: st.mas ? st.mas.bankruptcy_count : 0 };
}
async function loadRunState(id) {
  const ck = await db.doc('runs/' + id + '/ckpt/state').get(); if (!ck.exists) throw new Error('no checkpoint');
  const st = JSON.parse(ck.data().json);
  const pop = [];
  for (const aid of st.agentIds) { const d = await db.doc('runs/' + id + '/agents/' + aid).get(); if (d.exists) { const js = d.data().json; pop.push(JSON.parse(js)); agentHash.set(id + ':' + aid, js); } }
  st.mas.population = pop; delete st.agentIds;
  const tests = await db.collection('runs/' + id + '/tests').get();
  const full = new Map(tests.docs.map((d) => { const t = JSON.parse(d.data().json); return [t.tasksCompleted, t]; }));
  st.tests = st.tests.map((t) => full.get(t.tasksCompleted) || t);
  return st;
}
async function listRuns() {
  if (!db) { renderRuns(); return; }
  try { const snap = await db.collection('runs').orderBy('updated', 'desc').limit(40).get(); saved.list = snap.docs.map((d) => Object.assign({ id: d.id }, d.data())); }
  catch (e) { saved.list = []; }
  renderRuns();
}
function renderReport() {
  const host = $('rpReport'); if (!host) return;
  const withTests = saved.list.filter((r) => r.tests && r.tests.length);
  const pick = withTests.find((r) => r.status === 'done') || withTests[0];
  if (!pick) {
    host.innerHTML = '<div class="panel empty"><div><span class="kicker">Completed real run</span><p style="margin-top:6px">' + (db ? 'No real run saved yet. Pick <b>Quick look</b> below and press Start. When it finishes, its before-and-after score, prompt rewrites and every payment show up here, and anyone with the link can replay it for free.' : 'Saved real runs show here when the page is opened on claude.ai or in the Claude app.') + '</p></div></div>';
    return;
  }
  const f = pick.tests[0], l = pick.tests[pick.tests.length - 1], best = pick.tests.reduce((m, t) => Math.max(m, t.accuracy), 0);
  const d = l.accuracy - f.accuracy, sc = pick.adapter === 'research' && l.avgScore != null;
  host.innerHTML = '<div class="panel"><div><span class="kicker">' + (pick.status === 'done' ? 'Completed real run' : 'Latest real run (unfinished)') + '</span><h3 style="margin-top:4px">' + esc(pick.label) + '</h3><p class="muted" style="margin-top:2px">' + new Date(pick.created || pick.updated).toLocaleDateString() + ' · Claude agents · ' + pick.tasksCompleted + ' of ' + pick.totalTasks + ' training tasks</p>'
    + '<div class="row" style="margin-top:12px;align-items:baseline;gap:14px"><span class="big">' + pct(f.accuracy) + ' <span class="muted">&rarr;</span> ' + pct(l.accuracy) + '</span><span class="' + (d < 0 ? 'bad' : 'muted') + '">' + (pick.tests.length < 2 ? 'only one test so far' : (d >= 0 ? '+' : '') + Math.round(d * 100) + ' points, test pass rate before and after training') + '</span></div>'
    + (sc ? '<p class="muted" style="margin-top:6px">Average rubric score ' + f.avgScore.toFixed(2) + ' to ' + l.avgScore.toFixed(2) + '</p>' : '') + '</div>'
    + '<div><div class="facts"><div><span>Best test</span><b>' + pct(best) + '</b></div><div><span>Prompt rewrites</span><b>' + (pick.births != null ? pick.births : '-') + '</b></div><div><span>Bankruptcies</span><b>' + (pick.bankruptcies || 0) + '</b></div><div><span>Model calls</span><b>' + (pick.calls || 0).toLocaleString() + '</b></div></div>'
    + '<p class="cap">' + l.success + ' of ' + l.total + ' test tasks passed at the end. One run swings a lot, which is why the paper reports both the mean and the best of several runs.</p>'
    + '<div class="row" style="margin-top:10px"><button class="btn primary" id="rpRepWatch">Watch this run</button><button class="btn" id="rpRepDl">Download</button></div></div></div>';
  $('rpRepWatch').addEventListener('click', () => { startReplay(pick.id); document.querySelector('.rp-stage').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' }); });
  $('rpRepDl').addEventListener('click', () => exportRun(pick.id));
}
function renderRuns() {
  renderReport();
  const ul = $('rpRuns'); ul.innerHTML = '';
  if (!db) { ul.innerHTML = '<li class="muted" style="display:block">Saved runs need this page opened on claude.ai or in the Claude app, signed in.</li>'; return; }
  if (!saved.list.length) { ul.innerHTML = '<li class="muted" style="display:block">No saved runs yet. The first run you start appears here.</li>'; return; }
  for (const r of saved.list) {
    const li = document.createElement('li'); const last = r.tests && r.tests.length ? r.tests[r.tests.length - 1] : null, first = r.tests && r.tests.length ? r.tests[0] : null;
    li.innerHTML = '<div><b>' + esc(r.label) + '</b><small>' + new Date(r.created || r.updated).toLocaleString() + ' · ' + r.tasksCompleted + ' of ' + r.totalTasks + ' tasks · ' + (r.status === 'done' ? 'finished' : 'paused') + ' · ' + (r.calls || 0).toLocaleString() + ' calls</small><small>' + (last ? 'Test: ' + (first && first !== last ? pct(first.accuracy) + ' to ' : '') + pct(last.accuracy) + (last.avgScore != null && r.adapter === 'research' ? ' (avg judge score ' + last.avgScore.toFixed(2) + ')' : '') : 'No test yet') + '</small></div><div class="acts"></div>';
    const acts = li.querySelector('.acts');
    const mk = (t, fn, primary) => { const b = document.createElement('button'); b.className = 'btn' + (primary ? ' primary' : ''); b.textContent = t; b.addEventListener('click', fn); acts.appendChild(b); return b; };
    mk('Watch', () => startReplay(r.id), false);
    if (r.status !== 'done') mk('Resume', () => resumeRun(r.id), false).disabled = !sampleFn || !!(run && run.running);
    mk('Download', () => exportRun(r.id));
    ul.appendChild(li);
  }
}

// ======================= running =======================
function status(html) { $('rpStatus').innerHTML = html; }
function setRunning(on) {
  $('rpStart').disabled = on || !sampleFn; $('rpStopSoft').disabled = !on; $('rpStopHard').disabled = !on;
  $('rpPresets').querySelectorAll('button').forEach((b) => (b.disabled = on));
  renderRuns();
}
function meters() {
  const st = run && (run.running || view.mode === 'live') ? run.state : null;
  $('rpMCalls').textContent = st ? (st.calls || 0).toLocaleString() : (view.replayCalls != null ? view.replayCalls.toLocaleString() : '0');
  if (st) {
    $('rpMTasks').textContent = st.tasksCompleted + ' / ' + st.trainIds.length * st.numEpochs;
    const lt = st.tests[st.tests.length - 1]; $('rpMScore').textContent = lt ? pct(lt.accuracy) : '-';
  }
  $('rpMPop').textContent = view.agents.size || '-';
  $('rpMBk').textContent = view.bankruptcies;
}
async function startNew() {
  if (!sampleFn || (run && run.running)) return;
  stopReplay();
  const p = buildPreset();
  const st = RC.newRunState(p, DATA); st.label = p.label; st.calls = 0;
  const id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await go(id, st, Date.now());
}
async function resumeRun(id) {
  if (!sampleFn || (run && run.running)) return;
  stopReplay(); status('Loading the saved checkpoint...');
  let st; try { st = await loadRunState(id); } catch (e) { status('Could not load that run: ' + esc((e && (e.code || e.message)) || e)); return; }
  const meta = saved.list.find((r) => r.id === id) || {};
  if (meta.tiers) { ui.tiers = Object.assign({}, meta.tiers); $('rpTierAct').value = ui.tiers.act; $('rpTierWake').value = ui.tiers.wake; $('rpTierJudge').value = ui.tiers.judge; }
  await go(id, st, meta.created || Date.now());
}
async function go(id, st, created) {
  run = { id, state: st, created, abort: new AbortController(), stopSoft: false, running: true, lastCkpt: JSON.stringify(st), record: null, callsThisSession: 0, taskCalls: [] };
  resetView(st.adapter, st.cfg); view.mode = 'live';
  for (const t of st.tests) chartAdd(t);
  setRunning(true); $('rpExport').disabled = false;
  status('Running <b>' + esc(st.label) + '</b>. Your first call asks for permission to use Claude.');
  const ctx = { ask, shouldStop: () => run.abort.signal.aborted };
  const trainer = new RC.Trainer(JSON.parse(run.lastCkpt), DATA, ctx, onEvent);
  run.trainer = trainer; run.state = trainer.state;
  run.lastCkpt = JSON.stringify(trainer.checkpoint()); saveCheckpoint(run.lastCkpt);
  feed({ type: 'agents:sync', agents: trainer.mas.population.get_all().map(RC.summarize) });
  let callsAtTask = st.calls || 0;
  for (;;) {
    if (run.stopSoft) { status('Stopped after a finished task. Resume it from Saved runs.'); break; }
    let more;
    try { more = await trainer.runTask(); }
    catch (e) {
      const callsMade = run.state.calls || 0;
      run.state = JSON.parse(run.lastCkpt); run.state.calls = callsMade; run.lastCkpt = JSON.stringify(run.state);
      const code = e && e.code;
      const msg = code === 'stopped' ? 'Stopped. The unfinished task was thrown away, so the run resumes from the last finished task, like the code\'s checkpoints.'
        : code === 'rate_limited' ? 'Claude\'s limit for this page was reached. The run is saved. Resume it later from Saved runs.'
        : code === 'not_granted' ? 'Permission to use Claude was not given, so nothing ran.'
        : code === 'session_expired' ? 'Your sign-in expired. Sign in again, then resume from Saved runs.'
        : code === 'sampling_disabled' ? 'Claude is not available for this account.'
        : 'The run stopped on an error: ' + esc((e && (e.message || code)) || e) + '. It is saved at the last finished task.';
      status(msg); feed({ type: 'sys', text: msg });
      break;
    }
    saveChain.then(listRuns);
    const used = (run.state.calls || 0) - callsAtTask; callsAtTask = run.state.calls || 0; run.taskCalls.push(used);
    if (!more) { run.state.done = true; run.lastCkpt = JSON.stringify(run.state); status('Finished <b>' + esc(run.state.label) + '</b>: ' + run.state.tasksCompleted + ' training tasks, ' + (run.state.calls || 0).toLocaleString() + ' model calls.'); break; }
    const left = run.state.trainIds.length * run.state.numEpochs - run.state.tasksCompleted;
    const avg = run.taskCalls.reduce((a, b) => a + b, 0) / run.taskCalls.length;
    status('Running <b>' + esc(run.state.label) + '</b>. ' + left + ' training tasks left, roughly ' + Math.round(avg * left).toLocaleString() + ' more calls at the current rate (tests add more).');
  }
  run.running = false; saveCheckpoint(run.lastCkpt);
  await saveChain; setRunning(false); listRuns();
}
function onEvent(type, p) {
  if (!run) return;
  const ev = Object.assign({ type }, p);
  if (type === 'birth') run.state.births = (run.state.births || 0) + 1;
  if (type === 'checkpoint') { run.lastCkpt = JSON.stringify(p); saveCheckpoint(run.lastCkpt); return; }
  if (type === 'task:start' && p.mode === 'train') run.record = [];
  if (run.record && type !== 'act:text' && type !== 'test:event' && !type.startsWith('test')) run.record.push(ev);
  if (type === 'task:end' && run.record) {
    const rec = run.record, n = p.tasksCompleted, id = run.id; run.record = null;
    const js = shrinkEvents(rec); queueSave(() => db.doc('runs/' + id + '/episodes/' + pad(n)).set({ json: js }));
  }
  if (type === 'test:end') { const id = run.id, js = JSON.stringify(p); queueSave(() => db.doc('runs/' + id + '/tests/' + pad(p.tasksCompleted)).set({ json: js.length > 240000 ? JSON.stringify(Object.assign({}, p, { results: p.results.map((r) => Object.assign({}, r, { answer: (r.answer || '').slice(0, 400) })) })) : js })); }
  if (type === 'test:event') return;
  feed(ev);
}
async function exportRun(id) {
  let out;
  try {
    if (run && run.id === id) out = { summary: runSummary(run.state), state: JSON.parse(run.lastCkpt) };
    else out = { summary: saved.list.find((r) => r.id === id), state: await loadRunState(id) };
    const eps = await db.collection('runs/' + id + '/episodes').get();
    out.episodes = eps.docs.map((d) => ({ task: d.id, events: JSON.parse(d.data().json) }));
  } catch (e) { if (!out) { status('Could not read that run.'); return; } }
  const data = JSON.stringify(out, null, 1), name = 'eom-replica-' + id + '.json';
  try { if (downloads) { await downloads.save({ filename: name, data }); return; } } catch (e) { if (e && e.code !== 'unavailable') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' })); a.download = name; a.click();
}

// ======================= replay =======================
let replaySpeed = 1;
async function startReplay(id) {
  if (run && run.running) { status('Stop the live run first.'); return; }
  stopReplay();
  const me = { id, stop: false }; replay = me;
  status('Loading the saved run...');
  let eps, tests, meta = saved.list.find((r) => r.id === id) || {};
  try {
    const e = await db.collection('runs/' + id + '/episodes').get(); eps = e.docs.map((d) => ({ n: +d.id, events: JSON.parse(d.data().json) })).sort((a, b) => a.n - b.n);
    const t = await db.collection('runs/' + id + '/tests').get(); tests = t.docs.map((d) => JSON.parse(d.data().json)).sort((a, b) => a.tasksCompleted - b.tasksCompleted);
  } catch (err) { status('Could not load that run.'); return; }
  if (me.stop) return;
  const ad = meta.adapter || 'math', cfg = RC.configFromDict(presetBy(meta.preset) ? presetBy(meta.preset).mas : RC.RELEASED_RESEARCH_MAS);
  clearQueue(); view.mode = 'replay'; resetView(ad, cfg); view.mode = 'replay'; view.replayCalls = meta.calls || 0; $('rpMTasks').textContent = '0 / ' + (meta.totalTasks || '?'); $('rpMScore').textContent = '-'; meters();
  status('Watching <b>' + esc(meta.label || id) + '</b> (' + eps.length + ' tasks saved). Nothing is being called, this is a recording.');
  const pre = tests.filter((t) => t.tasksCompleted === 0); for (const t of pre) { chartAdd(t); }
  for (const ep of eps) {
    for (const ev of ep.events) { if (me.stop) return; await feedAwait(ev); }
    for (const t of tests.filter((x) => x.tasksCompleted === ep.n)) { if (me.stop) return; await feedAwait({ type: 'test:replay', rec: t }); }
  }
  if (!me.stop) { feed({ type: 'sys', text: 'End of the recording.' }); status('Finished replaying <b>' + esc(meta.label || id) + '</b>.'); }
}
function clearQueue() { for (const ev of rq.splice(0)) if (ev._done) ev._done(); }
function stopReplay() { if (replay) { replay.stop = true; replay = null; } clearQueue(); }

// ======================= the floor (renderer) =======================
const view = { agents: new Map(), roles: [], adapter: 'math', cfg: null, voidTotal: 0, bankruptcies: 0, step: 0, maxSteps: 10, mode: 'idle', streamEl: null, lastWinner: null, replayCalls: null };
const rq = []; let rbusy = false, rwaiters = [];
function feed(ev) { rq.push(ev); pump(); }
function feedAwait(ev) { return new Promise((r) => { ev._done = r; feed(ev); }); }
async function pump() {
  if (rbusy) return; rbusy = true;
  while (rq.length) {
    const ev = rq.shift();
    if (ev.type === 'act:text' && rq.length && rq[0].type === 'act:text' && rq[0].id === ev.id) continue; // keep only the latest stream text
    let d = 0; try { d = apply(ev) || 0; } catch (e) { console.error(e); }
    const sp = view.mode === 'replay' ? replaySpeed : 1;
    if (d && !reduceMotion && !(view.mode === 'live' && rq.length > 50)) await sleep(view.mode === 'live' ? Math.min(d, rq.length > 6 ? 120 : d) : d / sp);
    if (ev._done) ev._done();
  }
  rbusy = false;
}
function resetView(adapter, cfg) {
  view.agents.clear(); view.adapter = adapter; view.cfg = cfg; view.voidTotal = 0; view.bankruptcies = 0; view.step = 0; view.maxSteps = cfg.engine.max_steps_per_episode; view.replayCalls = null;
  view.roles = RC.ADAPTERS[adapter].roles.map((r) => r.role);
  const host = $('rpRoles'); host.innerHTML = ''; host.style.setProperty('--cols', view.roles.length);
  for (const r of view.roles) { const col = document.createElement('div'); col.className = 'rp-col'; col.dataset.role = r; col.style.setProperty('--role', ROLE_COLOR[r]); col.innerHTML = '<h4 title="' + esc(ROLE_JOB[r]) + '">' + ROLE_LABEL[r] + '</h4>'; host.appendChild(col); }
  $('rpBoard').innerHTML = ''; $('rpLedger').innerHTML = ''; $('rpBirths').innerHTML = '<p class="muted">New agents show up here with their prompt before and after. Brass lines are new.</p>';
  $('rpVoid').querySelector('b').textContent = '0.00'; $('rpJudge').querySelector('b').textContent = '-';
  $('rpRentAmt').textContent = money(cfg.engine.rent); $('rpRentSub').textContent = 'every ' + cfg.engine.rent_interval + ' tasks';
  $('rpTestWall').hidden = true; $('rpPop').hidden = true;
  chart.points = []; drawChart(); turns(-1, false); meters();
}
function idleFloor() {
  if ((run && run.running) || replay) return;
  const p = presetBy(presetKey), cfg = RC.configFromDict(p.mas); resetView(p.adapter, cfg); view.mode = 'idle';
  const ids = { counter: 0 };
  for (const spec of RC.ADAPTERS[p.adapter].roles) { const a = new RC.Agent(spec, ids); a.initialize(cfg.engine.initial_wealth); upsertAgent(RC.summarize(a)); }
  $('rpMode').textContent = 'Ready'; $('rpMode').className = 'rp-mode';
  $('rpTaskTitle').textContent = p.label; $('rpTaskSub').textContent = (p.adapter === 'research' ? 'FrontierScience-Research tasks' : 'MATH problems') + ', ' + p.trainIds.length * p.run.num_epochs + ' training tasks';
  $('rpProblem').innerHTML = '<p class="muted">The starting team: one agent per role, each with its role prompt from ' + (p.adapter === 'research' ? 'the released code' : 'the paper\'s description') + ' and ' + money(cfg.engine.initial_wealth) + ' credits. Tap a card to read its prompt.</p>';
  narr('Press <b>Start</b> to run this experiment with real Claude agents, or watch a saved run below.');
  meters();
}
function narr(html) { $('rpNarr').innerHTML = html; }
function turns(now, terminal) {
  const host = $('rpTurns'); let h = '';
  for (let i = 0; i < view.maxSteps; i++) h += '<i class="' + (i < now ? 'done' : i === now ? 'now' : '') + (i === view.maxSteps - 1 && view.cfg && view.cfg.terminal.enabled ? ' term' : '') + '"></i>';
  host.innerHTML = h + '<span>' + (now >= 0 ? 'turn ' + (now + 1) + ' of ' + view.maxSteps + (terminal ? ', last' : '') : view.maxSteps + ' turns') + '</span>';
}
const nameOf = (id) => (view.agents.get(id) || { name: '#' + id }).name;
function upsertAgent(s) {
  let a = view.agents.get(s.id);
  if (!a) { a = Object.assign({}, s); a.el = makeCard(a); view.agents.set(s.id, a); const col = $('rpRoles').querySelector('[data-role="' + s.role + '"]'); if (col) col.appendChild(a.el); }
  else Object.assign(a, s, { el: a.el });
  paintCard(a); return a;
}
function makeCard(a) {
  const b = document.createElement('button'); b.className = 'ag'; b.type = 'button';
  b.innerHTML = '<span class="nm"></span><span class="mo"><span class="bar"><i></i></span><span class="w num"></span></span><span class="bd"></span><span class="lamp" aria-hidden="true"></span>';
  b.addEventListener('click', () => showAgent(a.id));
  return b;
}
function paintCard(a) {
  const el = a.el; if (!el) return;
  el.querySelector('.nm').textContent = a.name; el.title = a.name + ', ' + ROLE_LABEL[a.role];
  const maxW = Math.max(1, ...[...view.agents.values()].map((x) => x.wealth || 0));
  const bar = el.querySelector('.bar i'); bar.style.width = Math.max(2, Math.min(100, (Math.abs(a.wealth) / maxW) * 100)) + '%'; bar.classList.toggle('neg', a.wealth < 0);
  el.querySelector('.w').textContent = money(a.wealth);
  el.querySelector('.w').style.color = a.wealth < 0 ? 'var(--fail)' : '';
  const e = view.cfg ? view.cfg.engine : null;
  el.querySelector('.bd').textContent = a.status === 'novice' ? (e && e.bid_scheme === 'fixed' ? 'new, enters at ' + money(e.base_bid + e.novice_bid_epsilon) : 'new, enters at top bid + ' + money(e ? e.novice_bid_epsilon : 0)) : 'bid ' + money(a.bid);
}
function repaintAll() { for (const a of view.agents.values()) paintCard(a); meters(); }
function cls(id, add, remove) { const a = view.agents.get(id); if (!a || !a.el) return; (remove || []).forEach((c) => a.el.classList.remove(c)); (add || []).forEach((c) => a.el.classList.add(c)); }
function clearTurnClasses() { for (const a of view.agents.values()) a.el && a.el.classList.remove('checking', 'awake', 'asleep', 'winner', 'acting'); }
function center(el) { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, vis: r.bottom > 0 && r.top < innerHeight }; }
function coin(fromEl, toEl, label, neg) {
  if (reduceMotion || !fromEl || !toEl) return;
  const a = center(fromEl), b = center(toEl); if (!a.vis && !b.vis) return;
  const c = document.createElement('div'); c.className = 'coin' + (neg ? ' neg' : ''); if (label) c.innerHTML = '<small>' + esc(label) + '</small>';
  document.body.appendChild(c);
  const mx = (a.x + b.x) / 2, my = Math.min(a.y, b.y) - 50;
  const anim = c.animate([{ transform: 'translate(' + a.x + 'px,' + a.y + 'px) scale(.6)', opacity: 0 }, { transform: 'translate(' + mx + 'px,' + my + 'px) scale(1.1)', opacity: 1, offset: 0.5 }, { transform: 'translate(' + b.x + 'px,' + b.y + 'px) scale(.8)', opacity: 0.2 }], { duration: 700 / (view.mode === 'replay' ? Math.min(replaySpeed, 3) : 1), easing: 'ease-in-out' });
  anim.onfinish = () => c.remove();
}
const cardEl = (id) => { const a = view.agents.get(id); return a && a.el; };
function ledger(text, neg, sep) { const li = document.createElement('li'); li.textContent = text; if (neg) li.className = 'neg'; if (sep) li.className = 'sep'; const ol = $('rpLedger'); ol.appendChild(li); while (ol.children.length > 400) ol.removeChild(ol.firstChild); ol.scrollTop = ol.scrollHeight; }
function boardMsg(kind, html, role) {
  const b = $('rpBoard'), d = document.createElement('div'); d.className = 'msg ' + (kind || ''); if (role) d.style.setProperty('--role', ROLE_COLOR[role]); d.innerHTML = html;
  const atBottom = b.scrollHeight - b.scrollTop - b.clientHeight < 60; b.appendChild(d); while (b.children.length > 80) b.removeChild(b.firstChild); if (atBottom || view.mode !== 'idle') b.scrollTop = b.scrollHeight; return d;
}
function splitAction(raw) {
  const sm = /<step>([\s\S]*?)<\/step>/i.exec(raw || ''), fm = /<final_answer>([\s\S]*?)<\/final_answer>/i.exec(raw || '');
  const open = /<step>([\s\S]*)$/i.exec(raw || '');
  return { step: sm ? sm[1].trim() : open && !sm ? open[1].replace(/<\/?step>?/gi, '').trim() : (raw || '').replace(/<final_answer>[\s\S]*$/i, '').trim(), final: fm ? fm[1].trim() : null };
}
function msgBody(raw) {
  const p = splitAction(raw);
  return '<div class="t">' + esc(p.step) + '</div>' + (p.final != null ? '<div class="t" style="margin-top:6px;border-top:1px solid var(--line);padding-top:6px"><b>Final answer:</b>\n' + esc(p.final) + '</div>' : '');
}
function addMore(d) { const t = d.querySelector('.t'); if (t && t.scrollHeight > t.clientHeight + 8 && !d.querySelector('.more')) { const m = document.createElement('button'); m.className = 'more'; m.textContent = 'Show all'; m.addEventListener('click', () => { d.classList.toggle('open'); m.textContent = d.classList.contains('open') ? 'Show less' : 'Show all'; }); d.appendChild(m); } }
function math(el) { try { if (window.renderMathInElement) window.renderMathInElement(el, { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '\\[', right: '\\]', display: true }, { left: '\\(', right: '\\)', display: false }, { left: '$', right: '$', display: false }], throwOnError: false, output: 'mathml', ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'button'] }); } catch (e) { /* plain text is fine */ } }
function lineDiff(before, after) {
  const bl = (before || '').split('\n'), al = (after || '').split('\n'), bs = new Set(bl.map((x) => x.trim())), as = new Set(al.map((x) => x.trim()));
  let h = ''; for (const l of bl) if (!as.has(l.trim()) && l.trim()) h += '<div class="del">' + esc(l) + '</div>';
  for (const l of al) h += '<div class="' + (bs.has(l.trim()) ? 'keep' : 'add') + '">' + esc(l || ' ') + '</div>';
  return h;
}

function apply(ev) {
  const live = view.mode === 'live', rp = view.mode === 'replay';
  switch (ev.type) {
    case 'agents:sync': for (const s of ev.agents) upsertAgent(s); repaintAll(); return 0;
    case 'sys': boardMsg('sys', esc(ev.text)); return 0;
    case 'task:start': {
      const t = ev.task, tot = (run ? run.state.trainIds.length : null);
      $('rpMode').textContent = rp ? 'Replay' : 'Training'; $('rpMode').className = 'rp-mode ' + (rp ? 'replay' : 'train');
      $('rpTaskTitle').textContent = 'Task ' + (ev.index + 1) + ' of ' + ev.of + (ev.epoch != null ? ', epoch ' + (ev.epoch + 1) : '');
      $('rpTaskSub').textContent = (t.level ? 'Level ' + t.level + ' ' : '') + (t.subject || '') + ' · episode ' + ev.episode + (tot ? '' : '');
      const prob = $('rpProblem'); prob.classList.remove('open');
      prob.innerHTML = '<div>' + esc(t.problem) + '</div>' + (t.expected ? '<details class="exp"><summary>Reference answer</summary>' + esc(t.expected) + '</details>' : '<p class="exp">Scored by the rubric judge (pass at ' + (view.cfg ? '0.5' : '0.5') + ').</p>');
      prob.onclick = (e) => { if (e.target.closest('details')) return; prob.classList.toggle('open'); };
      math(prob);
      const keep = new Set(ev.agents.map((a) => a.id)); for (const [id, a] of view.agents) if (!keep.has(id)) { a.el && a.el.remove(); view.agents.delete(id); }
      for (const s of ev.agents) upsertAgent(s); repaintAll();
      $('rpBoard').innerHTML = ''; boardMsg('sys', 'Task ' + (ev.index + 1) + ' starts with ' + ev.agents.length + ' agents. Everyone sees this shared workspace.');
      ledger('Task ' + (ev.index + 1) + (ev.epoch ? ' (epoch ' + (ev.epoch + 1) + ')' : ''), false, true);
      turns(-1, false); narr('New task. <b>' + ev.agents.length + '</b> agents. Each turn, every agent first decides whether to wake up.');
      return rp ? 900 : 300;
    }
    case 'trial':
      if (ev.trial > 1) { boardMsg('sys', 'Replay, try ' + ev.trial + ' of ' + ev.of + ': someone went bankrupt, so the survivors got their credits back and the task starts again (Alg. 1).'); ledger('Try ' + ev.trial + ': replay', false, true); narr('<span class="bad">Bankruptcy</span>, so the task is replayed. Survivors keep their bids but get their credits back.'); $('rpBoard').querySelectorAll('.msg:not(.sys)').forEach((m) => (m.style.opacity = 0.45)); }
      return rp ? 600 : 0;
    case 'step:start': view.step = ev.step; clearTurnClasses(); turns(ev.step, ev.terminal); narr(ev.terminal ? 'Last turn: no wake-up checks. Only agents tagged "terminal" (the ' + ROLE_LABEL[RC.ADAPTERS[view.adapter].terminalRole].toLowerCase() + ' agents) may bid.' : 'Turn <b>' + (ev.step + 1) + '</b>. Each agent reads the workspace and its own prompt, and decides whether to wake up.'); return rp ? 250 : 0;
    case 'wake:start': for (const id of ev.ids) cls(id, ['checking'], ['awake', 'asleep', 'winner']); return 0;
    case 'wake:result': cls(ev.id, [ev.yes ? 'awake' : 'asleep'], ['checking']); { const a = view.agents.get(ev.id); if (a && a.el) a.el.title = a.name + ': ' + (ev.yes ? 'awake' : 'asleep') + ' (' + ev.why + ')'; } return rp ? 70 : 0;
    case 'terminal': for (const a of view.agents.values()) cls(a.id, [ev.ids.includes(a.id) ? 'awake' : 'asleep'], ['checking']); return rp ? 300 : 0;
    case 'noactive': narr('<span class="bad">Nobody woke up</span>, so the task ends here with no answer.'); boardMsg('sys', 'Nobody woke up. The episode ends (NO_ACTIVE_AGENTS).'); return 500;
    case 'novice': { const a = view.agents.get(ev.id); if (a) { a.bid = ev.bid; a.status = 'veteran'; paintCard(a); } ledger(nameOf(ev.id) + ' enters: bid ' + money(ev.bid)); return 0; }
    case 'auction': {
      for (const b of ev.bids) { const a = view.agents.get(b.id); if (a) { a.bid = b.bid; if (a.status === 'novice') a.status = 'veteran'; paintCard(a); } }
      cls(ev.winner, ['winner'], ['awake']); view.winner = ev.winner;
      const sorted = ev.bids.slice().sort((x, y) => y.bid - x.bid);
      const list = sorted.slice(0, 4).map((b) => esc(nameOf(b.id)) + ' ' + money(b.bid)).join(', ') + (sorted.length > 4 ? ', ...' : '');
      narr((ev.terminal ? 'Last turn. ' : ev.bids.length + ' awake. ') + 'Bids: ' + list + '. ' + (!ev.byAuction ? 'Auction off: <b>' + esc(nameOf(ev.winner)) + '</b> picked at random.' : ev.ties > 1 ? ev.ties + ' agents tie at ' + money(sorted[0].bid) + ', so a random one of them wins: <b>' + esc(nameOf(ev.winner)) + '</b>.' : 'Highest bid wins: <b>' + esc(nameOf(ev.winner)) + '</b>.'));
      return rp ? 800 : 450;
    }
    case 'pay': {
      const a = view.agents.get(ev.from); if (a) a.wealth -= ev.amount;
      if (ev.to != null) { const t = view.agents.get(ev.to); if (t) t.wealth += ev.amount; coin(cardEl(ev.from), cardEl(ev.to), money(ev.amount)); ledger(nameOf(ev.from) + ' pays ' + nameOf(ev.to) + ' ' + money(ev.amount) + (ev.same ? ' (itself)' : '')); }
      else { view.voidTotal += ev.amount; $('rpVoid').querySelector('b').textContent = money(view.voidTotal); coin(cardEl(ev.from), $('rpVoid'), money(ev.amount)); ledger(nameOf(ev.from) + ' pays ' + money(ev.amount) + ' to nobody (first turn)'); }
      repaintAll(); return rp ? 650 : 350;
    }
    case 'act:start': {
      cls(ev.id, ['acting', 'winner']); const a = view.agents.get(ev.id);
      view.streamEl = boardMsg('', '<div class="h"><b>' + esc(ev.name) + '</b><span>' + ROLE_LABEL[ev.role] + ', turn ' + (ev.step + 1) + '</span></div><div class="t muted">Thinking...</div>', ev.role); view.streamId = ev.id;
      narr('<b>' + esc(ev.name) + '</b> ' + ROLE_JOB[ev.role] + '.' + (a && a.status ? '' : ''));
      return 0;
    }
    case 'act:text': if (view.streamEl && view.streamId === ev.id) { const t = view.streamEl.querySelector('.t'); t.classList.remove('muted'); const p = splitAction(ev.text); t.textContent = p.step || ev.text; const b = $('rpBoard'); b.scrollTop = b.scrollHeight; } return 0;
    case 'act': {
      cls(ev.id, [], ['acting']);
      let d = view.streamEl && view.streamId === ev.id ? view.streamEl : null;
      if (!d) d = boardMsg('', '<div class="h"><b>' + esc(ev.name) + '</b><span>' + ROLE_LABEL[ev.role] + ', turn ' + (ev.step + 1) + '</span></div>', ev.role);
      d.querySelectorAll('.t,.more').forEach((x) => x.remove()); d.insertAdjacentHTML('beforeend', msgBody(ev.text)); if (ev.isFinal) d.classList.add('final');
      math(d); addMore(d); view.streamEl = null; const b = $('rpBoard'); b.scrollTop = b.scrollHeight;
      return rp ? Math.min(3200, 700 + (ev.text || '').length * 2) : 300;
    }
    case 'judge:start': narr(view.adapter === 'research' ? 'Final answer in. The judge model scores it against the rubric...' : 'Final answer in. Checking it against the reference answer...'); $('rpJudge').classList.add('hot'); return 0;
    case 'judge': {
      $('rpJudge').querySelector('b').textContent = ev.score == null ? '-' : ev.score.toFixed(2); $('rpJudge').classList.remove('hot');
      boardMsg(ev.passed ? 'ok' : 'no', '<div class="h"><b>' + (ev.passed ? 'Pass' : 'Fail') + '</b><span>' + (view.adapter === 'research' ? 'rubric score ' + (ev.score == null ? '-' : ev.score.toFixed(3)) + ', pass at 0.5' : 'exact answer check') + '</span></div><div class="t">' + esc(ev.reason) + '</div>');
      narr(ev.passed ? 'The answer <b>passes</b>. Score ' + ev.score.toFixed(2) + '.' : '<span class="bad">The answer fails</span>. Score ' + (ev.score == null ? '-' : ev.score.toFixed(2)) + '.');
      return rp ? 1000 : 500;
    }
    case 'reward': for (const id of ev.ids) { const a = view.agents.get(id); if (a) a.wealth += ev.amount; coin($('rpJudge'), cardEl(id), signed(ev.amount), ev.amount < 0); ledger(nameOf(id) + ' answer bonus ' + signed(ev.amount), ev.amount < 0); } repaintAll(); narr('The answer agent gets the answer bonus: half the centred score, <b>' + signed(ev.amount) + '</b>.'); return rp ? 800 : 500;
    case 'path': {
      const counts = new Map(); for (const id of ev.ids) counts.set(id, (counts.get(id) || 0) + 1);
      for (const [id, n] of counts) { const a = view.agents.get(id); if (a) a.wealth += ev.per * n; coin($('rpJudge'), cardEl(id), signed(ev.per * n), ev.per < 0); }
      ledger('Path reward ' + signed(ev.signal) + ' split over ' + ev.n + ' turns: ' + signed(ev.per) + ' per turn', ev.per < 0);
      narr('Everyone on the workflow shares the score: ' + signed(ev.signal) + ' over ' + ev.n + ' turns, <b>' + signed(ev.per) + '</b> per turn they took.' + (ev.per < 0 ? ' <span class="bad">A failed task costs them all.</span>' : ''));
      repaintAll(); return rp ? 1100 : 700;
    }
    case 'credit': for (const w of ev.wealth) { const a = view.agents.get(w.id); if (a) a.wealth = w.wealth; } repaintAll(); return 0;
    case 'bankrupt': { view.bankruptcies++; cls(ev.id, ['dying']); ledger(ev.name + ' goes bankrupt (' + money(ev.wealth) + ')', true); narr('<span class="bad">' + esc(ev.name) + ' is below zero and is removed.</span>'); const id = ev.id; setTimeout(() => { const a = view.agents.get(id); if (a) { a.el && a.el.remove(); view.agents.delete(id); meters(); } }, 800); return rp ? 900 : 600; }
    case 'rollback': for (const w of ev.wealth) { const a = view.agents.get(w.id); if (a) a.wealth = w.wealth; } repaintAll(); ledger('Rollback: survivors\' credits restored', false); return rp ? 600 : 300;
    case 'accepted': return 0;
    case 'rent': for (const id of ev.ids) { const a = view.agents.get(id); if (a) { a.wealth -= ev.amount; coin(cardEl(id), $('rpRentBox'), null, true); } } ledger('Rent ' + money(ev.amount) + ' from each of ' + ev.ids.length + ' agents', true); narr('Rent day: every agent pays <b>' + money(ev.amount) + '</b>. Agents that never win only lose money.'); $('rpRentBox').classList.add('hot'); setTimeout(() => $('rpRentBox').classList.remove('hot'), 900); repaintAll(); return rp ? 900 : 600;
    case 'birth:start': narr(ev.kind === 'good' ? 'Writing a new agent: a copy of the richest, <b>' + esc(ev.parent) + '</b>, with one new general skill...' : 'Writing a repaired agent from <b>' + esc(ev.parent) + '</b>\'s failure...'); return 0;
    case 'birth': {
      const a = upsertAgent(ev.agent); a.el.classList.add('born'); setTimeout(() => a.el && a.el.classList.remove('born'), 900); repaintAll();
      const kind = ev.kind === 'good' ? 'copy of ' + ev.parent : ev.kind === 'bad' ? 'repair of ' + ev.parent : 'new';
      ledger(ev.agent.name + ' born (' + kind + ')');
      const det = document.createElement('details'); det.innerHTML = '<summary><b>' + esc(ev.agent.name) + '</b>: ' + esc(kind) + ' <span class="muted">(' + esc(ev.why) + ')</span></summary><div class="diff">' + lineDiff(ev.before, ev.after) + '</div>';
      const host = $('rpBirths'); if (host.querySelector('p.muted')) host.innerHTML = ''; host.prepend(det); while (host.children.length > 60) host.removeChild(host.lastChild);
      narr('New agent <b>' + esc(ev.agent.name) + '</b>: ' + esc(kind) + '. ' + (ev.kind === 'good' ? 'Exploitation: copy what earns.' : 'Exploration: fix what failed.'));
      return rp ? 1100 : 700;
    }
    case 'warn': boardMsg('sys', esc(ev.text)); return 0;
    case 'task:end': {
      for (const s of ev.agents) upsertAgent(s); repaintAll(); clearTurnClasses();
      narr(ev.success ? 'Task solved. Score <b>' + (ev.score == null ? '-' : ev.score.toFixed(2)) + '</b>.' : '<span class="bad">Task failed</span> (' + (ev.termination === 'no_active_agents' ? 'nobody woke up' : ev.score == null ? 'no final answer' : 'score ' + ev.score.toFixed(2)) + ').');
      if (rp) { const m = saved.list.find((r) => replay && r.id === replay.id); $('rpMTasks').textContent = ev.tasksCompleted + (m ? ' / ' + m.totalTasks : ''); }
      return rp ? 1000 : 300;
    }
    case 'test:start': {
      const w = $('rpTestWall'); w.hidden = false; $('rpMode').textContent = 'Testing'; $('rpMode').className = 'rp-mode test';
      w.innerHTML = '<span class="kicker">Periodic test after ' + ev.tasksCompleted + ' training tasks</span><h3>A frozen copy of the team tries ' + ev.n + ' test tasks</h3><p class="muted">No money moves (the code\'s _eval_forward). Several run at once.</p><div class="rp-tiles">' + Array.from({ length: ev.n }, (_, i) => '<i data-i="' + i + '">' + (i + 1) + '</i>').join('') + '</div><p class="num" id="rpTestScore"></p>';
      narr('Testing the frozen team. Training pauses until the test finishes.'); return 0;
    }
    case 'test:task:start': { const t = $('rpTestWall').querySelector('[data-i="' + ev.i + '"]'); if (t) t.className = 'run'; return 0; }
    case 'test:task': { const t = $('rpTestWall').querySelector('[data-i="' + ev.i + '"]'); if (t) { t.className = ev.success ? 'ok' : 'no'; t.title = (ev.success ? 'Pass' : 'Fail') + (ev.score != null ? ', score ' + ev.score.toFixed(2) : '') + ', workflow ' + ev.path.map((r) => ROLE_LABEL[r][0]).join(''); } const done = $('rpTestWall').querySelectorAll('.ok,.no').length, ok = $('rpTestWall').querySelectorAll('.ok').length; const sc = $('rpTestScore'); if (sc) sc.textContent = ok + ' of ' + done + ' passed so far'; return 0; }
    case 'test:end': { chartAdd(ev); const sc = $('rpTestScore'); if (sc) sc.innerHTML = '<b>' + pct(ev.accuracy) + '</b> (' + ev.success + ' of ' + ev.total + ')' + (ev.avgScore != null && view.adapter === 'research' ? ', average rubric score ' + ev.avgScore.toFixed(2) : ''); meters(); setTimeout(() => { $('rpTestWall').hidden = true; }, 2600); return 0; }
    case 'test:replay': {
      apply({ type: 'test:start', tasksCompleted: ev.rec.tasksCompleted, n: ev.rec.total });
      (ev.rec.results || []).forEach((r, i) => apply(Object.assign({ type: 'test:task', i }, r)));
      apply(Object.assign({ type: 'test:end' }, ev.rec)); $('rpMScore').textContent = pct(ev.rec.accuracy); return 2800 / Math.max(1, replaySpeed);
    }
    case 'done': narr('The run is finished.'); return 0;
  }
  return 0;
}
function showAgent(id) {
  const a = view.agents.get(id); if (!a) return; const pop = $('rpPop');
  const origin = a.spawn === 'good_birth' ? 'A copy of ' + a.parent + ', the richest agent when it was born.' : a.spawn === 'bad_birth' ? 'A repaired version of ' + a.parent + ', rewritten from its failure.' : 'One of the starting agents, with the released prompt.';
  pop.innerHTML = '<div class="row"><h3>' + esc(a.name) + ', ' + ROLE_LABEL[a.role] + '</h3><button class="btn" id="rpPopClose">Close</button></div><p class="muted">' + esc(origin) + (a.born ? ' Born at task ' + a.born + '.' : '') + '</p><dl class="kv"><dt>Credits</dt><dd class="' + (a.wealth < 0 ? 'bad' : 'brass') + '">' + money(a.wealth) + '</dd><dt>Bid</dt><dd>' + (a.status === 'novice' ? 'not set (new)' : money(a.bid)) + '</dd><dt>Turns won</dt><dd>' + (a.wins || 0) + '</dd></dl><b>Frozen prompt</b> <span class="muted">(never changes)</span><pre>' + esc(a.frozen || '') + '</pre><b>Trainable prompt</b> <span class="muted">(what births rewrite)</span><pre>' + esc(a.trainable || '') + '</pre>';
  pop.hidden = false; for (const x of view.agents.values()) x.el && x.el.classList.toggle('sel', x.id === id);
  $('rpPopClose').addEventListener('click', () => { pop.hidden = true; for (const x of view.agents.values()) x.el && x.el.classList.remove('sel'); });
  $('rpPopClose').focus({ preventScroll: true });
}

// ======================= chart =======================
const chart = { points: [] };
function chartAdd(t) { chart.points = chart.points.filter((p) => p.tasksCompleted !== t.tasksCompleted).concat([{ tasksCompleted: t.tasksCompleted, accuracy: t.accuracy, avgScore: t.avgScore }]).sort((a, b) => a.tasksCompleted - b.tasksCompleted); drawChart(); }
function drawChart() {
  const cv = $('rpChart'), dpr = Math.min(devicePixelRatio || 1, 2), w = cv.clientWidth, h = cv.clientHeight; if (!w) return;
  cv.width = w * dpr; cv.height = h * dpr; const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const L = 40, Rr = 16, T = 10, B = 24, pw = w - L - Rr, ph = h - T - B;
  const total = run ? run.state.trainIds.length * run.state.numEpochs : Math.max(10, ...chart.points.map((p) => p.tasksCompleted));
  const X = (t) => L + (t / Math.max(1, total)) * pw, Y = (v) => T + (1 - v) * ph;
  ctx.font = '11.5px "Atkinson Hyperlegible", system-ui'; ctx.strokeStyle = css('--line'); ctx.fillStyle = css('--muted'); ctx.textAlign = 'right';
  for (const s of [0, 0.5, 1]) { ctx.beginPath(); ctx.moveTo(L, Y(s)); ctx.lineTo(L + pw, Y(s)); ctx.stroke(); ctx.fillText(Math.round(s * 100) + '%', L - 6, Y(s) + 4); }
  ctx.textAlign = 'center'; ctx.fillText('0', X(0), h - 6); ctx.fillText(String(total), X(total), h - 6); ctx.fillText('training tasks', L + pw / 2, h - 6);
  if (!chart.points.length) { ctx.fillStyle = css('--muted'); ctx.fillText('No tests yet', L + pw / 2, T + ph / 2); $('rpChartCap').innerHTML = 'Each point is a periodic test: a frozen copy of the team tries the test tasks with no money moving (the code\'s <code>_eval_forward</code>).'; return; }
  const line = (key, color, dash) => { ctx.beginPath(); chart.points.forEach((p, i) => { const v = p[key]; if (v == null) return; i ? ctx.lineTo(X(p.tasksCompleted), Y(v)) : ctx.moveTo(X(p.tasksCompleted), Y(v)); }); ctx.strokeStyle = color; ctx.lineWidth = 2.4; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]); for (const p of chart.points) if (p[key] != null) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(X(p.tasksCompleted), Y(p[key]), 3.2, 0, 7); ctx.fill(); } };
  if (view.adapter === 'research') line('avgScore', css('--muted'), [5, 4]);
  line('accuracy', css('--fg'), []);
  const f = chart.points[0], l = chart.points[chart.points.length - 1];
  $('rpChartCap').innerHTML = 'Pass rate ' + (chart.points.length > 1 ? pct(f.accuracy) + ' at ' + f.tasksCompleted + ' tasks, ' : '') + '<b>' + pct(l.accuracy) + '</b> after ' + l.tasksCompleted + ' tasks.' + (view.adapter === 'research' ? ' Dashed: average rubric score (the paper\'s science numbers use this kind of rubric).' : '') + ' The paper reports both the mean and the best point, because single runs swing a lot.';
}

// ======================= boot =======================
function boot() {
  renderPresets(); renderKnobs(); bindSettings(); idleFloor(); renderRuns(); drawChart();
  $('rpStart').disabled = true;
  $('rpStart').addEventListener('click', startNew);
  $('rpStopSoft').addEventListener('click', () => { if (run) { run.stopSoft = true; status('Will stop when this task (and any test right after it) finishes.'); } });
  $('rpStopHard').addEventListener('click', () => { if (run) { run.abort.abort(); status('Stopping...'); } });
  $('rpExport').addEventListener('click', () => { if (run) exportRun(run.id); });
  $('rpSpeed').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; replaySpeed = +b.dataset.v; [...$('rpSpeed').children].forEach((x) => x.setAttribute('aria-pressed', String(x === b))); });
  window.addEventListener('resize', () => drawChart());
  const C = window.claude;
  if (!C || !C.use) { status('This view cannot call Claude. Open the page on claude.ai or in the Claude app to run the replica. The toy model below works anywhere.'); return; }
  C.use('sample').then((s) => {
    sampleFn = s;
    if (s) { $('rpStart').disabled = !!(run && run.running); status('Ready. A run uses <b>your</b> Claude usage. The first call asks for permission.'); }
    else status('This view cannot call Claude, so it cannot start runs. Saved runs can still be watched.');
    renderRuns();
  }).catch(() => { status('This view cannot call Claude, so it cannot start runs. Sign in to Claude to run it, or try the toy model below, which works anywhere.'); renderRuns(); });
  C.use('db').then((d) => { db = d; listRuns().then(() => { const first = saved.list.find((r) => r.tasksCompleted > 0); if (first && !(run && run.running)) startReplay(first.id); }); }).catch(() => { renderRuns(); });
  C.use('downloads').then((d) => { downloads = d; }).catch(() => {});
}
boot();
})();
