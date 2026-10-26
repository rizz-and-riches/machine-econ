// Inline everything into one HTML page: toy engine, toy tests, toy app (with recorded results),
// and the replica (extracted prompts, task data, ported engine, page code).
// Writes dist/economy-of-minds.html (for a Claude artifact) and index.html (a standalone page).
const fs = require('fs');
const rd = (f) => fs.readFileSync(__dirname + '/' + f, 'utf8');
const safeJson = (f) => rd(f).trim().replace(/<\//g, '<\\/');
const app = rd('app.js').replace('/*__RESULTS__*/', () => rd('results.json').trim());
const replica = 'window.EoMReleasedPrompts = ' + safeJson('released_prompts.json') + ';\nwindow.EoMReplicaData = ' + safeJson('replica_data.json') + ';\n' + rd('replica-core.js') + '\n' + rd('replica-ui.js');
const page = rd('page.src.html')
  .replace('/*__ENGINE__*/', () => rd('engine.js'))
  .replace('/*__REPLICA__*/', () => replica)
  .replace('/*__TESTS__*/', () => rd('tests.js'))
  .replace('/*__APP__*/', () => app);
if (/\/\*__(ENGINE|REPLICA|TESTS|APP|RESULTS)__\*\//.test(page)) throw new Error('a placeholder was not replaced');
const opens = (page.match(/<script\b/g) || []).length, closes = (page.match(/<\/script>/gi) || []).length;
if (opens !== closes) throw new Error('script tags: ' + opens + ' open, ' + closes + ' close');
fs.mkdirSync(__dirname + '/dist', { recursive: true });
fs.writeFileSync(__dirname + '/dist/economy-of-minds.html', page);
const standalone = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n</head>\n<body>\n' + page + '\n</body>\n</html>\n';
fs.writeFileSync(__dirname + '/index.html', standalone);
console.log('built dist/economy-of-minds.html and index.html', (page.length / 1024).toFixed(1) + ' KB');
