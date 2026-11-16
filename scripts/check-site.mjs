#!/usr/bin/env node
// Checks the board end to end: plain HTTP, the password gate, the API, then headless Chrome through every tab (JS errors,
// Content-Security-Policy problems and failed loads are collected and reported). No npm packages needed.
//   node scripts/check-site.mjs [url] [--password <pw>] [--screenshot] [--readonly]
// Run it against a local copy first (npm run dev, then: node scripts/check-site.mjs http://localhost:8788/ --password letmein).
//   --screenshot  saves the main screens to docs/images/ (phone size, plus a HomeView-size recipe page)
//   --readonly    never votes or locks anything (use this on your live board while people are using it)
// Without --password it checks a plain static server (python3 -m http.server --directory site) and skips the API.
// Chrome: set CHROME=/path/to/chrome if it isn't in the usual macOS place.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const BASE = (args.find((a) => a.startsWith('http')) || 'http://localhost:8788/').replace(/\/?$/, '/');
const SHOT = args.includes('--screenshot');
const READONLY = args.includes('--readonly');
const pwI = args.indexOf('--password');
const PASSWORD = pwI >= 0 ? args[pwI + 1] : process.env.SB_PASSWORD;
const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  PASS' : '  FAIL'}  ${msg}`); if (!cond) failures++; };

// ---- 1. sign in ----
let cookie = '';
if (PASSWORD) {
  console.log(`Password gate at ${BASE}`);
  const gate = await fetch(BASE, { redirect: 'manual' });
  ok(gate.status === 200 && /type="password"/.test(await gate.text()), `GET / signed out -> ${gate.status}, sign-in page`);
  const bad = await fetch(BASE + '__login', { method: 'POST', body: new URLSearchParams({ password: 'not-it' }), redirect: 'manual' });
  ok(bad.status === 401, `wrong password -> ${bad.status}`);
  const login = await fetch(BASE + '__login', { method: 'POST', body: new URLSearchParams({ password: PASSWORD }), redirect: 'manual' });
  cookie = (login.headers.get('set-cookie') || '').match(/sb_auth=[^;]+/)?.[0] || '';
  ok(login.status === 303 && !!cookie, `right password -> ${login.status}, cookie set`);
  if (!cookie) { console.log('\nCan\'t sign in - stopping.'); process.exit(1); }
}
const get = (u, o = {}) => fetch(u, { ...o, headers: { ...(o.headers || {}), ...(cookie && { Cookie: cookie }) } });

// ---- 2. plain HTTP ----
console.log(`\nFiles at ${BASE}`);
for (const f of ['', 'index.html', 'app.js', 'styles.css', 'shortlist.js', 'categories.js', 'shopping.js', 'recipe-ld.js', 'icon.svg', 'manifest.webmanifest']) {
  const r = await get(BASE + f);
  ok(r.ok, `GET /${f} -> ${r.status}`);
}
for (const f of ['config.json', 'recipes-index.json', 'recipes.json']) {
  const r = await get(BASE + 'data/' + f);
  let parsed = false;
  try { JSON.parse(await r.text()); parsed = true; } catch {}
  ok(r.ok && parsed, `GET /data/${f} -> ${r.status}, valid JSON`);
}
const config = await (await get(BASE + 'data/config.json')).json();
const index = await (await get(BASE + 'data/recipes-index.json')).json();
const people = config.people;
ok(people?.length >= 1, `config.json has ${people?.length} people: ${people?.map((p) => p.name).join(', ')}`);
if (index.length) {
  const page = await get(`${BASE}recipe/${index[0].id}`);
  const html = await page.text();
  const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1] || 'null');
  ok(page.ok && ld?.['@type'] === 'Recipe' && ld.recipeInstructions?.length >= 2 && ld.recipeIngredient?.length > 0, `/recipe/${index[0].id} has Recipe JSON-LD (${ld?.recipeIngredient?.length} ingredients, ${ld?.recipeInstructions?.length} steps)`);
}

// ---- 3. API ----
const monday = (() => { const t = new Date(); const x = new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); })();
const API = BASE + 'api/state';
let apiOn = false;
if (PASSWORD) {
  console.log('\nAPI');
  ok((await fetch(`${API}?week=${monday}`)).status === 401, 'GET /api/state signed out -> 401');
  ok((await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 401, 'POST /api/state signed out -> 401');
  const r = await get(`${API}?week=${monday}`);
  const s = r.ok ? await r.json() : null;
  apiOn = !!s && 'votes' in s;
  ok(apiOn, `GET /api/state signed in -> ${r.status}`);
  const scratch = '2099-01-05'; // a week nobody will ever look at
  const post = (ops, writer = 'check-site') => get(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ week: scratch, writer, ops }) });
  ok((await post([{ op: 'bogus' }])).status === 400, 'unknown op -> 400');
  ok((await get(API, { method: 'POST', body: 'week=x' })).status === 415, 'not JSON -> 415');
  ok((await post([{ op: 'vote', person: 'NOT VALID', recipeId: 'x', on: true }])).status === 400, 'bad person id -> 400');
  ok((await post([{ op: 'recipe-add', recipe: { id: 'nope', title: 'x', ingredients: [{ name: 'x' }] } }])).status === 400, 'recipe with a bad id -> 400');
  // 20 devices voting at the same moment: every vote must land (storage is append-only, one log per device).
  const ids = index.slice(0, 10).map((x) => x.id);
  const voteOnce = async (n, w) => { const op = [{ op: 'vote', person: n % 2 ? 'checka' : 'checkb', recipeId: ids[Math.floor(n / 2)], on: true }]; const r = await post(op, w); return r.status === 503 ? post(op, w) : r; }; // the app retries a 503 too
  const res = await Promise.all(Array.from({ length: 20 }, (_, n) => voteOnce(n, `check-${n}-${Date.now().toString(36)}`)));
  ok(res.every((x) => x.ok), `20 votes sent at once -> all ${res.filter((x) => x.ok).length} accepted`);
  const after = await (await get(`${API}?week=${scratch}`)).json();
  ok((after.votes.checka?.length || 0) + (after.votes.checkb?.length || 0) >= 20 || (after.votes.checka?.length === ids.length && after.votes.checkb?.length === ids.length), `...and all 20 are there afterwards (${after.votes.checka?.length} + ${after.votes.checkb?.length})`);
  await post([...ids.flatMap((id) => [{ op: 'vote', person: 'checka', recipeId: id, on: false }, { op: 'vote', person: 'checkb', recipeId: id, on: false }])]);
  const imp = await get(BASE + 'api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'http://localhost/x' }) });
  ok(imp.status === 400, `import refuses local addresses -> ${imp.status}`);
}

// ---- 4. headless Chrome ----
const port = 9300 + Math.floor(Math.random() * 500);
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {} });
let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i++) {
  await sleep(200);
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl; } catch {}
}
if (!wsUrl) { console.error('Could not start headless Chrome (set CHROME=/path/to/chrome)'); process.exit(1); }
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
const problems = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') problems.push('JS exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) problems.push(`console.${m.params.type}: ` + m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon/.test(m.params.entry.url || '')) problems.push(`log error: ${m.params.entry.text} ${m.params.entry.url || ''}`);
  if (process.env.DEBUG && m.method === 'Network.requestWillBeSent' && m.params.request.method === 'POST') console.log('  POST', m.params.request.postData);
  if (m.method === 'Network.loadingFailed' && !/ERR_ABORTED/.test(m.params.errorText)) problems.push(`network failed: ${m.params.errorText} (${m.params.type})`);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, (m) => (m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
const waitFor = async (expr, ms = 8000) => { for (let t = 0; t < ms; t += 100) { if (await evaluate(expr)) return true; await sleep(100); } return false; };
const click = (sel) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
const size = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
const shot = async (name, { full = false } = {}) => {
  if (!SHOT) return;
  await sleep(600);
  const { data } = await send('Page.captureScreenshot', { format: 'png', ...(full && { captureBeyondViewport: true }) });
  const out = path.join(ROOT, 'docs', 'images', name);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, Buffer.from(data, 'base64'));
  console.log(`  shot  ${path.relative(ROOT, out)}`);
};
const go = async (hash) => { await evaluate(`location.hash = ${JSON.stringify(hash)}`); await sleep(400); };

await Promise.all(['Runtime.enable', 'Log.enable', 'Page.enable', 'Network.enable'].map((m) => send(m)));
await size(390, 844);
await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });

console.log('\nHeadless Chrome (phone size, 390 x 844)');
if (PASSWORD && SHOT) { // the sign-in page, before the cookie is set
  await send('Page.navigate', { url: BASE });
  await sleep(1200);
  await shot('sign-in.png');
}
if (cookie) {
  const [name, value] = cookie.split('=');
  await send('Network.setCookie', { name, value, url: BASE, httpOnly: true, secure: BASE.startsWith('https'), sameSite: 'Lax' });
}
await send('Page.navigate', { url: 'about:blank' });
await send('Page.navigate', { url: BASE + '#week' });
ok(await waitFor(`document.documentElement.dataset.ready === '1'`), 'board loads (#week)');
await evaluate('localStorage.clear()');
await send('Page.reload');
ok(await waitFor(`document.documentElement.dataset.ready === '1'`), 'board loads after a clean start');

// Vote
await go('#vote');
const nOpts = await evaluate(`document.querySelectorAll('[data-opt]').length`);
ok(nOpts > 0, `Vote shows ${nOpts} options`);
const canWrite = apiOn && !READONLY;
if (canWrite && people.length >= 1) {
  const wanted = await evaluate(`document.querySelector('#vote-sub').textContent.match(/pick your (\\d+)/)?.[1]`);
  const n = +wanted || 4;
  const opts = await evaluate(`[...document.querySelectorAll('[data-opt]')].map(e => e.dataset.opt)`);
  const now = await (await get(`${API}?week=${monday}`)).json();
  const already = Object.values(now.votes || {}).some((v) => v.length) || now.locked;
  if (already) console.log('  info  this week already has votes - skipping the vote and lock steps (they need a fresh week)');
  else {
    // Person 1 picks the first n; person 2 (if any) picks an overlapping set, leaving one to settle.
    await click(`[data-who="${people[0].id}"]`);
    for (const id of opts.slice(0, n)) { await click(`[data-vote="${id}"]`); await sleep(150); }
    ok(await waitFor(`document.querySelectorAll('.vote-btn.on').length === ${n}`), `${people[0].name} voted for ${n}`);
    if (people[1]) {
      await click('[data-act="who-change"]'); await sleep(200);
      await click(`[data-who="${people[1].id}"]`); await sleep(200);
      const theirs = [...opts.slice(1, n), opts[n] || opts[0]].slice(0, n - 1);
      for (const id of theirs) { await click(`[data-vote="${id}"]`); await sleep(150); }
      await sleep(800);
      ok(await evaluate(`document.querySelectorAll('.opt.both').length >= 1`), 'options picked by everyone are marked ★');
      ok(await waitFor(`/Synced/.test(document.querySelector('#sync-slot')?.textContent || '')`, 6000), 'votes saved ("Synced between phones")');
      await evaluate('window.scrollTo(0, 0)');
      await shot('vote.png');
      // The last pick, then lock in.
      await click(`[data-vote="${opts[0]}"]`); await sleep(800);
    }
    await evaluate(`document.querySelector('[data-act="lock"]')?.scrollIntoView({block: 'center'})`);
    ok(await waitFor(`!document.querySelector('[data-act="lock"]')?.disabled`, 4000), '"Lock in these dinners" is ready once everyone has picked');
    await shot('vote-lock.png');
    await click('[data-act="lock"]'); await sleep(1000);
    const st = await (await get(`${API}?week=${monday}`)).json();
    ok(st.locked?.dinners?.length === n, `locked in ${st.locked?.dinners?.length} dinners (stored on the server)`);
  }
} else if (!READONLY && SHOT) await shot('vote.png');

// This week
await go('#week');
ok(await waitFor(`document.querySelectorAll('.meal').length > 0 || !!document.querySelector('.empty')`), 'This week renders');
await evaluate('window.scrollTo(0, 0)');
await shot('this-week.png');

// Library
await go('#library');
ok(await waitFor(`document.querySelectorAll('.row').length > 0`), `Library lists recipes (${await evaluate(`document.querySelector('.count')?.textContent`)})`);
await click('[data-panel="cuisine"]'); await sleep(300);
ok(await evaluate(`document.querySelectorAll('.cat-panel .cat-chip').length > 0`), 'Cuisine button opens the category chips');
await shot('library-categories.png');
const firstChip = await evaluate(`document.querySelector('.cat-panel .cat-chip')?.dataset.cat`);
await click(`.cat-panel [data-cat="${firstChip}"]`); await sleep(300);
const filtered = await evaluate(`document.querySelectorAll('#lib-results .row').length`);
ok(filtered > 0 && filtered < index.length, `a cuisine chip filters the list (${filtered} of ${index.length})`);
await click('[data-act="cats-clear"]'); await click('[data-panel="cuisine"]'); await sleep(200);
await evaluate(`(() => { const q = document.querySelector('#lib-q'); q.value = 'spinach'; q.dispatchEvent(new Event('input', {bubbles: true})); })()`);
await sleep(500);
const found = await evaluate(`[...document.querySelectorAll('#lib-results .row h3')].map(e => e.textContent)`);
ok(found.length > 0, `search "spinach" finds recipes by ingredient: ${found.join(', ')}`);
await shot('library-search.png');
await evaluate(`(() => { const q = document.querySelector('#lib-q'); q.value = ''; q.dispatchEvent(new Event('input', {bubbles: true})); })()`);
await sleep(300);

// Recipe sheet
const rid = index.find((r) => r.id.includes('traybake'))?.id || index[0]?.id;
await go('#recipe/' + encodeURIComponent(rid));
ok(await waitFor(`!document.querySelector('#sheet').hidden && document.querySelectorAll('#sheet [data-step]').length > 1`), 'a recipe opens with separate steps');
ok(await waitFor(`!!document.querySelector('#recipe-ld')`, 3000), 'the open recipe carries Recipe JSON-LD');
await evaluate(`document.querySelector('#sheet [data-ing="0"]').click(); document.querySelector('#sheet [data-step="0"]').click()`);
await shot('recipe.png');

// Add a recipe
await go('#add-recipe');
ok(await waitFor(`!!document.querySelector('#recipe-form')`), 'Add a recipe opens (link + type it in)');
await shot('add-recipe.png');
await go('#library');

// Shopping
await go('#shopping');
ok(await waitFor(`document.querySelectorAll('[data-shop]').length > 0 || /Nothing on the list/.test(document.querySelector('#view').textContent)`), `Shopping renders (${await evaluate(`document.querySelectorAll('[data-shop]').length`)} items)`);
ok(await evaluate(`!!document.querySelector('[data-act="shop-copy"]') || !document.querySelectorAll('[data-shop]').length`), 'shopping list has Copy / Download buttons');
await evaluate(`[...document.querySelectorAll('[data-shop]')].slice(0, 3).forEach(b => b.click())`);
await shot('shopping.png');

// Static recipe page at HomeView size
await size(448, 364);
await send('Page.navigate', { url: `${BASE}recipe/${rid}` });
await sleep(1200);
ok(await evaluate(`!!document.querySelector('script[type="application/ld+json"]') && document.documentElement.scrollWidth <= 448`), 'recipe page fits HomeView (448 x 364) with no sideways scroll');
await shot('homeview-recipe-page.png');

// Tablet-ish width for the vote grid
if (SHOT) {
  await size(1024, 768);
  await send('Page.navigate', { url: BASE + '#vote' });
  await waitFor(`document.documentElement.dataset.ready === '1'`);
  await sleep(800);
  await shot('tablet-vote.png');
}

console.log('');
const real = problems.filter((p) => !/favicon/.test(p));
ok(real.length === 0, `no JS errors, CSP problems or failed loads${real.length ? ':\n        ' + real.join('\n        ') : ''}`);
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(failures ? 1 : 0);
