#!/usr/bin/env node
// A small command-line tool for the board's shared state. Handy for you, and written so an AI agent (OpenClaw, Claude Code
// or similar) can run it: every command prints plain text, or JSON with --json.
//
//   node scripts/board.mjs [status] [--week 2026-01-05] [--json]   this week's votes, likely winners, locked-in dinners
//   node scripts/board.mjs shopping [--week ...] [--json]          the week's shopping list (locked-in dinners, else the likely ones)
//   node scripts/board.mjs recipes                                 recipes added on the board or by an agent
//   node scripts/board.mjs add-recipe recipe.json                  add or update one (same id = update)
//   node scripts/board.mjs remove-recipe <id>
//   node scripts/board.mjs set-week [--week ...] [--dinners 3] [--nights 2026-01-05,2026-01-07] [--note "Away at the weekend"] [--clear]
//   node scripts/board.mjs dislikes                                who said "not for us" to what, and why
//
// Settings: SB_URL (your board's address, e.g. https://dinners.example.com) and SB_PASSWORD (the board password).
// Both can also be passed as --url and --password. Nothing here buys anything or talks to any shop.
//
// recipe.json format (the same as "Add a recipe" on the board):
//   { "id": "custom-chilli", "title": "Chilli con carne", "timeMins": 40, "servings": 2, "cuisine": "Mexican",
//     "ingredients": [{ "name": "beef mince", "qty": 250, "unit": "g" }, { "name": "red onion", "qty": 1 }],
//     "steps": ["Fry the onion.", "Add the mince."], "categories": ["slow-cooker"], "image": "https://...", "sourceUrl": "https://..." }
//   id: custom-<name> for your own, web-<name> for one from a website.
import fs from 'node:fs/promises';
import { homeviewGaps } from '../site/recipe-page.js';
import { categoryId, categoryLabel } from '../site/categories.js';
import { settle, customToRecipe, dislikeSummary, rulesFrom, REASON_LABELS } from '../site/shortlist.js';
import { buildShoppingList, shoppingText, parseIngredient } from '../site/shopping.js';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes('--' + name);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--json', '--clear'].includes(args[i - 1])));
const cmd = positional[0] || 'status';
const BASE = (flag('url') || process.env.SB_URL || 'http://localhost:8788/').replace(/\/?$/, '/');
const PASSWORD = flag('password') || process.env.SB_PASSWORD;
const JSON_OUT = has('json');

function monday(t = new Date()) {
  const x = new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}
const WEEK = flag('week') || monday();
if (!/^\d{4}-\d{2}-\d{2}$/.test(WEEK)) die('--week must look like 2026-01-05 (a Monday)');
function die(msg) { console.error(msg); process.exit(1); }

if (!PASSWORD) die('Set SB_PASSWORD (the board password), and SB_URL if the board is not on http://localhost:8788/');
const login = await fetch(BASE + '__login', { method: 'POST', body: new URLSearchParams({ password: PASSWORD }), redirect: 'manual' }).catch((e) => die(`Can't reach ${BASE}: ${e.message}`));
const cookie = (login.headers.get('set-cookie') || '').match(/sb_auth=[^;]+/)?.[0];
if (!cookie) die(`Sign-in failed at ${BASE} (wrong password?)`);
const get = async (p) => { const r = await fetch(BASE + p, { headers: { Cookie: cookie } }); if (!r.ok) die(`GET ${p}: ${r.status}`); return r.json(); };
async function post(ops) {
  const r = await fetch(BASE + 'api/state', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ week: WEEK, writer: 'agent-cli', ops }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) die(`Refused: ${j.error || r.status}`);
  return j;
}

const config = await get('data/config.json');
const people = config.people || [];
const rules = rulesFrom(config);
async function library() {
  const [index, own] = await Promise.all([get('data/recipes-index.json'), get('api/state?recipes=1')]);
  const mine = own.recipes.map(customToRecipe);
  return { index: [...mine, ...index.filter((r) => !mine.some((m) => m.id === r.id))], own: own.recipes };
}
const nameOf = (lib, id) => lib.index.find((r) => r.id === id)?.name || id;

if (cmd === 'status') {
  const [s, lib] = await Promise.all([get(`api/state?week=${WEEK}`), library()]);
  const options = [...(s.options?.list || []), ...Object.keys(s.options?.added || {}).filter((id) => !(s.options?.list || []).includes(id))];
  const n = s.adjust?.dinners || s.weekInfo?.dinners || config.dinnersPerWeek || 4;
  const rd = settle({ options, votes: s.votes, people, n });
  const out = {
    week: WEEK, dinners: n, nights: s.adjust?.nights || s.weekInfo?.nights || [], note: s.weekInfo?.note || null,
    votes: Object.fromEntries(people.map((p) => [p.name, (s.votes[p.id] || []).map((id) => nameOf(lib, id))])),
    likely: rd.dinners.map((id) => nameOf(lib, id)), settled: rd.ok, notYet: rd.missing, tie: rd.tie && rd.tie.between.map((id) => nameOf(lib, id)),
    locked: s.locked ? { by: s.locked.by, at: s.locked.at, dinners: s.locked.dinners.map((id) => nameOf(lib, id)) } : null,
    extras: (s.extras || []).filter((x) => x.on).map((x) => x.text),
  };
  if (!options.length) out.note = (out.note ? out.note + ' · ' : '') + 'Nobody has opened the board this week yet, so there is no vote list stored.';
  if (JSON_OUT) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
  console.log(`Week of ${WEEK}: ${n} dinner${n === 1 ? '' : 's'}${out.nights.length ? ' on ' + out.nights.join(', ') : ''}${out.note ? ` (${out.note})` : ''}`);
  for (const [who, v] of Object.entries(out.votes)) console.log(`  ${who}: ${v.length} of ${n}${v.length ? ' - ' + v.join('; ') : ''}`);
  if (out.locked) console.log(`Locked in by ${out.locked.by || 'someone'}: ${out.locked.dinners.join('; ')}`);
  else console.log(`${rd.ok ? 'Settled' : 'Not settled yet'}${rd.missing.length ? ` (${rd.missing.join(', ')})` : ''}${out.tie ? `; tie between ${out.tie.join(', ')}` : ''}. Likely: ${out.likely.join('; ') || 'none yet'}`);
  if (out.extras.length) console.log(`Also buy: ${out.extras.join(', ')}`);
} else if (cmd === 'shopping') {
  const [s, lib, full] = await Promise.all([get(`api/state?week=${WEEK}`), library(), get('data/recipes.json')]);
  const options = [...(s.options?.list || []), ...Object.keys(s.options?.added || {})];
  const n = s.adjust?.dinners || s.weekInfo?.dinners || config.dinnersPerWeek || 4;
  const ids = s.locked?.dinners || settle({ options, votes: s.votes, people, n }).dinners;
  const byId = new Map([...full.map((r) => [r.id, r]), ...lib.own.map((r) => [r.id, customToRecipe(r)])]);
  const list = buildShoppingList(ids.map((id) => byId.get(id)).filter(Boolean), { servings: config.servings, extras: s.extras || [] });
  if (JSON_OUT) console.log(JSON.stringify({ week: WEEK, locked: !!s.locked, ...list }, null, 2));
  else console.log((s.locked ? '' : '(Not locked in yet - based on the current votes)\n') + shoppingText(list, `Shopping list - week of ${WEEK}`));
} else if (cmd === 'recipes') {
  const { own } = await library();
  if (JSON_OUT) console.log(JSON.stringify(own, null, 2));
  else console.log(own.length ? own.map((r) => `${r.id}  ${r.title}${r.timeMins ? ` (${r.timeMins} min)` : ''}`).join('\n') : 'No added recipes yet.');
} else if (cmd === 'add-recipe') {
  const file = positional[1] || die('Usage: node scripts/board.mjs add-recipe recipe.json');
  const r = JSON.parse(await fs.readFile(file, 'utf8'));
  // Accept ingredient lines as plain strings too ("200g penne").
  r.ingredients = (r.ingredients || []).map((i) => (typeof i === 'string' ? (({ item, qty, unit }) => ({ name: item, qty, unit: unit === 'unit' ? null : unit }))(parseIngredient(i)) : i));
  // A method given as one block ("1. ... 2. ...") is split into steps: the cooking view shows one step per screen.
  if (typeof r.steps === 'string') r.steps = r.steps.split(/\n+|(?=\b\d+\.\s)/).map((x) => x.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
  const bad = (r.categories || []).filter((c) => !categoryId(c));
  if (bad.length) die(`Unknown categories: ${bad.join(', ')} (see site/categories.js)`);
  await post([{ op: 'recipe-add', recipe: r }]);
  const shaped = customToRecipe(r);
  const why = (await import('../site/shortlist.js')).classify(shaped, rules).why;
  console.log(`Saved ${r.id}: ${r.title}`);
  console.log(`  Categories: ${shaped.cats.map(categoryLabel).join(', ') || 'none'}`);
  if (why.length) console.log(`  Outside your rules (won't be suggested automatically): ${why.join(', ')}`);
  const gaps = homeviewGaps(shaped);
  if (gaps.length) console.log(`  Recipe page is missing: ${gaps.join('; ')}`);
  console.log(`  Page: ${BASE}recipe/${r.id}`);
} else if (cmd === 'remove-recipe') {
  const id = positional[1] || die('Usage: node scripts/board.mjs remove-recipe <id>');
  await post([{ op: 'recipe-remove', id }]);
  console.log(`Removed ${id}`);
} else if (cmd === 'set-week') {
  if (has('clear')) { await post([{ op: 'week-clear' }]); console.log(`Week ${WEEK}: back to the default (${config.dinnersPerWeek || 4} dinners)`); process.exit(0); }
  const op = { op: 'week-set' };
  if (flag('dinners')) op.dinners = +flag('dinners');
  if (flag('nights')) op.nights = flag('nights') === 'none' ? null : flag('nights').split(',').map((x) => x.trim());
  if (flag('note')) op.note = flag('note') === 'none' ? null : flag('note');
  if (Object.keys(op).length === 1) die('Nothing to set: use --dinners, --nights or --note (or --clear)');
  const s = await post([op]);
  console.log(`Week ${WEEK}: suggested ${s.weekInfo.dinners || config.dinnersPerWeek} dinners${s.weekInfo.nights?.length ? ' on ' + s.weekInfo.nights.join(', ') : ''}${s.weekInfo.note ? ` - ${s.weekInfo.note}` : ''}${s.adjust ? ` (someone changed it on the board to ${s.adjust.dinners}; that wins)` : ''}`);
} else if (cmd === 'dislikes') {
  const [s, lib] = await Promise.all([get(`api/state?week=${WEEK}`), library()]);
  const sum = dislikeSummary(s.dislikes || [], lib.index, rules);
  if (JSON_OUT) { console.log(JSON.stringify(sum, null, 2)); process.exit(0); }
  if (!Object.keys(sum).length) console.log('No "not for us" yet.');
  for (const [who, p] of Object.entries(sum)) {
    const name = people.find((x) => x.id === who)?.name || who;
    console.log(`${name} - not keen on ${p.count}: ${p.recipes.join('; ')}`);
    const reasons = Object.entries(p.reasons).map(([k, v]) => `${REASON_LABELS[k] || k} ${v}`).join(', ');
    if (reasons) console.log(`  Reasons: ${reasons}`);
    if (p.patterns.length) console.log(`  Pattern (suggested less often): ${p.patterns.join(', ')}`);
  }
} else die(`Unknown command "${cmd}". Commands: status, shopping, recipes, add-recipe, remove-recipe, set-week, dislikes`);
