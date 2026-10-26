(function () {
'use strict';
const E = window.EoM;
const R = /*__RESULTS__*/;
const ROLES = E.ROLES, SHORT = E.ROLE_SHORT, LABEL = E.ROLE_LABEL, SITS = E.SITUATIONS;
const NOUN = { planner: 'planner', executor: 'executor', verifier: 'verifier', answer: 'answer agent' };
const $ = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const C = { ink: css('--ink'), ink2: css('--ink-2'), panel: css('--panel'), raise: css('--raise'), line: css('--line'), fg: css('--fg'), muted: css('--muted'), brass: css('--brass'), fail: css('--fail') };
const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
const f0 = (x) => String(Math.round(x));
const pct = (x) => Math.round(x * 100) + '%';
const p1 = (x) => (Math.round(x * 1000) / 10).toFixed(1) + '%';
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const money = (x) => (Math.abs(x) >= 100 ? f0(x) : f1(x));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function skillRGB(q) { const lo = [52, 63, 82], hi = [240, 243, 248], t = clamp(q, 0, 1); return lo.map((v, i) => Math.round(lerp(v, hi[i], t))); }
const skillColor = (q, a) => { const c = skillRGB(q); return 'rgba(' + c.join(',') + ',' + (a == null ? 1 : a) + ')'; };
function fit(cv) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2), w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); return { ctx, w, h };
}
const FONT = (px, w) => (w || 400) + ' ' + px + 'px "Atkinson Hyperlegible", system-ui, sans-serif';
const DFONT = (px, w) => (w || 700) + ' ' + px + 'px "Archivo", "Arial Narrow", system-ui, sans-serif';
function rrect(ctx, x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }

// how good an agent is at its job, 0..1, for the number inside its circle
function quality(a) {
  const g = a.genome;
  if (a.role === 'planner') return g.thorough;
  if (a.role === 'executor') { const acc = clamp(0.64 + g.skill + 0.06, 0.02, 0.97); return acc + (1 - acc) * g.selfCheck * acc; }
  if (a.role === 'verifier') return g.detect * (1 - g.falseAlarm);
  return (g.patience + g.care) / 2;
}

// ======================= state =======================
const RULE_DEFAULTS = { rent: 20, reward: 100, epsilon: 1, rewardScheme: 'released', bidScheme: 'fixed_with_eps', auction: true, exploration: true, exploitation: true };
const rules = Object.assign({}, RULE_DEFAULTS);
const SPEEDS = { slow: 0.5, normal: 1, fast: 7, turbo: 'max' };
let seed = 5;
let eco = null, stream = [], checkpoints = [], founderTraits = null;
const testSet = E.testSet(40);
const vis = new Map();
let houseDisp = 0, queue = [], cur = null;
let playing = true, speedKey = reduceMotion ? 'turbo' : 'normal';
let lastRec = null, lastSnap = null, replaying = false, playingBeforeReplay = true, stepping = false;
let markers = [], selected = null, predictOn = false, awaiting = false;
let floats = [], activeAuction = null, activeWinner = null, flashFail = null, trialSnap = null;
const ui = { level: 1, k: 1, parts: [], planQ: 0, flag: false, lastRole: null, turn: 0, trial: 1, result: null, path: [], show: false };
const tour = { on: false, i: 0 };
let G = null;
const speedFactor = () => (replaying ? 0.8 : SPEEDS[speedKey] === 'max' ? 1000 : SPEEDS[speedKey]);
const isTurbo = () => SPEEDS[speedKey] === 'max';
const narrated = () => replaying || (!isTurbo() && SPEEDS[speedKey] <= 1);

function traitAverages(agents) {
  const avg = (role, k) => { const l = agents.filter((a) => a.role === role); return l.length ? l.reduce((t, a) => t + a.genome[k], 0) / l.length : null; };
  return { thorough: avg('planner', 'thorough'), skill: avg('executor', 'skill'), selfCheck: avg('executor', 'selfCheck'), detect: avg('verifier', 'detect'), falseAlarm: avg('verifier', 'falseAlarm'), patience: avg('answer', 'patience'), care: avg('answer', 'care') };
}
function newEconomy() {
  eco = new E.Economy(Object.assign({ seed }, rules));
  stream = E.curriculum(seed, 20, 'easy');
  vis.clear(); houseDisp = 0; queue = []; cur = null; lastRec = null; lastSnap = null; replaying = false; stepping = false; floats = [];
  activeAuction = null; activeWinner = null; markers = [];
  founderTraits = traitAverages(eco.agents);
  checkpoints = [Object.assign({ episode: 0 }, eco.evaluate(testSet))];
  for (const a of eco.agents) makeVis(a, null, 1);
  G = geometry(); layoutTargets(true);
  selected = null; Object.assign(ui, { show: false, path: [], parts: [], result: null });
  narrate('Starting', 'A new team of five weak agents: one planner, two executors, one verifier, one answer agent. Before training they solve <b>' + pct(checkpoints[0].acc) + '</b> of the test problems.');
  renderInspector(); renderLedger(); updateStats(); drawCharts(); renderTraits(); renderFlows();
}
function nextTask() {
  if (eco.episode >= stream.length) stream = stream.concat(E.curriculum(seed * 31 + eco.episode, 4, 'mixed'));
  return stream[eco.episode];
}
function makeVis(a, near, scale) { const v = { id: a.id, role: a.role, disp: a.wealth, x: near ? near.x : 0, y: near ? near.y : 0, tx: 0, ty: 0, scale: scale == null ? 1 : scale, alpha: 1, dying: false, link: null, kind: a.kind, r: 14 }; vis.set(a.id, v); return v; }
const agentOf = (id) => eco.byId(id);
const nm = (id) => (id === 'house' ? 'the House' : (agentOf(id) || { name: '#' + id }).name);
function syncVis() {
  const alive = new Set(eco.agents.map((a) => a.id));
  for (const id of [...vis.keys()]) if (!alive.has(id)) vis.delete(id);
  for (const a of eco.agents) { let v = vis.get(a.id); if (!v) v = makeVis(a, null, 1); v.disp = a.wealth; v.scale = 1; v.alpha = 1; v.dying = false; v.link = null; }
  houseDisp = eco.house;
}
function maybeCheckpoint() {
  if (eco.episode % 10 !== 0) return false;
  checkpoints.push(Object.assign({ episode: eco.episode }, eco.evaluate(testSet)));
  if (eco.episode === 100) markers.push({ t: 100, label: 'end of the paper-length run' });
  return true;
}

// ======================= geometry =======================
const arena = $('arena');
function geometry() {
  const w = arena.clientWidth, h = arena.clientHeight, small = w < 620;
  const side = clamp(w * 0.1, 58, 118), pad = small ? 4 : 8;
  const bandY = 10, bandH = small ? 120 : 128;
  const flowY = bandY + bandH + (small ? 10 : 14), flowH = 24;
  const stY = flowY + flowH + (small ? 10 : 14), stH = small ? 56 : 62;
  const colW = (w - side * 2) / 4;
  const cols = ROLES.map((r, i) => ({ role: r, x0: side + i * colW, x1: side + (i + 1) * colW, cx: side + (i + 0.5) * colW }));
  const st = cols.map((c) => ({ x: c.x0 + pad, y: stY, w: colW - pad * 2, h: stH }));
  const top = stY + stH + (small ? 20 : 26);
  const boxH = small ? 64 : 76;
  return { w, h, small, side, pad, colW, cols, st, top, bandY, bandH, flowY, flowH,
    house: { x: pad, y: bandY, w: side - pad * 2, h: bandH }, score: { x: w - side + pad, y: bandY, w: side - pad * 2, h: bandH },
    task: { x: side + pad, y: bandY, w: w - side * 2 - pad * 2, h: bandH },
    rentBox: { x: pad, y: top, w: side - pad * 2, h: boxH }, lifeBox: { x: w - side + pad, y: top, w: side - pad * 2, h: boxH } };
}
const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
function roleList(role) {
  const list = [...vis.values()].filter((v) => v.role === role);
  list.sort((p, q) => { const a = agentOf(p.id), b = agentOf(q.id); const ba = a && a.bid != null ? a.bid : 1e9, bb = b && b.bid != null ? b.bid : 1e9; return bb - ba || p.id - q.id; });
  return list;
}
function layoutTargets(snap) {
  for (const col of G.cols) {
    const list = roleList(col.role), n = Math.max(list.length, 3);
    const avail = G.h - G.top - 8, lab = G.small ? 13 : 16;
    let cols = clamp(Math.floor(G.colW / 52), 1, 3), cell = Math.min(G.colW / cols, 64);
    const rows = (c) => Math.ceil(n / c);
    while (rows(cols) * (cell * 0.8 + lab) > avail && cols < 5) { cols++; cell = Math.min(G.colW / cols, 64); }
    let pitch = cell * 0.8 + lab; if (rows(cols) * pitch > avail) pitch = avail / rows(cols);
    const rad = clamp(Math.min(cell * 0.33, (pitch - lab) * 0.42), 6, 20);
    const x0 = col.cx - (cols * cell) / 2;
    list.forEach((v, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      v.tx = x0 + (c + 0.5) * cell; v.ty = G.top + r * pitch + rad + 6; v.r = rad;
      if (snap || (v.x === 0 && v.y === 0)) { v.x = v.tx; v.y = v.ty; }
    });
  }
}
function posOf(id) {
  if (id === 'house') return center(G.house);
  if (id === 'score') return center(G.score);
  const v = vis.get(id); return v ? { x: v.x, y: v.y - (v.lift || 0) } : { x: G.w / 2, y: G.h / 2 };
}

// ======================= narration =======================
function narrate(phase, html) { $('nPhase').textContent = phase; $('nText').innerHTML = html; }
const sitText = (i) => SITS[i].label.toLowerCase();
function narrateStep(st) {
  const ev = st.ev;
  switch (st.k) {
    case 'trial': {
      const k = E.LEVELS.parts[ev.task.level - 1];
      return ev.trial === 1
        ? narrate('New task', 'Task ' + eco.episode + ': a level ' + ev.task.level + ' problem with ' + k + ' step' + (k > 1 ? 's' : '') + '. The team has 10 turns.')
        : narrate('Replay', 'Someone went bankrupt, so the task is replayed. Everyone else got their credits back first (Alg. 1).');
    }
    case 'auction': {
      if (ev.terminal) return narrate('Last turn', 'Final turn: only answer agents may act now (terminal mode). <b>' + nm(ev.winner) + '</b> must answer.');
      if (!ev.byAuction) return narrate('Who acts?', 'Situation: ' + sitText(ev.sit) + '. The auction is off, so <b>' + nm(ev.winner) + '</b> is picked at random from ' + ev.bids.length + ' awake agents.');
      const sorted = [...ev.bids].sort((a, b) => (b.bid == null ? 0 : b.bid) - (a.bid == null ? 0 : a.bid));
      const list = sorted.slice(0, 3).map((b) => nm(b.id) + ' <b>' + f0(b.bid) + '</b>').join(', ');
      return narrate('Who acts?', 'Situation: ' + sitText(ev.sit) + '. ' + ev.bids.length + ' agent' + (ev.bids.length > 1 ? 's wake' : ' wakes') + ' up. Bids: ' + list + (sorted.length > 3 ? ', and more' : '') + '. Highest bid wins: <b>' + nm(ev.winner) + '</b>.');
    }
    case 'pay': return ev.to === 'house'
      ? narrate('Payment', nm(ev.from) + ' pays its bid of <b>' + f0(ev.amount) + '</b> to the House. It went first, so nobody before it gets paid.')
      : narrate('Payment', nm(ev.from) + ' pays <b>' + f0(ev.amount) + '</b> to ' + nm(ev.to) + ', whose turn set this one up (Eq. 1).');
    case 'act': {
      const n = ev, who = nm(n.id);
      const map = {
        plan: who + ' writes a plan (quality ' + f1(n.planQ) + '). A better plan makes every later step more likely to be right.',
        replan: who + ' plans again. The plan already existed, so this turn is mostly wasted.',
        step: who + ' solves step ' + (n.index + 1) + ' (chance ' + pct(n.acc || 0) + '). ' + (n.ok ? 'It is right' + (n.selfFixed ? ', after catching its own mistake.' : '.') : '<span class="bad">It is wrong</span>, but nobody can see that yet.'),
        fix: who + ' redoes the flagged step. ' + (n.ok ? 'Now it is right.' : '<span class="bad">Still wrong.</span>'),
        polish: who + ' reworks a finished step for no reason. ' + (n.ok ? 'It stays right.' : '<span class="bad">It broke it.</span>'),
        nothing: who + ' wakes up to check, but there is nothing to check yet. A wasted turn.',
        check: who + ' checks the latest step. ' + (n.partOk ? (n.flagged ? '<span class="bad">It wrongly flags correct work.</span>' : 'It is right, and it passes.') : (n.flagged ? 'It catches the error and flags it.' : '<span class="bad">It misses the error.</span>')),
        abstain: who + ' sees the work is unfinished and waits instead of answering. Smart, but it uses a turn.',
        submit: who + ' submits the answer. ' + (n.success ? '<b>Right.</b>' : !n.complete ? '<span class="bad">Too early: steps were missing.</span>' : n.slip ? '<span class="bad">It copied a result wrongly.</span>' : '<span class="bad">Wrong: a hidden error got through.</span>'),
      };
      return narrate('Work', map[n.kind] || who + ' acts.');
    }
    case 'rewards': {
      const pos = ev.list.some((x) => x.amount > 0);
      if (eco.cfg.rewardScheme !== 'released') return narrate('Reward', 'Right answer. ' + ev.list.map((r) => nm(r.to) + ' gets <b>+' + f0(r.amount) + '</b>').join(', ') + '.');
      return narrate(pos ? 'Reward' : 'Penalty', pos ? 'Right answer. The answer agent gets <b>+' + f0(eco.cfg.reward * 0.5) + '</b>, and every turn on the workflow shares <b>+' + f0(eco.cfg.reward) + '</b>.'
        : '<span class="bad">Wrong or no answer.</span> In the released code everyone on the workflow pays for it: the score is -' + f0(eco.cfg.reward) + ', split over every turn, and the answer agent loses ' + f0(eco.cfg.reward * 0.5) + ' more.');
    }
    case 'bankrupt': return narrate('Bankrupt', '<span class="bad">' + nm(ev.id) + ' ran out of credits</span> and is removed.');
    case 'rollback': return narrate('Rollback', 'Because someone went bankrupt, the survivors get their credits back' + (ev.last ? '.' : ' and the task will be replayed.'));
    case 'rent': return narrate('Rent day', 'Every agent pays <b>' + f0(ev.amount) + '</b> rent. Agents that never win only lose money.');
    case 'birth': {
      const a = agentOf(ev.id);
      if (ev.kind === 'good') return narrate('New agent', nm(ev.id) + ' is a copy of <b>' + nm(ev.parent) + '</b>, the richest agent' + (a && a.amendNote ? ', with one change: it ' + esc(a.amendNote) + '.' : '.'));
      if (ev.kind === 'bad') return narrate('New agent', nm(ev.id) + ' is a repaired ' + NOUN[a ? a.role : 'executor'] + ' based on ' + nm(ev.parent) + '. ' + (a && a.amendNote ? 'The old version ' + esc(a.amendNote) + '.' : ''));
      return narrate('New agent', nm(ev.id) + ' is added to keep the team big enough.');
    }
    case 'no-eligible': return narrate('Stuck', 'Nobody\'s wake-up rules match this situation, so the task stops here and counts as a failure.');
    case 'end': {
      const rec = lastRec; if (!rec) return;
      return narrate('Task ' + rec.episode + (rec.success ? ' solved' : ' failed'), (rec.success ? 'Solved. ' : 'Failed. ') + 'Workflow: ' + rec.path.map((r) => SHORT[r]).join(' ') + '. ' + (eco.episode % 10 === 0 ? 'Checkpoint: the frozen team now scores <b>' + pct(checkpoints[checkpoints.length - 1].acc) + '</b> on the test set.' : 'Next test in ' + (10 - (eco.episode % 10)) + ' tasks.'));
    }
  }
}

// ======================= animation =======================
const DUR = { trial: 650, auction: 1150, pay: 850, act: 1050, rewards: 1100, bankrupt: 800, rollback: 800, rent: 800, birth: 900, 'no-eligible': 900, end: 800 };
function buildSteps(rec) {
  const steps = [];
  for (const ev of rec.events) {
    if (ev.type === 'reward') { const ls = steps[steps.length - 1]; if (ls && ls.k === 'rewards') { ls.ev.list.push(ev); continue; } steps.push({ k: 'rewards', ev: { list: [ev] }, d: DUR.rewards, t: 0 }); continue; }
    if (DUR[ev.type]) steps.push({ k: ev.type, ev, d: DUR[ev.type], t: 0 });
  }
  steps.push({ k: 'end', d: DUR.end, t: 0 });
  return steps;
}
const snapshotVis = () => ({ house: houseDisp, list: [...vis.values()].map((v) => Object.assign({}, v)) });
function restoreVis(s) { vis.clear(); for (const v of s.list) vis.set(v.id, Object.assign({}, v)); houseDisp = s.house; }
function resetUi(level) { Object.assign(ui, { level, k: E.LEVELS.parts[level - 1], parts: [], planQ: 0, flag: false, lastRole: null, turn: 0, trial: 1, result: null, path: [], show: true }); }
function startTask() {
  lastSnap = snapshotVis();
  const t = nextTask();
  lastRec = eco.runEpisode(t);
  queue = buildSteps(lastRec);
  resetUi(t.level);
}
function runInstant(n) {
  queue = []; cur = null; activeAuction = null; activeWinner = null;
  for (let i = 0; i < n; i++) {
    if (i === n - 1) { syncVis(); layoutTargets(false); lastSnap = snapshotVis(); }
    lastRec = eco.runEpisode(nextTask()); maybeCheckpoint();
  }
  syncVis(); ui.show = false;
  renderLedger(); updateStats(); drawCharts(); renderTraits(); renderFlows();
  if (selected && selected.kind === 'agent') renderInspector();
  narrate('Fast-forward', 'Training at full speed. Watch the test score and the charts below. Switch to Normal to see each turn explained.');
}
function onStart(st) {
  const ev = st.ev;
  if (narrated()) narrateStep(st);
  switch (st.k) {
    case 'trial':
      Object.assign(ui, { parts: [], planQ: 0, flag: false, lastRole: null, turn: 0, trial: ev.trial, result: null, path: [] });
      trialSnap = new Map([...vis.values()].map((v) => [v.id, v.disp]));
      break;
    case 'auction':
      activeAuction = ev; activeWinner = null; ui.turn = ev.step + 1;
      if (predictOn && !replaying && !tour.on && narrated() && ev.bids.length > 1 && ev.byAuction) askPrediction(ev);
      break;
    case 'pay': { const w = vis.get(ev.from); if (w) w.disp -= ev.amount; break; }
    case 'rent': for (const v of vis.values()) if (!v.dying) v.disp -= ev.amount; addFloat(center(G.rentBox).x, G.rentBox.y + G.rentBox.h + 16, '-' + f0(ev.amount) + ' each', C.muted); break;
    case 'bankrupt': { const v = vis.get(ev.id); if (v) v.dying = true; break; }
    case 'birth': {
      const a = agentOf(ev.id), p = ev.parent != null ? vis.get(ev.parent) : null;
      if (a && !vis.has(a.id)) { const nv = makeVis(a, p || { x: G.cols[ROLES.indexOf(a.role)].cx, y: G.top }, 0); nv.link = p ? p.id : null; nv.kind = ev.kind; nv.disp = eco.cfg.initialWealth; addFloat(nv.x, nv.y - 24, ev.kind === 'good' ? 'copy' : 'repaired', C.fg); }
      break;
    }
  }
}
function onEnd(st) {
  const ev = st.ev;
  switch (st.k) {
    case 'auction': activeWinner = ev.winner; break;
    case 'pay': if (ev.to === 'house') houseDisp += ev.amount; else { const t = vis.get(ev.to); if (t) t.disp += ev.amount; } break;
    case 'act': {
      const n = ev; const work = n.kind === 'step' || n.kind === 'fix' || n.kind === 'polish';
      ui.path.push({ role: n.role, ok: work ? n.ok : true, kind: n.kind, success: n.success });
      if (n.kind === 'plan' || n.kind === 'replan') ui.planQ = n.planQ;
      if (work) { ui.parts[n.index] = n.ok; if (n.kind === 'fix') ui.flag = false; }
      if (n.kind === 'check') ui.flag = n.flagged;
      if (n.kind === 'submit') ui.result = n.success ? 'right' : 'wrong';
      if ((work && !n.ok) || (n.kind === 'submit' && !n.success)) flashFail = { id: n.id, t0: performance.now() };
      ui.lastRole = n.role; activeAuction = null;
      break;
    }
    case 'rewards': for (const r of ev.list) { const t = vis.get(r.to); if (t) t.disp += r.amount; } break;
    case 'bankrupt': vis.delete(ev.id); break;
    case 'rollback': if (trialSnap) for (const v of vis.values()) if (trialSnap.has(v.id)) v.disp = trialSnap.get(v.id); break;
    case 'birth': { const v = vis.get(ev.id); if (v) { v.scale = 1; v.link = null; } break; }
    case 'no-eligible': ui.result = 'wrong'; break;
    case 'end': {
      const cp = !replaying && maybeCheckpoint();
      syncVis(); activeAuction = null; activeWinner = null;
      if (narrated()) narrateStep(st);
      else if (!isTurbo() && lastRec) narrate('Fast', 'Task ' + lastRec.episode + (lastRec.success ? ' solved' : ' failed') + '. Test score ' + pct(checkpoints[checkpoints.length - 1].acc) + '. Slow down to Normal to read each turn.');
      if (cp) addFloat(center(G.score).x, G.score.y + G.score.h + 18, 'tested', C.fg);
      updateStats(); drawCharts(); renderTraits(); renderFlows();
      if (!replaying) renderLedger();
      if (selected && selected.kind === 'agent') renderInspector();
      break;
    }
  }
}
function advance(dt) {
  if (awaiting || tour.on) return;
  if (!playing && !replaying && !stepping) return;
  if (isTurbo() && !replaying) { runInstant(3); return; }
  let budget = dt * speedFactor(), guard = 0;
  while (budget > 0 && guard++ < 400) {
    if (!cur) {
      if (!queue.length) { if (replaying) { finishReplay(); return; } if (stepping) { stepping = false; return; } startTask(); }
      cur = queue.shift(); cur.t = 0; onStart(cur); if (awaiting) return;
    }
    const remain = cur.d - cur.t;
    if (budget >= remain) { budget -= remain; cur.t = cur.d; const d = cur; cur = null; onEnd(d); } else { cur.t += budget; budget = 0; }
  }
}
function addFloat(x, y, text, color, align) { floats.push({ x, y, text, color, align: align || 'center', t0: performance.now(), dur: 1500 }); }

// ======================= drawing =======================
function drawIcon(ctx, role, x, y, s, color) {
  ctx.save(); ctx.translate(x, y); ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (role === 'planner') { for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.moveTo(-s * 0.4, i * s * 0.28); ctx.lineTo(s * 0.4, i * s * 0.28); ctx.stroke(); } }
  else if (role === 'executor') { ctx.rotate(-Math.PI / 4); ctx.strokeRect(-s * 0.45, -s * 0.13, s * 0.8, s * 0.26); ctx.beginPath(); ctx.moveTo(-s * 0.45, -s * 0.13); ctx.lineTo(-s * 0.62, 0); ctx.lineTo(-s * 0.45, s * 0.13); ctx.stroke(); }
  else if (role === 'verifier') { ctx.beginPath(); ctx.arc(-1.5, -1.5, s * 0.32, 0, 7); ctx.stroke(); ctx.beginPath(); ctx.moveTo(s * 0.12, s * 0.12); ctx.lineTo(s * 0.42, s * 0.42); ctx.stroke(); }
  else { ctx.beginPath(); ctx.moveTo(-s * 0.4, 0); ctx.lineTo(-s * 0.1, s * 0.3); ctx.lineTo(s * 0.45, -s * 0.35); ctx.stroke(); }
  ctx.restore();
}
function dashedBox(ctx, b, hot) { ctx.strokeStyle = hot ? C.brass : C.line; ctx.lineWidth = hot ? 2 : 1; ctx.setLineDash([4, 4]); rrect(ctx, b.x, b.y, b.w, b.h, 10); ctx.stroke(); ctx.setLineDash([]); }
function drawTop(ctx) {
  const sm = G.small;
  const hb = G.house, hc = center(hb);
  dashedBox(ctx, hb, cur && cur.k === 'pay' && cur.ev.to === 'house');
  ctx.textAlign = 'center';
  ctx.font = DFONT(sm ? 12 : 15, 720); ctx.fillStyle = C.fg; ctx.fillText('House', hc.x, hb.y + 24);
  ctx.font = DFONT(sm ? 15 : 20, 720); ctx.fillStyle = C.brass; ctx.fillText(money(houseDisp), hc.x, hb.y + (sm ? 52 : 58));
  ctx.font = FONT(sm ? 9 : 10.5); ctx.fillStyle = C.muted; ctx.fillText('first bids', hc.x, hb.y + (sm ? 72 : 82)); ctx.fillText('go here', hc.x, hb.y + (sm ? 84 : 96));
  const sb = G.score, sc = center(sb), last = checkpoints[checkpoints.length - 1];
  dashedBox(ctx, sb, cur && cur.k === 'rewards');
  ctx.font = DFONT(sm ? 12 : 15, 720); ctx.fillStyle = C.fg; ctx.fillText('Test', sc.x, sb.y + 24);
  ctx.font = DFONT(sm ? 20 : 30, 780); ctx.fillStyle = C.fg; ctx.fillText(pct(last.acc), sc.x, sb.y + (sm ? 54 : 62));
  ctx.font = FONT(sm ? 9 : 10.5); ctx.fillStyle = C.muted; ctx.fillText('frozen team', sc.x, sb.y + (sm ? 72 : 82));
  ctx.font = FONT(sm ? 9.5 : 11.5, 700); ctx.fillStyle = C.brass; ctx.fillText('reward ' + f0(eco.cfg.reward), sc.x, sb.y + (sm ? 88 : 102));
  const tb = G.task;
  ctx.fillStyle = C.panel; rrect(ctx, tb.x, tb.y, tb.w, tb.h, 12); ctx.fill();
  ctx.strokeStyle = ui.result === 'wrong' ? C.fail : ui.result === 'right' ? C.fg : C.line; ctx.lineWidth = ui.result ? 2 : 1; rrect(ctx, tb.x, tb.y, tb.w, tb.h, 12); ctx.stroke();
  const tx = tb.x + 14;
  ctx.textAlign = 'left';
  if (!ui.show) {
    ctx.font = DFONT(sm ? 14 : 17, 720); ctx.fillStyle = C.fg; ctx.fillText('Workspace', tx, tb.y + 28);
    ctx.font = FONT(sm ? 11 : 13); ctx.fillStyle = C.muted; ctx.fillText(isTurbo() ? 'Fast-forwarding through tasks.' : 'The next task appears here.', tx, tb.y + 52);
    return;
  }
  const taskNo = lastRec ? lastRec.episode : eco.episode;
  ctx.font = DFONT(sm ? 13.5 : 17, 720); ctx.fillStyle = C.fg;
  ctx.fillText(sm ? 'Task ' + taskNo + ', L' + ui.level : 'Task ' + taskNo + (taskNo <= 100 ? ' of 100' : '') + ', level ' + ui.level, tx, tb.y + 26);
  ctx.textAlign = 'right'; ctx.font = FONT(sm ? 10.5 : 12.5, 700); ctx.fillStyle = C.muted;
  ctx.fillText(sm ? 'turn ' + ui.turn + '/' + eco.cfg.maxSteps + (ui.trial > 1 ? ' r' + ui.trial : '') : 'turn ' + ui.turn + ' of ' + eco.cfg.maxSteps + (ui.trial > 1 ? ', replay ' + ui.trial : ''), tb.x + tb.w - 14, tb.y + 26);
  ctx.textAlign = 'left';
  const bs = sm ? 24 : 30, gap = 6, y0 = tb.y + (sm ? 38 : 40);
  ctx.font = FONT(sm ? 9.5 : 11); ctx.fillStyle = C.muted; ctx.fillText(sm ? 'Steps (agents cannot see right or wrong)' : 'Steps (only we can see if they are right)', tx, y0 + bs + (sm ? 13 : 15));
  for (let i = 0; i < ui.k; i++) {
    const x = tx + i * (bs + gap), v = ui.parts[i];
    if (v === undefined) { ctx.strokeStyle = C.line; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]); rrect(ctx, x, y0, bs, bs, 6); ctx.stroke(); ctx.setLineDash([]); }
    else {
      ctx.fillStyle = v ? C.fg : C.fail; rrect(ctx, x, y0, bs, bs, 6); ctx.fill(); ctx.strokeStyle = C.ink2; ctx.lineWidth = 2.4; ctx.beginPath();
      if (v) { ctx.moveTo(x + bs * 0.25, y0 + bs * 0.52); ctx.lineTo(x + bs * 0.43, y0 + bs * 0.7); ctx.lineTo(x + bs * 0.76, y0 + bs * 0.3); }
      else { ctx.moveTo(x + bs * 0.3, y0 + bs * 0.3); ctx.lineTo(x + bs * 0.7, y0 + bs * 0.7); ctx.moveTo(x + bs * 0.7, y0 + bs * 0.3); ctx.lineTo(x + bs * 0.3, y0 + bs * 0.7); }
      ctx.stroke();
    }
  }
  const px = tx + 3 * (bs + gap) + (sm ? 8 : 18), pw = Math.min(sm ? 70 : 120, tb.x + tb.w - px - 14);
  if (pw > 30) {
    ctx.font = FONT(sm ? 9.5 : 11); ctx.fillStyle = C.muted; ctx.fillText('Plan', px, y0 + 10);
    ctx.fillStyle = C.ink2; rrect(ctx, px, y0 + 16, pw, 8, 4); ctx.fill();
    if (ui.planQ > 0) { ctx.fillStyle = C.fg; rrect(ctx, px, y0 + 16, Math.max(8, pw * ui.planQ), 8, 4); ctx.fill(); }
    if (ui.flag) { ctx.font = FONT(sm ? 10 : 12, 700); ctx.fillStyle = C.fail; ctx.fillText('Flagged', px, y0 + bs + (sm ? 12 : 14)); }
  }
  const sit = ui.result ? null : eco.situation({ lastRole: ui.lastRole, flag: ui.flag, parts: ui.parts, k: ui.k });
  ctx.font = FONT(sm ? 10.5 : 12.5, 700); ctx.fillStyle = ui.result === 'wrong' ? C.fail : C.fg;
  ctx.fillText(ui.result ? (ui.result === 'right' ? 'Answered correctly' : 'Answer was wrong or missing') : 'Situation: ' + SITS[sit].label, tx, tb.y + tb.h - (sm ? 12 : 14));
}
function drawFlow(ctx) {
  const y = G.flowY;
  ctx.font = FONT(G.small ? 10 : 11.5); ctx.fillStyle = C.muted; ctx.textAlign = 'left';
  ctx.fillText('Workflow', G.pad + 4, y + 16);
  let x = G.side + G.pad + 4; const cw = G.small ? 20 : 24;
  ui.path.forEach((p) => {
    const bad = p.kind === 'submit' ? !p.success : !p.ok;
    ctx.fillStyle = p.role === 'answer' ? '#c9cfda' : p.role === 'verifier' ? '#4d5c74' : p.role === 'executor' ? '#3b4a62' : '#2b3a52';
    rrect(ctx, x, y + 1, cw, 22, 5); ctx.fill();
    if (bad) { ctx.strokeStyle = C.fail; ctx.lineWidth = 2; rrect(ctx, x, y + 1, cw, 22, 5); ctx.stroke(); }
    ctx.fillStyle = p.role === 'answer' ? C.ink2 : C.fg; ctx.font = FONT(11.5, 700); ctx.textAlign = 'center'; ctx.fillText(SHORT[p.role], x + cw / 2, y + 16);
    x += cw + 4;
  });
}
function drawStations(ctx) {
  const sm = G.small;
  G.st.forEach((b, i) => {
    const role = ROLES[i];
    const awake = activeAuction ? activeAuction.bids.filter((x) => (agentOf(x.id) || {}).role === role).length : 0;
    const winRole = activeAuction && (agentOf(activeAuction.winner) || {}).role === role && cur && cur.k === 'auction' && cur.t / cur.d > 0.6;
    ctx.fillStyle = awake ? C.raise : C.panel; rrect(ctx, b.x, b.y, b.w, b.h, 10); ctx.fill();
    ctx.strokeStyle = winRole ? C.brass : C.line; ctx.lineWidth = winRole ? 2 : 1; rrect(ctx, b.x, b.y, b.w, b.h, 10); ctx.stroke();
    const cx = b.x + b.w / 2; ctx.textAlign = 'center';
    ctx.font = DFONT(sm ? 11.5 : 15, 720); ctx.fillStyle = C.fg;
    if (!sm) { const tw = ctx.measureText(LABEL[role]).width; drawIcon(ctx, role, cx - tw / 2 - 12, b.y + 19, 13, C.muted); ctx.fillText(LABEL[role], cx + 4, b.y + 24); }
    else ctx.fillText(LABEL[role], cx, b.y + 18);
    const bids = eco.agents.filter((a) => a.role === role && a.bid != null).map((a) => a.bid);
    ctx.font = FONT(sm ? 9.5 : 11.5, 700); ctx.fillStyle = C.brass;
    ctx.fillText(bids.length ? 'top bid ' + f0(Math.max(...bids)) : 'no bids yet', cx, b.y + (sm ? 34 : 42));
    ctx.font = FONT(sm ? 9 : 10.5); ctx.fillStyle = awake ? C.fg : C.muted;
    ctx.fillText(activeAuction ? (awake ? awake + ' awake' : 'asleep') : eco.agents.filter((a) => a.role === role).length + ' agents', cx, b.y + (sm ? 48 : 56));
  });
}
function sideBoxes(ctx) {
  const sm = G.small;
  const box = (b, title, value, sub, color) => {
    dashedBox(ctx, b, false); const c = center(b); ctx.textAlign = 'center';
    ctx.font = DFONT(sm ? 11 : 14, 720); ctx.fillStyle = C.fg; ctx.fillText(title, c.x, b.y + (sm ? 17 : 22));
    ctx.font = DFONT(sm ? 14 : 18, 720); ctx.fillStyle = color; ctx.fillText(value, c.x, b.y + (sm ? 38 : 46));
    ctx.font = FONT(sm ? 8.5 : 10.5); ctx.fillStyle = C.muted; ctx.fillText(sub, c.x, b.y + (sm ? 54 : 64));
  };
  box(G.rentBox, 'Rent', money(eco.cfg.rent), 'every ' + eco.cfg.rentInterval + ' tasks', C.brass);
  const born = eco.births.good + eco.births.bad + eco.births.replenish + eco.births.recovery;
  box(G.lifeBox, 'Removed', String(eco.bankruptCount), born + ' born', C.fail);
}
function drawAgent(ctx, v, a, o) {
  const q = a ? quality(a) : 0.5, r = v.r * v.scale; if (r < 1) return;
  const y = v.y - (v.lift || 0);
  ctx.globalAlpha = v.alpha * (o.dim ? 0.3 : 1);
  if (o.glow) { ctx.shadowColor = 'rgba(231,183,94,0.7)'; ctx.shadowBlur = 22; }
  ctx.fillStyle = skillColor(q); ctx.beginPath(); ctx.arc(v.x, y, r, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
  const rr = r + 3.5; ctx.lineWidth = r > 12 ? 3 : 2.2;
  ctx.strokeStyle = C.line; ctx.beginPath(); ctx.arc(v.x, y, rr, 0, 7); ctx.stroke();
  const frac = clamp(v.disp / 150, 0, 1);
  if (frac > 0) { ctx.strokeStyle = C.brass; ctx.beginPath(); ctx.arc(v.x, y, rr, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); ctx.stroke(); }
  if (r >= 9) { ctx.font = FONT(Math.max(9, r * 0.72), 700); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = q > 0.55 ? C.ink2 : C.fg; ctx.fillText(String(Math.round(q * 100)), v.x, y + 0.5); ctx.textBaseline = 'alphabetic'; }
  if (a && r >= 9) {
    ctx.font = FONT(G.small ? 10 : 11.5, 700); ctx.textAlign = 'center';
    const lbl = a.bid == null ? 'new' : f0(a.bid), ly = y + rr + (G.small ? 12 : 14);
    if (G.small && (o.awake || o.glow) && a.bid != null) { const tw = ctx.measureText(lbl).width + 8; ctx.fillStyle = C.brass; rrect(ctx, v.x - tw / 2, ly - 10, tw, 13, 4); ctx.fill(); ctx.fillStyle = C.ink2; }
    else ctx.fillStyle = a.bid == null ? C.muted : C.brass;
    ctx.fillText(lbl, v.x, ly);
  }
  if (o.awake) { ctx.strokeStyle = C.fg; ctx.lineWidth = 1.2; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.arc(v.x, y, rr + 4.5, 0, 7); ctx.stroke(); ctx.setLineDash([]); }
  if (o.selected) { ctx.strokeStyle = C.brass; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(v.x, y, rr + 8, 0, 7); ctx.stroke(); }
  if (o.failFlash) { ctx.strokeStyle = C.fail; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(v.x, y, rr + 2, 0, 7); ctx.stroke(); }
  if (v.dying) { ctx.strokeStyle = C.fail; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(v.x - r * 0.7, y - r * 0.7); ctx.lineTo(v.x + r * 0.7, y + r * 0.7); ctx.moveTo(v.x + r * 0.7, y - r * 0.7); ctx.lineTo(v.x - r * 0.7, y + r * 0.7); ctx.stroke(); }
  ctx.globalAlpha = 1;
}
function drawArena(now) {
  const { ctx, w, h } = fit(arena); G = geometry(); ctx.clearRect(0, 0, w, h);
  const p = cur ? clamp(cur.t / cur.d, 0, 1) : 0;
  ctx.fillStyle = 'rgba(151,163,183,0.06)';
  for (let y = G.top; y < h; y += 22) for (let x = G.side + 11; x < w - G.side; x += 22) ctx.fillRect(x, y, 1.2, 1.2);
  ctx.strokeStyle = C.line; ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) { const x = G.cols[i].x0; ctx.beginPath(); ctx.moveTo(x, G.top - 12); ctx.lineTo(x, h - 8); ctx.stroke(); }
  drawTop(ctx); drawFlow(ctx); drawStations(ctx); sideBoxes(ctx);
  const wid = activeWinner != null ? activeWinner : cur && cur.k === 'auction' && p > 0.6 ? cur.ev.winner : null;
  if (wid != null) { const v = vis.get(wid); if (v) { const tb = G.task; ctx.strokeStyle = C.brass; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(v.x, v.y - v.r - 6); ctx.lineTo(clamp(v.x, tb.x + 20, tb.x + tb.w - 20), tb.y + tb.h); ctx.stroke(); ctx.setLineDash([]); } }
  for (const v of vis.values()) { if (v.link == null) continue; const pv = vis.get(v.link); if (!pv) continue; ctx.strokeStyle = C.fg; ctx.globalAlpha = 0.5; ctx.lineWidth = 1.2; ctx.setLineDash(v.kind === 'bad' ? [3, 4] : []); ctx.beginPath(); ctx.moveTo(pv.x, pv.y); ctx.lineTo(v.x, v.y); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; }
  const inAuction = cur && cur.k === 'auction';
  const awakeIds = activeAuction ? new Set(activeAuction.bids.map((b) => b.id)) : null;
  for (const v of vis.values()) {
    const a = agentOf(v.id);
    if (v.dying && cur && cur.k === 'bankrupt' && cur.ev.id === v.id) { v.alpha = 1 - p; v.scale = 1 - p * 0.5; }
    if (cur && cur.k === 'birth' && cur.ev.id === v.id) v.scale = ease(p);
    const isWin = activeWinner === v.id || (inAuction && cur.ev.winner === v.id && p > 0.6);
    v.lift = isWin ? 6 : 0;
    drawAgent(ctx, v, a, { glow: isWin, dim: !!awakeIds && !awakeIds.has(v.id), awake: !!awakeIds && awakeIds.has(v.id) && !isWin, selected: selected && selected.kind === 'agent' && selected.id === v.id, failFlash: flashFail && flashFail.id === v.id && now - flashFail.t0 < 900 });
  }
  if (inAuction && cur.ev.byAuction && !G.small) {
    for (const b of cur.ev.bids) {
      const v = vis.get(b.id); if (!v || b.bid == null) continue;
      const rise = ease(Math.min(1, p * 1.8)) * 12, win = b.id === cur.ev.winner;
      ctx.globalAlpha = win ? 1 : 1 - Math.max(0, (p - 0.6) / 0.4);
      ctx.font = FONT(G.small ? 11 : 13, 700); ctx.textAlign = 'center';
      const tx = 'bid ' + f0(b.bid), tw = ctx.measureText(tx).width + 10, y = v.y - v.r - 14 - rise;
      ctx.fillStyle = win && p > 0.6 ? C.brass : C.ink2; rrect(ctx, v.x - tw / 2, y - 13, tw, 18, 5); ctx.fill();
      ctx.strokeStyle = C.brass; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = win && p > 0.6 ? C.ink2 : C.brass; ctx.fillText(tx, v.x, y + 0.5); ctx.globalAlpha = 1;
    }
  }
  const coin = (from, to, label, t, neg) => {
    const e = ease(clamp(t, 0, 1)), mx = (from.x + to.x) / 2, my = Math.min(from.y, to.y) - 46;
    const at = (u) => ({ x: (1 - u) * (1 - u) * from.x + 2 * (1 - u) * u * mx + u * u * to.x, y: (1 - u) * (1 - u) * from.y + 2 * (1 - u) * u * my + u * u * to.y });
    for (let k = 3; k >= 1; k--) { const c = at(Math.max(0, e - k * 0.04)); ctx.globalAlpha = 0.14 * (4 - k); ctx.fillStyle = neg ? C.fail : C.brass; ctx.beginPath(); ctx.arc(c.x, c.y, 5, 0, 7); ctx.fill(); }
    ctx.globalAlpha = 1; const c = at(e);
    ctx.fillStyle = neg ? C.fail : C.brass; ctx.beginPath(); ctx.arc(c.x, c.y, 7.5, 0, 7); ctx.fill();
    if (label) { ctx.font = FONT(G.small ? 11.5 : 13, 700); ctx.textAlign = 'center'; ctx.fillText(label, c.x, c.y - 13); }
  };
  if (cur && cur.k === 'pay') coin(posOf(cur.ev.from), posOf(cur.ev.to), f0(cur.ev.amount), p, false);
  if (cur && cur.k === 'rewards') cur.ev.list.forEach((r, i) => { const neg = r.amount < 0, a = posOf('score'), b = posOf(r.to); coin(neg ? b : a, neg ? a : b, (r.amount > 0 ? '+' : '') + f0(r.amount), p - i * 0.05, neg); });
  floats = floats.filter((f) => now - f.t0 < f.dur);
  for (const f of floats) { const t = (now - f.t0) / f.dur; ctx.globalAlpha = 1 - t * t; ctx.fillStyle = f.color; ctx.font = FONT(G.small ? 11 : 12.5, 700); ctx.textAlign = f.align; ctx.fillText(f.text, f.x, f.y - t * 12); ctx.globalAlpha = 1; }
  if (replaying || (!playing && !stepping)) { ctx.font = FONT(12.5, 700); ctx.textAlign = 'right'; ctx.fillStyle = replaying ? C.brass : C.muted; ctx.fillText(replaying ? 'Replaying task ' + (lastRec ? lastRec.episode : '') : tour.on ? 'Tour' : 'Paused', w - 12, h - 10); }
  if (tour.on) drawTourSpot(ctx, w, h);
}
function moveToward(dt) { const k = 1 - Math.pow(0.001, dt / 500); for (const v of vis.values()) { v.x = lerp(v.x, v.tx, k); v.y = lerp(v.y, v.ty, k); } }

// ======================= tour =======================
const TOUR = [
  { t: 'Watch a market train a team', x: 'These are AI agents with no boss. A market decides who works, who gets paid, who dies, and whose instructions get copied or rewritten. It takes about a minute to see how.', first: true },
  { t: 'The problem', x: 'Each task is a problem with 1 to 3 steps. The boxes fill in as steps get solved: white if right, red if wrong. The agents cannot see this, only we can. The team gets 10 turns.', spot: 'task' },
  { t: 'Four jobs', x: 'Planners write a plan. Executors solve one step per turn. Verifiers check the latest step. The answer agent submits the answer, or waits if the work is unfinished.', spot: 'stations' },
  { t: 'How to read an agent', x: 'The number inside says how good it is at its job. The brass ring is its credits. The number below is its bid, the price it pays for a turn. Bids never change.', spot: 'agent' },
  { t: 'Who wakes up', x: 'Each agent has its own wake-up rules, part of its "prompt". In each situation some agents wake up (dashed ring) and the rest sleep. A few rules come from the authors\' code: the planner starts first, nobody acts twice in a row, and the answer agent always wakes after an executor.', spot: 'cols' },
  { t: 'Highest bid wins', x: 'Among the awake agents, the highest bid gets the turn. The winner pays its bid to the agent that acted just before it. The first one pays the House.', spot: 'house' },
  { t: 'Right or wrong, everyone feels it', x: 'In the authors\' released code, a right answer pays everyone on the workflow, and a wrong or missing answer charges them all. The answer agent gets an extra half either way.', spot: 'score' },
  { t: 'Rent, bankruptcy and replays', x: 'Every 3 tasks everyone pays rent. Agents that go below zero are removed. If that happens mid-task, the others get their credits back and the task is replayed (Alg. 1).', spot: 'rent' },
  { t: 'Copy the rich, repair the failed', x: 'New agents keep arriving. Copies of the richest agent get a small change. Repaired versions of failed agents get the weakness from their failure fixed, like a prompt rewritten after a mistake.', spot: 'cols' },
  { t: 'So the team gets better', x: 'The test score is the frozen team on 200 fixed problems, checked every 10 tasks. Watch it climb as useful agents survive and useless ones go broke.', spot: 'score' },
  { t: 'Your turn', x: 'Tap any agent to read its "prompt" and see why it is winning or dying. Use Fast or +10 tasks to see training. Then scroll down for the experiments and the real AI mode.', last: true },
];
function tourRect() {
  const s = TOUR[tour.i].spot; if (!s) return null; const pad = 6;
  const grow = (b) => ({ x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 });
  switch (s) {
    case 'task': return grow(G.task);
    case 'stations': { const a = G.st[0], b = G.st[3]; return grow({ x: a.x, y: a.y, w: b.x + b.w - a.x, h: a.h }); }
    case 'agent': { const v = roleList('executor')[0]; if (!v) return null; const r = v.r + 16; return { x: v.x - r - 6, y: v.y - r, w: r * 2 + 12, h: r * 2 + 18 }; }
    case 'cols': return { x: G.side, y: G.st[0].y - pad, w: G.w - G.side * 2, h: G.h - G.st[0].y };
    case 'house': return grow({ x: G.house.x, y: G.house.y, w: G.st[1].x + G.st[1].w - G.house.x, h: G.st[1].y + G.st[1].h - G.house.y });
    case 'score': return grow(G.score);
    case 'rent': return grow(G.rentBox);
  }
  return null;
}
function drawTourSpot(ctx, w, h) {
  const r = tourRect(); ctx.save(); ctx.fillStyle = 'rgba(9,13,20,0.66)'; ctx.beginPath(); ctx.rect(0, 0, w, h);
  if (r) { if (ctx.roundRect) ctx.roundRect(r.x, r.y, r.w, r.h, 12); else ctx.rect(r.x, r.y, r.w, r.h); }
  ctx.fill('evenodd'); if (r) { ctx.strokeStyle = C.brass; ctx.lineWidth = 2; rrect(ctx, r.x, r.y, r.w, r.h, 12); ctx.stroke(); } ctx.restore();
}
function showTour(i) {
  tour.i = clamp(i, 0, TOUR.length - 1); const s = TOUR[tour.i];
  $('tour').hidden = false; $('tourTitle').textContent = s.t; $('tourText').textContent = s.x;
  $('tourCount').textContent = s.first ? 'Guided tour' : 'Step ' + tour.i + ' of ' + (TOUR.length - 1);
  $('tourBack').hidden = !!s.first; $('tourNext').textContent = s.first ? 'Start the tour' : s.last ? 'Start watching' : 'Next'; $('tourSkip').textContent = s.first ? 'Just watch' : 'Skip';
}
$('tourNext').addEventListener('click', () => { const s = TOUR[tour.i]; if (s.first) { tour.on = true; showTour(1); return; } if (s.last) { tour.on = false; $('tour').hidden = true; setSpeed('normal'); setPlay(true); return; } showTour(tour.i + 1); });
$('tourBack').addEventListener('click', () => showTour(tour.i - 1));
$('tourSkip').addEventListener('click', () => { const first = TOUR[tour.i].first; tour.on = false; $('tour').hidden = true; if (!first) setPlay(true); });
$('bTour').addEventListener('click', () => { tour.on = true; showTour(1); $('live').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' }); });

// ======================= loop =======================
let last = performance.now();
function frame(now) {
  const dt = Math.min(64, now - last); last = now;
  if (eco) { G = geometry(); advance(dt); layoutTargets(false); moveToward(dt); drawArena(now); }
  laneTick();
  requestAnimationFrame(frame);
}

// ======================= clicks and inspector =======================
const inBox = (b, x, y) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
function hitAgent(x, y) { let best = null, bd = 1e9; for (const v of vis.values()) { const d = Math.hypot(v.x - x, v.y - y); if (d < Math.max(v.r + 10, 18) && d < bd) { bd = d; best = v; } } return best; }
arena.addEventListener('click', (e) => {
  if (tour.on) return;
  const r = arena.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, v = hitAgent(x, y);
  if (v) selected = { kind: 'agent', id: v.id };
  else if (inBox(G.house, x, y)) selected = { kind: 'house' };
  else if (inBox(G.score, x, y)) selected = { kind: 'score' };
  else if (inBox(G.task, x, y)) selected = { kind: 'task' };
  else if (inBox(G.rentBox, x, y)) selected = { kind: 'rent' };
  else if (inBox(G.lifeBox, x, y)) selected = { kind: 'life' };
  else { const i = G.st.findIndex((b) => inBox(b, x, y)); selected = i >= 0 ? { kind: 'station', role: ROLES[i] } : null; }
  renderInspector();
});
arena.addEventListener('mousemove', (e) => { const r = arena.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top; arena.style.cursor = !tour.on && (hitAgent(x, y) || G.st.some((b) => inBox(b, x, y)) || inBox(G.task, x, y)) ? 'pointer' : 'default'; });
function originText(a) {
  switch (a.kind) {
    case 'founder': return 'One of the five weak starting agents.';
    case 'good': return 'A copy of ' + (a.parentName || 'an agent') + ', the richest agent when it was born. Change: it ' + (a.amendNote || 'got a small change') + '.';
    case 'bad': return 'A repaired version of ' + (a.parentName || 'an agent') + '. The old version ' + (a.amendNote || 'failed') + '.';
    case 'template': return 'A fresh agent added to keep the team big enough.';
    case 'overbidder': return 'The overbidder you added: a lazy planner with a huge bid.';
    default: return 'A scripted agent.';
  }
}
function renderInspector() {
  const el = $('inspector'); if (!eco) return;
  if (!selected) { el.innerHTML = '<h3>Tap anything</h3><p class="muted">Tap an agent to read its "prompt" and see why it is winning or dying. Tap the problem card, a job, the House, the test box or a ledger line to see what it does.</p><div class="why"><p><b>The idea in one line:</b> agents earn when the team succeeds and when the next agent takes over from them. So helpful agents get rich and get copied, and unhelpful ones go broke and get repaired.</p></div>'; return; }
  const k = selected.kind;
  if (k === 'house') { el.innerHTML = '<h3>The House</h3><div class="why"><p>The first agent in each task has nobody before it to pay, so its bid goes here (Eq. 1). Collected so far: <b class="brass">' + money(eco.house) + '</b>.</p></div>'; return; }
  if (k === 'score') { const c = checkpoints[checkpoints.length - 1]; el.innerHTML = '<h3>Test score</h3><div class="why"><p>Every 10 tasks, a frozen copy of the team tries 200 fixed test problems with no money moving (Alg. 2). Each checkpoint faces exactly the same dice, so scores are comparable.</p><p class="eq">Now: <b>' + pct(c.acc) + '</b>. Before training: ' + pct(checkpoints[0].acc) + '. By level: ' + c.byLevel.map((x, i) => 'L' + (i + 1) + ' ' + pct(x)).join(', ') + '.</p><p>Rewards follow the released code: a right answer is worth +' + f0(eco.cfg.reward) + ', a wrong or missing one ' + f0(-eco.cfg.reward) + '.</p></div>'; return; }
  if (k === 'task') { el.innerHTML = '<h3>The problem</h3><div class="why"><p>Levels 1 to 5 have ' + E.LEVELS.parts.join(', ') + ' steps. A step is right with a chance that falls with the level and rises with the executor\'s skill and the plan\'s quality.</p><p>The answer is right only if every step is done and right. Verifiers can catch a wrong step and flag it, and the next executor fixes it. All of this has to fit in 10 turns.</p><p class="muted">This toy problem stands in for the paper\'s real math and research problems. The Real AI mode section uses real ones.</p></div>'; return; }
  if (k === 'rent') { el.innerHTML = '<h3>Rent</h3><div class="why"><p>Every ' + eco.cfg.rentInterval + ' tasks every agent pays ' + money(eco.cfg.rent) + ' (the released research config: 0.2 every 3 tasks, x100). Idle agents only pay, so rent removes them.</p><p class="eq">Collected so far: <b class="brass">' + money(eco.rentCollected) + '</b></p></div>'; return; }
  if (k === 'life') { const b = eco.births; el.innerHTML = '<h3>Removed and born</h3><div class="why"><p>Removed when credits go below zero. After a bankruptcy: 33% a copy of the richest, 33% a repaired version of the bankrupt agent. Every 3 tasks two more are born, half copies, half repairs of the poorest.</p><p class="eq">Removed: <b>' + eco.bankruptCount + '</b>. Copies: <b>' + b.good + '</b>. Repairs: <b>' + b.bad + '</b>. Role recoveries: <b>' + b.recovery + '</b>.</p><p class="eq">Births by job: ' + ROLES.map((r) => LABEL[r] + ' ' + eco.birthsByRole[r]).join(', ') + '.</p></div>'; return; }
  if (k === 'station') { const r = selected.role, list = eco.agents.filter((a) => a.role === r); el.innerHTML = '<h3>' + LABEL[r] + 's</h3><div class="why"><p>' + list.length + ' alive. Bids: ' + (list.map((a) => a.name + ' ' + (a.bid == null ? 'new' : f0(a.bid))).join(', ') || 'none') + '.</p><p>' + { planner: 'A planner starts every task on its own. Its plan makes later steps more likely to be right.', executor: 'Executors solve one step per turn and fix flagged steps. They cannot act twice in a row.', verifier: 'Verifiers check the latest step and flag errors. They also sometimes flag correct work.', answer: 'The answer agent always wakes after an executor (a rule in the released code). It can submit, or wait if the work is unfinished.' }[r] + '</p></div>'; return; }
  if (k === 'event') { renderEventExplain(selected.idx); return; }
  const a = agentOf(selected.id); if (!a) { selected = null; renderInspector(); return; }
  const d = eco.describe(a), q = quality(a);
  let why;
  if (!a.alive) why = '<p class="bad">Went bankrupt at task ' + a.diedAt + ' and was removed.</p>';
  else if (a.bid == null) why = '<p>It has not bid yet. The first time it wakes up it will bid the top competing bid plus ' + f1(eco.cfg.epsilon) + ' (Eq. 2), so it is sure to get one turn.</p>';
  else {
    const rivals = eco.agents.filter((x) => x.role === a.role && x.bid != null && x.bid > a.bid);
    why = rivals.length ? '<p>' + rivals.length + ' other ' + NOUN[a.role] + (rivals.length > 1 ? 's bid' : ' bids') + ' more. It wins only in situations where they sleep and it is awake.</p>' : '<p>It has the top bid among ' + NOUN[a.role] + 's, so it wins whenever it is awake.</p>';
    why += '<p>Money: earned ' + f0(a.earned) + ' from next agents and ' + f0(a.rewardIn) + ' from rewards. Paid ' + f0(a.paid) + ' in bids and ' + f0(a.rentPaid) + ' rent.</p>';
  }
  el.innerHTML = '<h3>' + a.name + ', ' + NOUN[a.role] + '</h3><p class="muted">' + esc(originText(a)) + '</p>' +
    '<dl class="kv"><dt>Good at its job</dt><dd>' + pct(q) + '</dd><dt>Bid</dt><dd class="brass">' + (a.bid == null ? 'not set yet' : f0(a.bid) + ' <span class="muted">fixed for life</span>') + '</dd><dt>Credits</dt><dd>' + money(a.wealth) + '</dd><dt>Turns won</dt><dd>' + a.wins + '</dd><dt>Generation</dt><dd>' + a.generation + '</dd></dl>' +
    '<div class="prompt"><b>Its "prompt"</b><span>' + esc(d.text) + '</span><span class="muted">Wakes up when:</span><ul>' + (d.wakes.map((x) => '<li>' + esc(x) + '</li>').join('') || '<li>never, except where the hard rules force it</li>') + '</ul></div>' +
    '<div class="why">' + why + '</div>';
}

// ======================= ledger =======================
function evLine(ev) {
  switch (ev.type) {
    case 'trial': return ev.trial === 1 ? 'Level ' + ev.task.level + ' problem' : 'Replay of the task';
    case 'novice': return nm(ev.id) + ' sets its bid: ' + f0(ev.high) + ' + ' + f1(ev.bid - ev.high) + ' = ' + f1(ev.bid);
    case 'auction': return 'Turn ' + (ev.step + 1) + ': ' + nm(ev.winner) + (ev.terminal ? ' (last turn, answer only)' : ev.byAuction ? ' wins, ' + ev.bids.length + ' awake' : ' picked at random');
    case 'pay': return nm(ev.from) + ' pays ' + nm(ev.to) + ' ' + f0(ev.amount);
    case 'act': return nm(ev.id) + ': ' + ({ plan: 'plans', replan: 'plans again', step: 'solves step ' + ((ev.index || 0) + 1) + (ev.ok ? '' : ' (wrong)'), fix: 'fixes the flagged step' + (ev.ok ? '' : ' (still wrong)'), polish: 'reworks a done step', nothing: 'nothing to check', check: ev.flagged ? 'flags an error' + (ev.partOk ? ' (false alarm)' : '') : ev.partOk ? 'passes the step' : 'misses an error', abstain: 'waits, work unfinished', submit: ev.success ? 'answers, right' : 'answers, wrong' }[ev.kind] || ev.kind);
    case 'reward': return nm(ev.to) + (ev.why === 'answer' ? ' answer bonus ' : ev.why === 'path' ? ' workflow share ' : ' reward ') + (ev.amount > 0 ? '+' : '') + f1(ev.amount);
    case 'rent': return 'Rent: ' + f0(ev.amount) + ' from each of ' + ev.n;
    case 'bankrupt': return nm(ev.id) + ' goes bankrupt (' + f1(ev.wealth) + ')';
    case 'rollback': return 'Rollback: survivors get their credits back';
    case 'birth': return nm(ev.id) + ' born: ' + (ev.kind === 'good' ? 'copy of ' + nm(ev.parent) : ev.kind === 'bad' ? 'repair of ' + nm(ev.parent) : 'fresh');
    case 'no-eligible': return 'Nobody wakes up, the task stops';
    default: return ev.type;
  }
}
const isBadEv = (ev) => (ev.type === 'act' && (((ev.kind === 'step' || ev.kind === 'fix') && !ev.ok) || (ev.kind === 'submit' && !ev.success))) || ev.type === 'bankrupt' || ev.type === 'no-eligible' || (ev.type === 'reward' && ev.amount < 0);
function renderLedger() {
  const ol = $('ledgerList');
  if (!lastRec) { ol.innerHTML = '<li class="muted" style="padding:4px 8px">The first task is running.</li>'; return; }
  ol.innerHTML = '';
  lastRec.events.forEach((ev, i) => {
    const li = document.createElement('li');
    if (ev.type === 'trial') { li.className = 'sep'; li.textContent = evLine(ev); ol.appendChild(li); return; }
    const b = document.createElement('button'); b.textContent = evLine(ev); if (isBadEv(ev)) b.classList.add('bad');
    if (selected && selected.kind === 'event' && selected.idx === i && selected.rec === lastRec) b.setAttribute('aria-current', 'true');
    b.addEventListener('click', () => { selected = { kind: 'event', idx: i, rec: lastRec }; renderInspector(); renderLedger(); });
    li.appendChild(b); ol.appendChild(li);
  });
  document.querySelector('#ledger h3').textContent = 'Ledger, task ' + lastRec.episode + (lastRec.success ? ' (solved)' : ' (failed)');
}
function renderEventExplain(idx) {
  const rec = selected.rec || lastRec, ev = rec && rec.events[idx], el = $('inspector');
  if (!ev) { selected = null; renderInspector(); return; }
  const t = {
    novice: 'A newcomer bids the highest veteran bid among the agents awake right now, plus the premium. So it is sure to win this auction and get tested once (Eq. 2). Its bid then never changes.',
    auction: ev.byAuction ? 'Only agents whose wake-up rules match this situation take part: ' + sitText(ev.sit) + '. Highest bid wins (Sec. 2.2). Being good at the job does not win auctions. It decides who can keep paying.' : 'The auction is off, so a random awake agent acts.',
    pay: ev.to === 'house' ? 'The first actor has nobody before it, so its bid goes to the House (Eq. 1).' : 'The winner pays its bid to whoever acted just before it (Eq. 1). Earlier helpers get paid when the next agent takes over from them.',
    act: 'In this toy, steps succeed with a chance set by the executor\'s skill, the plan and the level. Verifiers catch errors at their detection rate.',
    reward: ev.why === 'answer' ? 'The released code gives the answer agent half of the score: +' + f0(eco.cfg.reward / 2) + ' for right, ' + f0(-eco.cfg.reward / 2) + ' for wrong.' : ev.why === 'path' ? 'The released code splits the score over every turn on the workflow, so everyone who worked shares the credit or the blame.' : 'Reward under the rule you picked.',
    rent: 'Rent every ' + eco.cfg.rentInterval + ' tasks keeps idle agents from living forever.',
    bankrupt: 'Credits below zero: removed (code: wealth < 0). This may trigger a copy of the richest or a repair of this one.',
    rollback: 'Alg. 1: if anyone goes bankrupt during a task, survivors get their credits back and the task is replayed, up to 2 tries.',
    birth: ev.kind === 'good' ? 'Exploitation: the richest agent is copied with a small change. Here it ' + (ev.note || 'got a small change') + '.' : 'Exploration: a failed agent is rewritten using its failure trace. ' + (ev.note ? 'The old version ' + ev.note + '.' : ''),
    'no-eligible': 'Nobody\'s wake-up rules matched this situation, so the team stopped. In the released code, this ends the episode.',
  }[ev.type] || '';
  el.innerHTML = '<h3>' + esc(evLine(ev)) + '</h3><div class="why"><p>' + esc(t) + '</p></div>';
}

// ======================= stats, charts, traits, flows =======================
function updateStats() {
  $('sScore').textContent = pct(checkpoints[checkpoints.length - 1].acc);
  $('sStart').textContent = pct(checkpoints[0].acc);
  $('sTask').textContent = eco.episode;
  $('sPop').textContent = eco.agents.length;
}
function drawCharts() { drawScore(); drawLevels(); drawPrices(); }
function yAxis(ctx, L, T, pw, ph, ticks) {
  ctx.font = FONT(11.5); ctx.fillStyle = C.muted; ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.textAlign = 'right';
  for (const s of ticks) { const y = T + (1 - s) * ph; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke(); ctx.fillText(pct(s), L - 6, y + 4); }
}
function drawScore() {
  const { ctx, w, h } = fit($('chartScore')); ctx.clearRect(0, 0, w, h);
  const L = 42, Rr = 54, T = 10, B = 26, pw = w - L - Rr, ph = h - T - B;
  const xMax = Math.max(100, checkpoints[checkpoints.length - 1].episode);
  const X = (t) => L + (t / xMax) * pw, Y = (s) => T + (1 - s) * ph;
  yAxis(ctx, L, T, pw, ph, [0, 0.25, 0.5, 0.75, 1]);
  ctx.textAlign = 'center'; ctx.fillStyle = C.muted; ctx.font = FONT(11.5);
  for (let i = 0; i <= 4; i++) { const t = Math.round((xMax * i) / 4); ctx.fillText(t, X(t), h - 8); }
  for (const m of markers) { ctx.strokeStyle = C.muted; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(X(m.t), T); ctx.lineTo(X(m.t), T + ph); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = C.muted; ctx.textAlign = 'left'; ctx.font = FONT(10.5); ctx.fillText(m.label, X(m.t) + 3, T + 11); }
  ctx.beginPath(); R.full.curve.forEach((c, i) => (i ? ctx.lineTo(X(c.episode), Y(c.acc)) : ctx.moveTo(X(c.episode), Y(c.acc))));
  ctx.strokeStyle = C.muted; ctx.lineWidth = 1.6; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
  const lr = R.full.curve[R.full.curve.length - 1]; ctx.fillStyle = C.muted; ctx.font = FONT(11, 700); ctx.textAlign = 'left'; ctx.fillText('avg ' + pct(lr.acc), X(lr.episode) + 6, Y(lr.acc) + 14);
  ctx.beginPath(); checkpoints.forEach((c, i) => (i ? ctx.lineTo(X(c.episode), Y(c.acc)) : ctx.moveTo(X(c.episode), Y(c.acc))));
  ctx.strokeStyle = C.fg; ctx.lineWidth = 2.6; ctx.stroke();
  for (const c of checkpoints) { ctx.fillStyle = C.fg; ctx.beginPath(); ctx.arc(X(c.episode), Y(c.acc), 3, 0, 7); ctx.fill(); }
  const lc = checkpoints[checkpoints.length - 1]; ctx.font = FONT(13, 700); ctx.fillStyle = C.fg; ctx.textAlign = 'left'; ctx.fillText(pct(lc.acc), X(lc.episode) + 7, Y(lc.acc) - 6);
  ctx.fillStyle = C.brass; ctx.fillRect(X(Math.min(eco.episode, xMax)) - 1, T + ph - 6, 2, 6);
}
function drawLevels() {
  const { ctx, w, h } = fit($('chartLevels')); ctx.clearRect(0, 0, w, h);
  const L = 42, T = 16, B = 26, pw = w - L - 10, ph = h - T - B;
  yAxis(ctx, L, T, pw, ph, [0, 0.25, 0.5, 0.75, 1]);
  const a = checkpoints[0].byLevel, b = checkpoints[checkpoints.length - 1].byLevel, gw = pw / 5, bw = Math.min(26, gw * 0.32);
  for (let i = 0; i < 5; i++) {
    const cx = L + gw * (i + 0.5);
    ctx.fillStyle = C.line; ctx.fillRect(cx - bw - 2, T + (1 - a[i]) * ph, bw, a[i] * ph);
    ctx.fillStyle = C.fg; ctx.fillRect(cx + 2, T + (1 - b[i]) * ph, bw, b[i] * ph);
    ctx.fillStyle = C.muted; ctx.font = FONT(11.5); ctx.textAlign = 'center'; ctx.fillText('Level ' + (i + 1), cx, h - 8);
    ctx.fillStyle = C.fg; ctx.font = FONT(11, 700); ctx.fillText(pct(b[i]), cx + 2 + bw / 2, T + (1 - b[i]) * ph - 5);
  }
}
const TRAIT_ROWS = [
  { k: 'thorough', label: 'Planner thoroughness', lo: 0, hi: 1 },
  { k: 'skill', label: 'Executor skill', lo: -0.3, hi: 0.35 },
  { k: 'selfCheck', label: 'Executor self-checking', lo: 0, hi: 0.9 },
  { k: 'detect', label: 'Verifier error-catching', lo: 0, hi: 0.98 },
  { k: 'patience', label: 'Answer agent waits when unfinished', lo: 0, hi: 1 },
];
function renderTraits() {
  const now = traitAverages(eco.agents);
  $('traits').innerHTML = TRAIT_ROWS.map((r) => {
    const n = now[r.k], s = founderTraits[r.k];
    const fr = (x) => (x == null ? 0 : clamp((x - r.lo) / (r.hi - r.lo), 0, 1) * 100);
    const show = (x) => (x == null ? '-' : r.k === 'skill' ? (x >= 0 ? '+' : '') + x.toFixed(2) : pct(x));
    return '<div class="trait"><span>' + r.label + '</span><span class="track"><span class="now" style="width:' + fr(n) + '%"></span><span class="was" style="left:calc(' + fr(s) + '% - 1px)"></span></span><b>' + show(n) + '</b></div>';
  }).join('');
}
const chipRow = (path) => '<span class="chips">' + path.map((r) => '<span class="chip ' + SHORT[r] + '">' + SHORT[r] + '</span>').join('') + '</span>';
function renderFlows() {
  const list = eco.paths.slice(-12).reverse();
  $('liveFlows').innerHTML = list.length ? list.map((p) => '<li><span class="muted">Task ' + p.episode + ', L' + p.level + '</span>' + chipRow(p.path) + '<b class="' + (p.success ? '' : 'bad') + '">' + (p.success ? 'ok' : 'x') + '</b></li>').join('') : '<li class="muted">No tasks yet.</li>';
}
function drawPrices() {
  const { ctx, w, h } = fit($('chartPrice')); ctx.clearRect(0, 0, w, h);
  const rows = eco.sitStats.map((s, i) => ({ label: SITS[i].label, bid: s.wins ? s.bidSum / s.wins : null, val: s.wins ? s.payoffSum / s.wins : null, n: s.wins }));
  const max = Math.max(10, ...rows.map((r) => Math.max(r.bid || 0, r.val || 0))) * 1.12;
  const L = Math.min(230, w * 0.46), T = 6, rowH = (h - T - 4) / rows.length, bw = w - L - 40;
  let under = 0, counted = 0;
  rows.forEach((r, i) => {
    const y = T + i * rowH;
    ctx.fillStyle = C.fg; ctx.font = FONT(w < 500 ? 10.5 : 12); ctx.textAlign = 'left';
    const words = r.label.split(' '); let line = ''; const lines = [];
    for (const wd of words) { const t = line ? line + ' ' + wd : wd; if (ctx.measureText(t).width > L - 10) { lines.push(line); line = wd; } else line = t; } lines.push(line);
    lines.slice(0, 2).forEach((ln, k) => ctx.fillText(ln, 0, y + rowH * 0.42 + k * 13 - (lines.length > 1 ? 6 : 0)));
    if (!r.n) { ctx.fillStyle = C.muted; ctx.fillText('no wins yet', L, y + rowH * 0.5); return; }
    const bh = Math.min(10, rowH * 0.28);
    ctx.fillStyle = C.brass; ctx.fillRect(L, y + rowH * 0.5 - bh - 1, (r.bid / max) * bw, bh);
    ctx.fillStyle = C.muted; ctx.fillRect(L, y + rowH * 0.5 + 1, (Math.max(0, r.val) / max) * bw, bh);
    ctx.font = FONT(10.5, 700); ctx.fillStyle = C.brass; ctx.fillText(f0(r.bid), L + (r.bid / max) * bw + 4, y + rowH * 0.5 - 2);
    ctx.fillStyle = C.muted; ctx.fillText(f0(r.val), L + (Math.max(0, r.val) / max) * bw + 4, y + rowH * 0.5 + bh + 1);
    if (r.n >= 20) { counted++; if (r.bid <= r.val + eco.cfg.epsilon) under++; }
  });
  const rec = R.theorem1.filter((t) => t.wins && t.avgBid <= t.avgPayoff + 1).length;
  $('priceNote').textContent = 'This run so far: the price sits at or below the value in ' + under + ' of ' + counted + ' situations with enough wins. Over 30 recorded runs: ' + rec + ' of 8. The exceptions are where newcomers keep arriving and pushing the bid up, mostly the answer agent\'s turn right after an executor.';
}

// ======================= predict =======================
function askPrediction(ev) {
  awaiting = true; const ch = $('predChoices');
  $('predText').textContent = 'Situation: ' + sitText(ev.sit) + '. These agents are awake. Who gets the turn?';
  $('predReveal').hidden = true; $('predGo').hidden = true; ch.innerHTML = '';
  for (const b of ev.bids) {
    const a = agentOf(b.id), btn = document.createElement('button'); btn.className = 'btn choice';
    btn.innerHTML = '<b>' + esc(a ? a.name : b.id) + '</b><span class="muted">' + (a ? NOUN[a.role] + ', ' + pct(quality(a)) : '') + '</span><br><span class="brass">bid ' + (b.bid == null ? '?' : f0(b.bid)) + '</span>';
    btn.addEventListener('click', () => reveal(ev, b.id)); ch.appendChild(btn);
  }
  $('predict').hidden = false; const fb = ch.querySelector('button'); if (fb) fb.focus({ preventScroll: true });
}
function reveal(ev, pick) {
  const win = ev.winner, best = Math.max(...ev.bids.map((b) => b.bid || 0));
  [...$('predChoices').children].forEach((b, i) => { b.disabled = true; if (ev.bids[i].id === win) b.dataset.win = 'true'; });
  $('predReveal').innerHTML = (pick === win ? '<b class="brass">Right.</b> ' : '<b>Not this time.</b> ') + esc(nm(win)) + ' wins with the highest bid (' + f0(best) + '). Being good at the job does not win auctions. It decides who can keep paying.';
  $('predReveal').hidden = false; $('predGo').hidden = false; $('predGo').focus({ preventScroll: true });
}
$('predGo').addEventListener('click', () => { $('predict').hidden = true; awaiting = false; });
$('predOff').addEventListener('click', () => { predictOn = false; setSwitch('tPredict', false); $('predict').hidden = true; awaiting = false; });

// ======================= controls =======================
function setSwitch(id, on) { $(id).setAttribute('aria-checked', on ? 'true' : 'false'); }
function applyRule(key, val, label) { rules[key] = val; eco.cfg[key] = val; markers.push({ t: eco.episode, label }); drawCharts(); }
const sliders = [
  { id: 'cRent', out: 'oRent', key: 'rent', fmt: (v) => v, label: (v) => 'rent ' + v },
  { id: 'cReward', out: 'oReward', key: 'reward', fmt: (v) => v, label: (v) => 'reward ' + v },
  { id: 'cEps', out: 'oEps', key: 'epsilon', fmt: (v) => (+v).toFixed(1), label: (v) => 'premium ' + v },
];
function syncControls() {
  for (const s of sliders) { $(s.id).value = rules[s.key]; $(s.out).textContent = s.fmt(rules[s.key]); }
  $('cRewardRule').value = rules.rewardScheme;
  setSwitch('tAuction', rules.auction); setSwitch('tExplore', rules.exploration); setSwitch('tExploit', rules.exploitation); setSwitch('tFixed', rules.bidScheme === 'fixed'); setSwitch('tPredict', predictOn);
  $('cSeed').value = seed;
}
for (const s of sliders) { const el = $(s.id); el.addEventListener('input', () => { $(s.out).textContent = s.fmt(+el.value); }); el.addEventListener('change', () => applyRule(s.key, +el.value, s.label(+el.value))); }
$('cRewardRule').addEventListener('change', (e) => applyRule('rewardScheme', e.target.value, { released: 'released reward', outcome: 'Eq. 1 reward', chainSplit: 'shared reward' }[e.target.value]));
function bindSwitch(id, fn) { $(id).addEventListener('click', () => { const on = $(id).getAttribute('aria-checked') !== 'true'; setSwitch(id, on); fn(on); }); }
bindSwitch('tAuction', (on) => applyRule('auction', on, on ? 'auction on' : 'auction off'));
bindSwitch('tExplore', (on) => applyRule('exploration', on, on ? 'repair on' : 'repair off'));
bindSwitch('tExploit', (on) => applyRule('exploitation', on, on ? 'copy on' : 'copy off'));
bindSwitch('tFixed', (on) => applyRule('bidScheme', on ? 'fixed' : 'fixed_with_eps', on ? 'same bids' : 'Eq. 2 bids'));
bindSwitch('tPredict', (on) => { predictOn = on; if (on && !narrated()) setSpeed('normal'); });
$('bOver').addEventListener('click', () => {
  const top = Math.max(10, ...eco.agents.filter((a) => a.role === 'planner' && a.bid != null).map((a) => a.bid));
  const o = eco.addVeteran('planner', { thorough: 0.1 }, top + 40, null, 'overbidder');
  makeVis(o, { x: G.cols[0].cx, y: G.top }, 1); markers.push({ t: eco.episode, label: 'overbidder' });
  selected = { kind: 'agent', id: o.id }; renderInspector(); drawCharts();
  narrate('Overbidder added', '<b>' + o.name + '</b> joins with a bid of <b>' + f0(o.bid) + '</b> and a thin plan. It will start every task, overpay every time, and go broke.');
  $('live').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
});
$('bDefaults').addEventListener('click', () => { Object.assign(rules, RULE_DEFAULTS); Object.assign(eco.cfg, RULE_DEFAULTS); markers.push({ t: eco.episode, label: 'rules reset' }); syncControls(); drawCharts(); });
$('bRestart').addEventListener('click', () => { seed = Math.max(1, Math.floor(+$('cSeed').value || 5)); newEconomy(); });
function setPlay(on) { playing = on; $('bPlay').textContent = on ? 'Pause' : 'Play'; }
$('bPlay').addEventListener('click', () => setPlay(!playing));
$('bStep').addEventListener('click', () => {
  setPlay(false);
  while (cur || queue.length) { if (!cur) { cur = queue.shift(); onStart(cur); } const d = cur; cur = null; onEnd(d); }
  startTask(); stepping = true;
  if (isTurbo()) { while (queue.length) { const st = queue.shift(); onStart(st); onEnd(st); } stepping = false; }
});
function setSpeed(k) { speedKey = k; [...$('speedSeg').children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.s === k))); if (predictOn && !narrated()) { predictOn = false; setSwitch('tPredict', false); } }
$('speedSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setSpeed(b.dataset.s); });
$('bReplay').addEventListener('click', () => {
  if (!lastRec || !lastSnap) return;
  if (!replaying) playingBeforeReplay = playing;
  queue = []; cur = null; awaiting = false; $('predict').hidden = true; restoreVis(lastSnap);
  replaying = true; playing = false; queue = buildSteps(lastRec); resetUi(lastRec.task.level); floats = [];
});
function finishReplay() { replaying = false; syncVis(); activeAuction = null; activeWinner = null; setPlay(playingBeforeReplay); }
$('bSkip').addEventListener('click', () => runInstant(10));

// ======================= lanes =======================
const LANES = [
  { key: 'full', name: 'Full system', what: 'Every part on, released-code rules.', cfg: {} },
  { key: 'noAuction', name: 'Without the auction', what: 'A random awake agent acts. Money still moves.', cfg: { auction: false } },
  { key: 'noExploration', name: 'Without exploration', what: 'Failed agents are never repaired.', cfg: { exploration: false } },
  { key: 'noExploitation', name: 'Without exploitation', what: 'The richest agent is never copied.', cfg: { exploitation: false } },
];
const LANE_SEEDS = 8, LANE_TASKS = 100, laneTests = E.testSet(20);
let laneSeed = 700, lanes = [], laneTickN = 0;
function buildLanes() {
  const host = $('lanes'); host.innerHTML = '';
  lanes = LANES.map((L) => {
    const div = document.createElement('div'); div.className = 'lane' + (L.key === 'full' ? ' full' : '');
    div.innerHTML = '<h3>' + L.name + '</h3><p class="what">' + L.what + '</p><div class="big num">-</div><canvas aria-label="' + L.name + ' race"></canvas><p class="cap num">Task 0</p>';
    host.appendChild(div);
    const runs = [];
    for (let k = 0; k < LANE_SEEDS; k++) { const s = laneSeed + k * 37, e = new E.Economy(Object.assign({ seed: s }, L.cfg)); runs.push({ e, tasks: E.curriculum(s, 20, 'easy'), cks: [e.evaluate(laneTests).acc] }); }
    return { L, div, big: div.querySelector('.big'), cv: div.querySelector('canvas'), cap: div.querySelector('.cap'), runs, done: 0 };
  });
  $('laneSeedLbl').textContent = 'Seeds from ' + laneSeed + '. Default rules, so your changes above do not affect this race.';
}
function laneTick() {
  if (!lanes.length) return;
  let moved = false;
  for (const l of lanes) {
    if (l.done >= LANE_TASKS) continue;
    for (const r of l.runs) { r.e.runEpisode(r.tasks[l.done]); if ((l.done + 1) % 10 === 0) r.cks.push(r.e.evaluate(laneTests).acc); }
    l.done++; moved = true;
  }
  if (moved || laneTickN++ % 40 === 0) for (const l of lanes) drawLane(l);
}
function drawLane(l) {
  const { ctx, w, h } = fit(l.cv); ctx.clearRect(0, 0, w, h);
  const e = l.runs[0].e, dotsH = h * 0.46, colW = w / 4;
  ROLES.forEach((role, i) => {
    const list = e.agents.filter((a) => a.role === role).sort((a, b) => (b.bid == null ? 1e9 : b.bid) - (a.bid == null ? 1e9 : a.bid));
    ctx.fillStyle = C.muted; ctx.font = FONT(10.5); ctx.textAlign = 'center'; ctx.fillText(SHORT[role], colW * (i + 0.5), 11);
    const per = 3, cell = Math.min(colW / per, (dotsH - 16) / 4);
    list.slice(0, 12).forEach((a, k) => { const x = colW * i + (colW - per * cell) / 2 + ((k % per) + 0.5) * cell, y = 18 + (Math.floor(k / per) + 0.5) * cell; ctx.fillStyle = skillColor(quality(a)); ctx.beginPath(); ctx.arc(x, y, cell * 0.34, 0, 7); ctx.fill(); });
  });
  const y0 = dotsH + 10, ph = h - y0 - 4;
  ctx.strokeStyle = C.line; ctx.lineWidth = 1; for (const s of [0, 0.5, 1]) { ctx.beginPath(); ctx.moveTo(0, y0 + (1 - s) * ph); ctx.lineTo(w, y0 + (1 - s) * ph); ctx.stroke(); }
  ctx.fillStyle = C.muted; ctx.font = FONT(9.5); ctx.textAlign = 'left'; ctx.fillText('100%', 2, y0 + 10); ctx.fillText('50%', 2, y0 + ph / 2 + 10);
  const n = Math.min(...l.runs.map((r) => r.cks.length)), mean = [];
  for (let i = 0; i < n; i++) mean.push(l.runs.reduce((t, r) => t + r.cks[i], 0) / l.runs.length);
  ctx.beginPath(); mean.forEach((v, i) => { const x = ((i * 10) / LANE_TASKS) * w, y = y0 + (1 - v) * ph; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.strokeStyle = l.L.key === 'full' ? C.brass : C.fg; ctx.lineWidth = 2; ctx.stroke();
  l.big.textContent = pct(mean[mean.length - 1]);
  l.cap.textContent = l.done >= LANE_TASKS ? 'Done. Average test score of 8 runs after 100 tasks.' : 'Task ' + l.done + ' of 100';
}
$('bLanes').addEventListener('click', () => { laneSeed += 1; buildLanes(); });

// ======================= recorded tables =======================
const PAPER_ABL = { full: [52.5, 65.0], noAuction: [48.0, 58.5], noExploration: [26.0, 40.0], noExploitation: [33.5, 60.0] };
const PAPER_SENS = { original: [43.9, 57.0], rentX10: [41.8, 47.0], rewardX02: [39.0, 44.0], rewardX4: [40.9, 47.0] };
function tableRows(host, rows) {
  const cols = [1, 2, 3, 4], tops = cols.map((c) => Math.max(...rows.map((r) => (r[c] == null ? -1 : r[c]))));
  $(host).innerHTML = rows.map((r) => '<tr><td>' + r[0] + '</td>' + cols.map((c, i) => '<td class="n' + (r[c] === tops[i] ? ' best' : '') + '">' + (r[c] == null ? '-' : c <= 2 ? p1(r[c]) : r[c].toFixed(1)) + '</td>').join('') + '</tr>').join('');
}
function renderRecorded(abl) {
  const A = abl || R.ablations;
  tableRows('tAbl', [['Full system', A.full.final, A.full.best].concat(PAPER_ABL.full), ['Without the auction', A.noAuction.final, A.noAuction.best].concat(PAPER_ABL.noAuction), ['Without exploration', A.noExploration.final, A.noExploration.best].concat(PAPER_ABL.noExploration), ['Without exploitation', A.noExploitation.final, A.noExploitation.best].concat(PAPER_ABL.noExploitation)]);
  const S = R.sensitivity;
  tableRows('tSens', [['Original', S.original.final, S.original.best].concat(PAPER_SENS.original), ['Rent x10', S.rentX10.final, S.rentX10.best].concat(PAPER_SENS.rentX10), ['Reward x0.2', S.rewardX02.final, S.rewardX02.best].concat(PAPER_SENS.rewardX02), ['Reward x4', S.rewardX4.final, S.rewardX4.best].concat(PAPER_SENS.rewardX4)]);
  const U = R.rules, rr = [['Released code (default)', U.released], ['Paper Eq. 1, last agent only', U.paperEq1], ['Shared by unique agents', U.chainSplit], ['Everyone bids the same', U.fixedBids]];
  const topR = Math.max(...rr.map((x) => x[1].final));
  $('tRules').innerHTML = rr.map((x) => '<tr><td>' + x[0] + '</td><td class="n' + (x[1].final === topR ? ' best' : '') + '">' + p1(x[1].final) + '</td><td class="n">' + p1(x[1].best) + '</td></tr>').join('');
  const a = R.topology.commonStart, b = R.topology.commonEnd, rows = [];
  const show = (s) => { const parts = s.split(' '); return parts[0] + ' ' + chipRow(parts[1].split('').map((c) => ({ P: 'planner', E: 'executor', V: 'verifier', A: 'answer' }[c]))); };
  for (let i = 0; i < 6; i++) rows.push('<tr><td>' + (a[i] ? show(a[i][0]) : '') + '</td><td class="n">' + (a[i] ? a[i][1] : '') + '</td><td>' + (b[i] ? show(b[i][0]) : '') + '</td><td class="n">' + (b[i] ? b[i][1] : '') + '</td></tr>');
  $('tFlows').innerHTML = rows.join('');
  const tr = R.traits, trow = (label, role, k, sign) => { const s = tr.start[role][k], e = tr.end[role][k]; const f = (x) => (sign ? (x >= 0 ? '+' : '') + x.toFixed(2) : pct(x)); return '<tr><td>' + label + '</td><td class="n">' + f(s) + '</td><td class="n">' + f(e) + '</td></tr>'; };
  $('tTraits').innerHTML = trow('Executor self-checking', 'executor', 'selfCheck') + trow('Executor skill', 'executor', 'skill', true) + trow('Planner thoroughness', 'planner', 'thorough') + trow('Verifier error-catching', 'verifier', 'detect') + trow('Answer agent waits when unfinished', 'answer', 'patience') +
    '<tr><td>Turns per level-5 test problem</td><td class="n">' + R.topology.start.steps[4].toFixed(1) + '</td><td class="n">' + R.topology.end.steps[4].toFixed(1) + '</td></tr>' +
    '<tr><td>Births per run by job (P, E, V, A)</td><td class="n" colspan="2">' + ['planner', 'executor', 'verifier', 'answer'].map((k) => Math.round(R.full.births[k])).join(', ') + '</td></tr>';
  drawCurr();
  renderScorecard(A);
}
function drawCurr() {
  const { ctx, w, h } = fit($('chartCurr')); ctx.clearRect(0, 0, w, h);
  const L = 42, T = 8, B = 24, pw = w - L - 92, ph = h - T - B, X = (t) => L + (t / 100) * pw, Y = (s) => T + (1 - s) * ph;
  yAxis(ctx, L, T, pw, ph, [0, 0.5, 1]);
  const line = (curve, color, dash, label, dy) => { ctx.beginPath(); curve.forEach((c, i) => (i ? ctx.lineTo(X(c.episode), Y(c.acc)) : ctx.moveTo(X(c.episode), Y(c.acc)))); ctx.strokeStyle = color; ctx.lineWidth = 2.2; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]); const lc = curve[curve.length - 1]; ctx.fillStyle = color; ctx.font = FONT(11, 700); ctx.textAlign = 'left'; ctx.fillText(label + ' ' + pct(lc.acc), X(lc.episode) + 5, Y(lc.acc) + dy); };
  line(R.curriculum.easyToHard.curve, C.fg, [], 'easy first', -4);
  line(R.curriculum.hardToEasy.curve, C.muted, [5, 4], 'hard first', 12);
  ctx.fillStyle = C.muted; ctx.font = FONT(11); ctx.textAlign = 'center'; ctx.fillText('tasks trained', L + pw / 2, h - 6);
  $('currCap').textContent = 'Paper (MATH): easy-first finishes clearly higher, about 57% vs 47%. This rebuild: ' + p1(R.curriculum.easyToHard.final) + ' vs ' + p1(R.curriculum.hardToEasy.final) + '. Hard-first learns faster early, and both end in the same place. Not replicated.';
}
function renderScorecard(A) {
  const F = R.full, S = R.sensitivity, T1 = R.theorem1.filter((t) => t.wins && t.avgBid <= t.avgPayoff + 1).length;
  const v = (k) => '<span class="verdict ' + k + '">' + { yes: 'Replicated', part: 'Partly', no: 'Not replicated', na: 'Use the replica' }[k] + '</span>';
  const rows = [
    ['A weak team gets much stronger', 'MATH: 15.9% to 57.0% (Llama-8B)', p1(F.initial) + ' to ' + p1(F.final) + ' at the end, ' + p1(F.best) + ' at the best checkpoint', 'yes'],
    ['Gains reach the hardest problems', 'Fig. 6: level 5 rises from about 10% to 20%', 'Level 5: ' + p1(F.levelsStart[4]) + ' to ' + p1(F.levelsEnd[4]), 'yes'],
    ['Removing the auction hurts', 'Finance: 52.5% to 48.0%', p1(A.full.final) + ' to ' + p1(A.noAuction.final), 'yes'],
    ['Removing exploration hurts most', 'Finance: 52.5% to 26.0%', 'Final ' + p1(A.noExploration.final) + ', no drop. My repairs are a rule, not a model rewriting a prompt, and role recovery still repairs agents', 'no'],
    ['Removing exploitation hurts', 'Finance: 52.5% to 33.5%', 'Final ' + p1(A.noExploitation.final) + ', a drop. But the average over training is higher' + (A.noExploitation.meanCk != null ? ' (' + p1(A.noExploitation.meanCk) + ')' : ''), 'part'],
    ['Rent and reward need balance', 'MATH: original beats rent x10, reward x0.2, reward x4', 'Original ' + p1(S.original.final) + ' beats ' + p1(S.rentX10.final) + ', ' + p1(S.rewardX02.final) + ', ' + p1(S.rewardX4.final), 'yes'],
    ['Easy-to-hard order matters', 'Fig. 7b: about 57% vs 47%', p1(R.curriculum.easyToHard.final) + ' vs ' + p1(R.curriculum.hardToEasy.final), 'no'],
    ['Agents absorb checking and workflows shorten', 'App. E: the executor learns checks, paths shrink', 'Self-checking ' + pct(R.traits.start.executor.selfCheck) + ' to ' + pct(R.traits.end.executor.selfCheck) + '. Easy tasks skip the planner. Hard tasks got longer (' + R.topology.start.steps[4].toFixed(1) + ' to ' + R.topology.end.steps[4].toFixed(1) + ' turns)', 'part'],
    ['Prices approach value', 'Theorem 1 (a proof)', T1 + ' of 8 situations have price at or below value', 'part'],
    ['Results vary a lot between runs', 'Mean vs best: MATH 43.9 vs 57.0, finance 52.5 vs 65.0', 'Final ' + p1(F.final) + ' with a standard deviation of ' + p1(F.finalSd) + ', best checkpoint ' + p1(F.best), 'yes'],
    ['The economy beats a stronger single agent', 'MATH: 57.0% vs 51.9% for one complete agent', 'Needs language models: run the replica\'s paper MATH setup', 'na'],
    ['Learned habits transfer to new domains', 'App. E.2', 'Needs a second domain: the replica runs MATH and science tasks', 'na'],
  ];
  $('tScore').innerHTML = rows.map((r) => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td><td>' + r[2] + '</td><td>' + v(r[3]) + '</td></tr>').join('');
}
$('bBatch').addEventListener('click', () => {
  const btn = $('bBatch'); btn.disabled = true;
  const keys = [['full', {}], ['noAuction', { auction: false }], ['noExploration', { exploration: false }], ['noExploitation', { exploitation: false }]];
  const out = {}; let ki = 0, si = 0, finals = [], bests = [], means = [];
  const step = () => {
    const t0 = performance.now();
    while (performance.now() - t0 < 40 && ki < keys.length) {
      const r = E.trainRun(Object.assign({ seed: 100 + si }, keys[ki][1])); finals.push(r.final); bests.push(r.best); means.push(r.meanAfter);
      if (++si >= 30) { const m = (a) => a.reduce((t, x) => t + x, 0) / a.length; out[keys[ki][0]] = { final: m(finals), best: m(bests), meanCk: m(means) }; ki++; si = 0; finals = []; bests = []; means = []; }
    }
    $('batchStatus').textContent = ki < keys.length ? 'Running ' + (ki * 30 + si) + ' of 120 runs' : 'Done. Same seeds as the recorded run, so the numbers should match.';
    if (ki < keys.length) setTimeout(step, 0); else { renderRecorded(out); btn.disabled = false; }
  };
  step();
});

// ======================= follow the credits =======================
let lpath = 'ok', lstep = 0, lres = null;
function ledgerReset() { lres = E.articleLedger(lpath); lstep = 0; renderLedgerDemo(); }
function ledgerFrames() {
  const bal = { A: 10, B: 10, C: 10, house: 0, eval: 0 }, id2 = {}; lres.economy.agents.forEach((a) => (id2[a.id] = a.name));
  const frames = [{ text: 'Everyone starts with 10 credits.', bal: Object.assign({}, bal), hot: [] }];
  const verb = { A: 'plans', B: 'does the work', C: 'gives the answer' };
  for (const ev of lres.events) {
    if (ev.type === 'auction') frames.push({ text: id2[ev.winner] + ' wins its turn with a bid of ' + ev.bids[0].bid + '.', bal: Object.assign({}, bal), hot: [id2[ev.winner]] });
    if (ev.type === 'pay') { const from = id2[ev.from], to = ev.to === 'house' ? 'house' : id2[ev.to]; bal[from] -= ev.amount; bal[to] += ev.amount; frames.push({ text: from + ' pays ' + (to === 'house' ? 'the House' : to) + ' ' + ev.amount + '. ' + (to === 'house' ? 'Nobody acted before it.' : 'Pay the agent before you (Eq. 1).'), bal: Object.assign({}, bal), hot: [from, to] }); }
    if (ev.type === 'act') frames.push({ text: id2[ev.id] + ' ' + verb[id2[ev.id]] + (ev.ok ? '.' : ', but the program fails its final test.'), bal: Object.assign({}, bal), hot: [id2[ev.id]] });
    if (ev.type === 'reward') { bal[id2[ev.to]] += ev.amount; bal.eval = ev.amount; frames.push({ text: id2[ev.to] + ' gave the right answer, so it collects the reward of ' + ev.amount + '.', bal: Object.assign({}, bal), hot: [id2[ev.to], 'eval'] }); }
  }
  if (lpath === 'bug') frames.push({ text: 'No reward. B keeps the 7 that C paid it: profitable, but it shipped a bug. Under the paper\'s Eq. 1 that is the end of it. Under the released code, a wrong answer would also charge everyone on the workflow, B included.', bal: Object.assign({}, bal), hot: ['B'] });
  return frames;
}
function renderLedgerDemo() {
  const frames = ledgerFrames(), f = frames[Math.min(lstep, frames.length - 1)];
  const acct = (key, who, sub, cls) => '<div class="acct ' + (cls || '') + (f.hot.includes(key) ? ' hot' : '') + '"><span class="who">' + who + '</span><span class="bal">' + (key === 'eval' ? (f.bal.eval ? '+' + f.bal.eval : '0') : f.bal[key]) + '</span><small>' + sub + '</small></div>';
  $('trio').innerHTML = acct('house', 'House', 'gets first bids', 'outside') + acct('A', 'A', 'plans, bid 2') + acct('B', 'B', 'works, bid 4') + acct('C', 'C', 'answers, bid 7') + acct('eval', 'Test', 'reward if right', 'outside');
  $('ledgerSteps').innerHTML = frames.slice(0, lstep + 1).map((fr, i) => '<li class="' + (i === lstep ? 'now' : '') + '">' + fr.text + '</li>').join('');
  const done = lstep >= frames.length - 1; $('bLedgerNext').disabled = done;
  const want = lpath === 'ok' ? [12, 13, 13] : [12, 13, 3], got = lres.balances;
  $('ledgerCheck').innerHTML = done ? 'My article says <b>' + want.join(', ') + '</b>. The engine ends at <b class="brass">' + got.join(', ') + '</b>. ' + (want.every((v, i) => v === got[i]) ? 'They match.' : 'They do not match.') : '<span class="muted">Step ' + lstep + ' of ' + (frames.length - 1) + '. Press Next step.</span>';
}
$('bLedgerNext').addEventListener('click', () => { lstep++; renderLedgerDemo(); });
$('bLedgerReset').addEventListener('click', ledgerReset);
$('pathSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; lpath = b.dataset.p; [...$('pathSeg').children].forEach((x) => x.setAttribute('aria-pressed', String(x === b))); ledgerReset(); });

// ======================= tests =======================
$('bTests').addEventListener('click', () => {
  const btn = $('bTests'); btn.disabled = true;
  const list = window.EoMTests.makeTests(E), out = $('testOut'); out.innerHTML = ''; let i = 0, pass = 0;
  const run = () => {
    if (i >= list.length) { $('testSum').textContent = pass + ' of ' + list.length + ' passed'; btn.disabled = false; return; }
    const t = list[i++]; let ok = true, err = ''; try { t.fn(); } catch (e) { ok = false; err = String((e && e.message) || e); } if (ok) pass++;
    const li = document.createElement('li'); li.innerHTML = '<span class="' + (ok ? 'p' : 'f') + '">' + (ok ? 'pass' : 'FAIL') + '</span><span>' + esc(t.name) + ' <span class="muted">(' + esc(t.source) + ')</span>' + (ok ? '' : '<br><span class="bad">' + esc(err) + '</span>') + '</span>';
    out.appendChild(li); $('testSum').textContent = 'Running ' + i + ' of ' + list.length; setTimeout(run, 0);
  };
  run();
});

// ======================= boot =======================
function boot() {
  syncControls(); setSpeed(speedKey); newEconomy(); buildLanes(); renderRecorded(); ledgerReset();
  showTour(0);
  requestAnimationFrame((t) => { last = t; frame(t); });
  let rt = null;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { G = geometry(); layoutTargets(true); drawCharts(); drawCurr(); for (const l of lanes) drawLane(l); }, 80); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { drawCharts(); drawCurr(); for (const l of lanes) drawLane(l); });
}
boot();
})();
