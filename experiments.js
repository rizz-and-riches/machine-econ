// The replication suite. Writes results.json, which the page shows as the recorded run.
const fs = require('fs');
const E = require('./engine.js');
const SEEDS = +(process.argv[2] || 30);
const BASE_SEED = 100;

function runSet(cfg, o) {
  const runs = [];
  for (let s = 0; s < SEEDS; s++) runs.push(E.trainRun(Object.assign({ seed: BASE_SEED + s }, cfg), o));
  return runs;
}
const mean = (a) => a.reduce((t, x) => t + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((t, x) => t + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
function summary(runs) {
  const finals = runs.map((r) => r.final), bests = runs.map((r) => r.best), means = runs.map((r) => r.meanAfter);
  const nCk = runs[0].checkpoints.length;
  const curve = []; for (let i = 0; i < nCk; i++) curve.push({ episode: runs[0].checkpoints[i].episode, acc: mean(runs.map((r) => r.checkpoints[i].acc)) });
  const lv = (idx) => [0, 1, 2, 3, 4].map((L) => mean(runs.map((r) => r.checkpoints[idx < 0 ? r.checkpoints.length - 1 : idx].byLevel[L])));
  return {
    initial: mean(runs.map((r) => r.initial)), final: mean(finals), finalSd: sd(finals),
    meanCk: mean(means), best: mean(bests), bestOfRuns: Math.max(...bests),
    curve, levelsStart: lv(0), levelsEnd: lv(-1),
    births: ['planner', 'executor', 'verifier', 'answer'].reduce((o, k) => (o[k] = mean(runs.map((r) => r.economy.birthsByRole[k])), o), {}),
    bankrupt: mean(runs.map((r) => r.economy.bankruptCount)),
    pop: mean(runs.map((r) => r.economy.agents.length)),
  };
}
const round = (x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : Array.isArray(x) ? x.map(round) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, round(v)])) : x);

const out = { seeds: SEEDS, tasksPerRun: 100, testTasks: 200, generated: new Date().toISOString().slice(0, 10) };
const t0 = Date.now();

// ---- main run + Table 2 right ----
const fullRuns = runSet({});
out.full = summary(fullRuns);
out.ablations = {
  full: out.full,
  noAuction: summary(runSet({ auction: false })),
  noExploration: summary(runSet({ exploration: false })),
  noExploitation: summary(runSet({ exploitation: false })),
};
// ---- Table 2 left: economic parameters ----
out.sensitivity = {
  original: out.full,
  rentX10: summary(runSet({ rent: 200 })),
  rewardX02: summary(runSet({ reward: 20 })),
  rewardX4: summary(runSet({ reward: 400 })),
};
// ---- reward and bid rules (paper text vs released code) ----
out.rules = {
  released: out.full,
  paperEq1: summary(runSet({ rewardScheme: 'outcome' })),
  chainSplit: summary(runSet({ rewardScheme: 'chainSplit' })),
  fixedBids: summary(runSet({ bidScheme: 'fixed' })),
};
// ---- Fig. 7b: curriculum order ----
out.curriculum = { easyToHard: out.full, hardToEasy: summary(runSet({}, { order: 'hard' })) };
// ---- baseline: same weak team, no market, no evolution ----
const ts = E.testSet(40);
out.baselines = {
  initialTeamWithAuction: out.full.initial,
  sameTeamNoMarket: mean(Array.from({ length: SEEDS }, (_, s) => new E.Economy({ seed: BASE_SEED + s, auction: false }).evaluate(ts).acc)),
};

// ---- App. E: workflow (auction-derived topology) on the test set, start vs end ----
function topo(runs, which) {
  const len = [[], [], [], [], []], ver = [[], [], [], [], []], ans = [[], [], [], [], []];
  for (const r of runs) {
    const ck = which === 'start' ? r.checkpoints[0] : r.checkpoints[r.checkpoints.length - 1];
    ck.paths.forEach((p, i) => { const L = ts[i].level - 1; len[L].push(p.length); ver[L].push(p.filter((x) => x === 'verifier').length); ans[L].push(p.filter((x) => x === 'answer').length); });
  }
  return { steps: len.map(mean), verifierTurns: ver.map(mean), answerTurns: ans.map(mean) };
}
out.topology = { start: topo(fullRuns, 'start'), end: topo(fullRuns, 'end') };
// most common successful paths at the end, per level
const common = {};
for (const r of fullRuns) {
  const ck = r.checkpoints[r.checkpoints.length - 1];
  ck.paths.forEach((p, i) => { const k = 'L' + ts[i].level + ' ' + p.map((x) => E.ROLE_SHORT[x]).join(''); common[k] = (common[k] || 0) + 1; });
}
out.topology.commonEnd = Object.entries(common).sort((a, b) => b[1] - a[1]).slice(0, 12);
const commonStart = {};
for (const r of fullRuns) r.checkpoints[0].paths.forEach((p, i) => { const k = 'L' + ts[i].level + ' ' + p.map((x) => E.ROLE_SHORT[x]).join(''); commonStart[k] = (commonStart[k] || 0) + 1; });
out.topology.commonStart = Object.entries(commonStart).sort((a, b) => b[1] - a[1]).slice(0, 12);

// ---- Theorem 1: price vs value per situation (pooled over runs) ----
out.theorem1 = E.SITUATIONS.map((s, i) => {
  let wins = 0, pay = 0, bid = 0;
  for (const r of fullRuns) { const st = r.economy.sitStats[i]; wins += st.wins; pay += st.payoffSum; bid += st.bidSum; }
  return { situation: s.label, wins, avgPayoff: wins ? pay / wins : null, avgBid: wins ? bid / wins : null };
});

// ---- how genomes changed: winning agents' traits, start vs end ----
function traits(e, which) {
  const roleAvg = {};
  for (const role of E.ROLES) {
    const list = e.agents.filter((a) => a.role === role);
    const o = {};
    for (const k of Object.keys(E.PARAMS[role])) o[k] = list.length ? mean(list.map((a) => a.genome[k])) : null;
    roleAvg[role] = o;
  }
  return roleAvg;
}
const startTraits = traits(new E.Economy({ seed: BASE_SEED }));
const endTraitsAll = fullRuns.map((r) => traits(r.economy));
const endTraits = {};
for (const role of E.ROLES) { endTraits[role] = {}; for (const k of Object.keys(E.PARAMS[role])) { const v = endTraitsAll.map((t) => t[role][k]).filter((x) => x != null); endTraits[role][k] = v.length ? mean(v) : null; } }
const startAll = Array.from({ length: SEEDS }, (_, s) => traits(new E.Economy({ seed: BASE_SEED + s })));
const startAvg = {};
for (const role of E.ROLES) { startAvg[role] = {}; for (const k of Object.keys(E.PARAMS[role])) startAvg[role][k] = mean(startAll.map((t) => t[role][k])); }
out.traits = { start: startAvg, end: endTraits };

// ---- volatility: how much the score moves between checkpoints (paper reports mean vs best for this reason) ----
const jumps = []; for (const r of fullRuns) for (let i = 2; i < r.checkpoints.length; i++) jumps.push(Math.abs(r.checkpoints[i].acc - r.checkpoints[i - 1].acc));
out.volatility = { avgCheckpointJump: mean(jumps), meanVsBestGap: out.full.best - out.full.final };

out.seconds = (Date.now() - t0) / 1000;
fs.writeFileSync(__dirname + '/results.json', JSON.stringify(round(out), null, 1));
const p = (x) => (x * 100).toFixed(1) + '%';
console.log('seconds', out.seconds);
console.log('FULL       start', p(out.full.initial), 'final', p(out.full.final), '+-', p(out.full.finalSd), 'mean ck', p(out.full.meanCk), 'best', p(out.full.best));
for (const [k, v] of Object.entries(out.ablations)) console.log('ablation', k.padEnd(15), 'final', p(v.final), 'meanCk', p(v.meanCk), 'best', p(v.best));
for (const [k, v] of Object.entries(out.sensitivity)) console.log('sensitiv', k.padEnd(15), 'final', p(v.final), 'meanCk', p(v.meanCk), 'best', p(v.best));
for (const [k, v] of Object.entries(out.rules)) console.log('rules   ', k.padEnd(15), 'final', p(v.final), 'meanCk', p(v.meanCk), 'best', p(v.best), 'births', JSON.stringify(round(v.births)));
for (const [k, v] of Object.entries(out.curriculum)) console.log('curric  ', k.padEnd(15), 'final', p(v.final), 'curve', v.curve.map((c) => p(c.acc)).join(' '));
console.log('baselines', JSON.stringify(round(out.baselines)));
console.log('levels start', out.full.levelsStart.map(p).join(' '), '| end', out.full.levelsEnd.map(p).join(' '));
console.log('topology steps start', round(out.topology.start.steps), 'end', round(out.topology.end.steps));
console.log('verifier turns start', round(out.topology.start.verifierTurns), 'end', round(out.topology.end.verifierTurns));
console.log('answer turns start', round(out.topology.start.answerTurns), 'end', round(out.topology.end.answerTurns));
console.log('common start', JSON.stringify(out.topology.commonStart.slice(0, 6)));
console.log('common end', JSON.stringify(out.topology.commonEnd.slice(0, 8)));
console.log('theorem1', out.theorem1.map((t) => t.situation.slice(0, 18) + ' bid ' + (t.avgBid || 0).toFixed(1) + ' val ' + (t.avgPayoff || 0).toFixed(1) + ' n' + t.wins).join(' | '));
console.log('traits start', JSON.stringify(round(out.traits.start)));
console.log('traits end  ', JSON.stringify(round(out.traits.end)));
console.log('volatility', JSON.stringify(round(out.volatility)));
