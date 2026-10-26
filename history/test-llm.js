// Stand-in model to test the real AI mode's plumbing. It does NOT test how well Claude does.
const assert = require('assert');
const L = require('./llm-mode.js');
const data = require('./math_subset.json');
let r = 1; const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647;
const calls = { wake: 0, act: 0, birth: 0 };
async function fake(prompt, kind) {
  calls[kind]++;
  if (kind === 'wake') { const names = [...prompt.matchAll(/^- ([A-Z]-\d+):/gm)].map((m) => m[1]); return JSON.stringify(Object.fromEntries(names.map((n) => [n, rnd() < 0.6]))); }
  if (kind === 'birth') return 'Do: check each step twice. Don\'t: skip units. (variant ' + Math.floor(rnd() * 1000) + ')';
  if (/You are the Answer agent/.test(prompt)) {
    const m = /Problem:\n([\s\S]*?)\n\n/.exec(prompt); const pr = [...data.train, ...data.test].find((p) => m && p.problem === m[1]);
    const truth = pr ? pr.answer : '0';
    return rnd() < 0.5 ? '<step>done</step><final_answer>\\boxed{' + truth + '}</final_answer>' : (rnd() < 0.5 ? '<step>missing a step</step>' : '<final_answer>\\boxed{999}</final_answer>');
  }
  return '<step>did one sub-step</step>';
}
(async () => {
  // answer checking
  assert(L.isCorrect('1,940', '1940')); assert(L.isCorrect(' -2 ', '-2')); assert(L.isCorrect('x=6', '6')); assert(!L.isCorrect('7', '6'));
  assert.strictEqual(L.extractFinal('<final_answer>so \\boxed{\\frac{1}{2}}</final_answer>'), '\\frac{1}{2}');
  assert.strictEqual(L.extractFinal('<step>no</step>'), null);
  const e = new L.LLMEconomy({ seed: 3 }, fake);
  const log = [];
  const before = await e.evaluate(data.test.slice(0, 4), (x) => log.push(x));
  const w0 = e.totalWealth();
  for (const p of data.train.slice(0, 9)) await e.trainEpisode(p, (x) => log.push(x));
  const after = await e.evaluate(data.test.slice(0, 4), (x) => log.push(x));
  assert(before.results.length === 4 && after.results.length === 4);
  assert(e.agents.length >= e.cfg.minAgents && e.agents.length <= e.cfg.maxAgents + 4);
  for (const role of ['planner', 'executor', 'verifier', 'answer']) assert(e.agents.some((a) => a.role === role), 'role ' + role);
  assert(log.some((x) => x.type === 'pay') && log.some((x) => x.type === 'reward'));
  assert(e.births.length > 0 && e.births.every((b) => b.after.length >= 10));
  assert(log.filter((x) => x.type === 'auction').every((x) => x.bids.length > 0));
  // terminal step only lets the answer agent act
  const term = log.filter((x) => x.type === 'auction' && x.step === e.cfg.maxSteps - 1);
  assert(term.every((x) => /^A-/.test(x.winner)), 'terminal winners are answer agents');
  // same role never twice in a row within a task
  let lastRole = null, ok = true; for (const x of log) { if (x.type === 'episode' || x.type === 'test') lastRole = null; if (x.type === 'act') { if (x.role === lastRole && x.step !== e.cfg.maxSteps - 1) ok = false; lastRole = x.role; } }
  assert(ok, 'same-role blocking');
  console.log('real AI mode plumbing OK. calls:', JSON.stringify(calls), 'total', e.calls, '| births', e.births.length, '| agents', e.agents.map((a) => a.name).join(' '), '| test before', before.acc, 'after', after.acc, '(stand-in model, meaningless)');
})().catch((err) => { console.error('FAIL', err); process.exit(1); });
