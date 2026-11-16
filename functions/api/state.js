// Shared board state per week (votes, the vote list, week settings, the locked-in dinners, shopping extras), plus the
// persistent "Not for us" dislikes and your own added recipes. Runs behind functions/_middleware.js, so only signed-in
// devices get here.
//   GET  /api/state?week=2026-01-05
//   GET  /api/state?recipes=1        -> {recipes: [...]}  recipes added on the board or by an agent
//   POST /api/state  {"week":"2026-01-05","writer":"d-k3j2h1","ops":[...]}   (Content-Type: application/json)
//
// No lost updates. Workers KV has no compare-and-swap, so two devices must never read-modify-write the same key. Storage
// is append-only, one key per device:
//   log:<week>:<writer>   {ops: [{t, s, o}]}  that device's ops for the week, in order (t = server ms, s = sequence no.)
//   writers:<week>        {writers: [...], listedAt}  which logs exist (an hourly KV list repairs it if needed)
//   plog:<writer> / pwriters   the same for the dislikes (all weeks)
//   rlog:<writer> / rwriters   the same for added recipes (all weeks)
// Every read replays every writer's ops sorted by (t, writer, s). The replay is deterministic (op times and generated ids
// come from the log entry, not the clock), so every phone sees the same state.
//
// Ops (checked against the current state before they're logged; 400 if invalid):
//   {"op":"vote","person":"sam","recipeId":"<id>","on":true|false}
//   {"op":"options-set","list":[ids],"seen":[ids],"by":"sam"}   the week's vote list ("Show me more", or the first list)
//   {"op":"options-undo"}                                        back to the previous list
//   {"op":"option-add","recipeId":"<id>","base":[ids],"by":"sam"}   add from the Library (pinned through refreshes)
//   {"op":"option-remove","recipeId":"<id>"}
//   {"op":"dislike","recipeId":"<id>","by":"sam","remove":true,"base":[ids],"replace":"<id>"|null}   "Not for us"
//   {"op":"dislike-reasons","recipeId":"<id>","by":"sam","reasons":["ingredient","spicy","fiddly","notkeen"]}
//   {"op":"undislike","recipeId":"<id>","by":"sam","list":[ids]|undefined}
//   {"op":"week-set","dinners":3,"nights":["2026-01-05",...],"note":"Away at the weekend"}   suggestion (agent / CLI)
//   {"op":"week-clear"}
//   {"op":"week-adjust","dinners":4,"nights":[...],"by":"sam"}   - / + on the board; wins over the suggestion
//   {"op":"week-adjust-reset"}
//   {"op":"lock","by":"sam","dinners":[ids]}                     "Lock in these dinners"
//   {"op":"unlock"}
//   {"op":"extra-add","text":"Birthday candles","by":"sam"}    shopping list extras
//   {"op":"extra-tick","id":"<extraId>","on":true|false}
//   {"op":"extra-remove","id":"<extraId>"}
//   {"op":"recipe-add","recipe":{...}}                           add or update one of your own recipes (see cleanRecipe)
//   {"op":"recipe-remove","id":"custom-..."}
//   {"op":"options-reset","options":{...}|null}                 put back a saved options object (used by the checks)
// Binding: KV namespace bound as STATE.

import { categoryId } from '../../site/categories.js';

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[\w.-]{1,80}$/;
const PERSON_RE = /^[a-z][a-z0-9-]{0,23}$/;
const MAX_EXTRAS = 60;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
const blank = (week) => ({
  week, version: 0,
  votes: {},
  options: null, // { list, by, at, seen[], added?, history: [{list|null, by, at}] }
  weekInfo: null, // { dinners, nights[], note, at } - the suggestion (agent / CLI)
  adjust: null, // { dinners, nights[], by, at } - set on the board with - / +; wins over weekInfo
  locked: null, // { at, by, dinners[] }
  extras: [], // shopping list extras: [{id, text, on, by, at}]
  updatedAt: null, updatedBy: null,
});
const REASONS = ['ingredient', 'spicy', 'fiddly', 'notkeen'];
const person = (p) => (typeof p === 'string' && PERSON_RE.test(p) ? p : null);
const ids = (a, max) => [...new Set((Array.isArray(a) ? a : []).filter((x) => typeof x === 'string' && ID_RE.test(x)))].slice(0, max);
const MAX_OPTIONS = 40, MAX_SEEN = 800, MAX_HISTORY = 10, MAX_PEOPLE = 8;
const clean = (t, n = 120) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const num = (x) => (x === null || x === undefined || x === '' || !Number.isFinite(+x) ? null : Math.round(+x * 100) / 100);
const url = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]{4,500}$/.test(u) ? u : null);
const strs = (a, n = 8) => (Array.isArray(a) ? a : a ? [a] : []).map((x) => clean(x, 80)).filter(Boolean).slice(0, n);

function cleanOptions(o) {
  if (!o) return null;
  return {
    list: o.list ? ids(o.list, MAX_OPTIONS) : null, by: person(o.by), at: typeof o.at === 'string' ? o.at.slice(0, 30) : null,
    seen: ids(o.seen, MAX_SEEN),
    ...(o.added && Object.keys(o.added).length && { added: Object.fromEntries(Object.entries(o.added && typeof o.added === 'object' ? o.added : {}).filter(([k]) => ID_RE.test(k)).slice(0, 20)
      .map(([k, v]) => [k, { by: person(v?.by), at: typeof v?.at === 'string' ? v.at.slice(0, 30) : null }])) }),
    history: (Array.isArray(o.history) ? o.history : []).slice(-MAX_HISTORY).map((h) => ({ list: h.list ? ids(h.list, MAX_OPTIONS) : null, by: person(h.by), at: typeof h.at === 'string' ? h.at.slice(0, 30) : null })),
  };
}
function checkNights(s, nights, maxDays = 6) {
  const start = Date.parse(s.week + 'T00:00:00Z');
  for (const n of nights) {
    const d = (Date.parse(n + 'T00:00:00Z') - start) / 864e5;
    if (!WEEK_RE.test(n) || !(d >= 0 && d <= maxDays)) throw new Error(`night ${String(n).slice(0, 12)} is not in the week of ${s.week}`);
  }
}

// ctx = { now: ISO time of the log entry, uid: unique id of the entry } - never the clock, so replays are repeatable.
function apply(s, op, ctx) {
  switch (op?.op) {
    case 'vote': {
      const p = person(op.person);
      if (!p) throw new Error('person must be a short lower-case id');
      if (!ID_RE.test(op.recipeId || '')) throw new Error('bad recipeId');
      if (!s.votes[p] && Object.keys(s.votes).length >= MAX_PEOPLE) throw new Error('too many people');
      const list = new Set(s.votes[p] || []);
      if (op.on) list.add(op.recipeId); else list.delete(op.recipeId);
      s.votes[p] = [...list].slice(0, 40);
      break;
    }
    case 'options-set': {
      const list = ids(op.list, MAX_OPTIONS);
      if (list.length < 1) throw new Error('list needed');
      const o = s.options || { list: null, by: null, at: null, seen: [], history: [] };
      const history = [...o.history, { list: o.list, by: o.by, at: o.at }].slice(-MAX_HISTORY);
      const seen = ids([...o.seen, ...ids(op.seen, MAX_SEEN), ...(o.list || []), ...list], MAX_SEEN * 2).slice(-MAX_SEEN);
      s.options = { list, by: person(op.by), at: ctx.now, seen, history, ...(o.added && Object.keys(o.added).length && { added: o.added }) };
      break;
    }
    case 'option-add': {
      if (!ID_RE.test(op.recipeId || '')) throw new Error('bad recipeId');
      const o = s.options || { list: null, by: null, at: null, seen: [], history: [] };
      const added = { ...(o.added || {}) };
      if (Object.keys(added).length >= 20 && !added[op.recipeId]) throw new Error('too many library adds');
      const list = o.list?.length ? o.list : ids(op.base, MAX_OPTIONS);
      if (!added[op.recipeId] && !list.includes(op.recipeId)) added[op.recipeId] = { by: person(op.by), at: ctx.now };
      s.options = { ...o, list: list.includes(op.recipeId) ? list : [...list, op.recipeId].slice(0, MAX_OPTIONS), added,
        seen: ids([...o.seen, op.recipeId], MAX_SEEN * 2).slice(-MAX_SEEN) };
      if (!o.list?.length) { s.options.by = null; s.options.at = null; }
      break;
    }
    case 'option-remove': {
      const o = s.options;
      if (!o) break;
      const added = { ...(o.added || {}) };
      delete added[op.recipeId];
      s.options = { ...o, added, list: o.list ? o.list.filter((x) => x !== op.recipeId) : o.list };
      break;
    }
    case 'dislike': { // the week part; the dislike itself is replayed from the prefs logs (applyPrefs)
      const by = person(op.by);
      if (!by) throw new Error('by must be a short lower-case id');
      if (!ID_RE.test(op.recipeId || '')) throw new Error('bad recipeId');
      s.votes[by] = (s.votes[by] || []).filter((x) => x !== op.recipeId);
      if (op.remove) {
        const o = s.options || { list: null, by: null, at: null, seen: [], history: [] };
        const base = o.list?.length ? o.list : ids(op.base, MAX_OPTIONS);
        const added = { ...(o.added || {}) }; delete added[op.recipeId];
        let list = base.filter((x) => x !== op.recipeId);
        const rep = ID_RE.test(op.replace || '') ? op.replace : null;
        if (rep && !list.includes(rep)) list = [...list, rep];
        s.options = { ...o, list, seen: ids([...o.seen, op.recipeId, ...(rep ? [rep] : [])], MAX_SEEN * 2).slice(-MAX_SEEN) };
        if (Object.keys(added).length) s.options.added = added; else delete s.options.added;
        if (!o.list?.length) { s.options.by = null; s.options.at = null; }
      }
      break;
    }
    case 'dislike-reasons':
      break; // prefs only
    case 'undislike':
      if (Array.isArray(op.list) && s.options) s.options = { ...s.options, list: ids(op.list, MAX_OPTIONS) };
      break;
    case 'options-undo': {
      const o = s.options;
      if (!o?.history?.length) throw new Error('nothing to undo');
      const prev = o.history.pop();
      s.options = { ...o, list: prev.list, by: prev.by, at: prev.at };
      break;
    }
    case 'week-set': {
      const w = s.weekInfo || { dinners: null, nights: null, note: null };
      if ('dinners' in op) {
        if (op.dinners !== null && !(Number.isInteger(op.dinners) && op.dinners >= 1 && op.dinners <= 7)) throw new Error('dinners must be 1-7');
        w.dinners = op.dinners;
      }
      if ('nights' in op) {
        if (op.nights !== null) {
          if (!Array.isArray(op.nights) || op.nights.length > 7) throw new Error('nights must be a list of dates');
          checkNights(s, op.nights);
        }
        w.nights = op.nights ? [...new Set(op.nights)].sort() : null;
      }
      if ('note' in op) w.note = op.note === null ? null : clean(op.note, 140) || null;
      w.at = ctx.now;
      s.weekInfo = w;
      break;
    }
    case 'week-clear':
      s.weekInfo = null; break;
    case 'week-adjust': {
      if (!(Number.isInteger(op.dinners) && op.dinners >= 1 && op.dinners <= 7)) throw new Error('dinners must be 1-7');
      const nights = Array.isArray(op.nights) ? [...new Set(op.nights)].sort() : [];
      checkNights(s, nights);
      if (nights.length > op.dinners) throw new Error('more nights than dinners');
      s.adjust = { dinners: op.dinners, nights, by: person(op.by), at: ctx.now };
      break;
    }
    case 'week-adjust-reset':
      s.adjust = null; break;
    case 'lock': {
      const dinners = ids(op.dinners, 7);
      if (!dinners.length) throw new Error('dinners needed');
      s.locked = { at: ctx.now, by: person(op.by), dinners };
      break;
    }
    case 'unlock':
      s.locked = null; break;
    case 'extra-add': {
      const text = clean(op.text);
      if (!text) throw new Error('empty text');
      if (s.extras.length >= MAX_EXTRAS) throw new Error('too many extras');
      s.extras.push({ id: 'x-' + ctx.uid, text, on: true, by: person(op.by), at: ctx.now });
      break;
    }
    case 'extra-tick': {
      const x = s.extras.find((x) => x.id === op.id);
      if (x) x.on = !!op.on;
      break;
    }
    case 'extra-remove':
      s.extras = s.extras.filter((x) => x.id !== op.id); break;
    case 'recipe-add': case 'recipe-remove':
      break; // recipes only (applyRecipe) - not part of the week
    case 'options-reset':
      s.options = cleanOptions(op.options); break;
    default:
      throw new Error('unknown op ' + String(op?.op).slice(0, 20));
  }
}

const PREF_OPS = ['dislike', 'dislike-reasons', 'undislike', 'lock', 'unlock']; // lock/unlock also keep the "Had before" history
const RECIPE_OPS = ['recipe-add', 'recipe-remove'];

// ---- your own recipes (typed in, imported from a link, or added by an agent) ----
export const RECIPE_ID_RE = /^(custom|web)-[A-Za-z0-9_-]{3,60}$/;
// Some social media image links are signed and expire, so they are never stored (the board shows a placeholder instead).
const EXPIRING_IMG = /(cdninstagram\.com|fbcdn\.net|scontent[\w.-]*)$/i;
export function cleanRecipe(r, now) {
  if (!r || typeof r !== 'object') throw new Error('recipe object needed');
  if (!RECIPE_ID_RE.test(r.id || '')) throw new Error('recipe id must look like custom-<name> or web-<name>');
  const title = clean(r.title, 120);
  if (!title) throw new Error('title needed');
  const ingredients = (Array.isArray(r.ingredients) ? r.ingredients : []).slice(0, 60).map((i) => ({
    name: clean(i?.name, 120), qty: num(i?.qty), unit: clean(i?.unit, 16) || null, ...(i?.check && { check: true }),
  })).filter((i) => i.name);
  if (!ingredients.length) throw new Error('ingredients needed');
  const steps = (Array.isArray(r.steps) ? r.steps : []).map((x) => clean(x, 800)).filter(Boolean).slice(0, 40);
  let image = url(r.image);
  try { if (image && EXPIRING_IMG.test(new URL(image).host)) image = null; } catch { image = null; }
  const t = Math.round(+r.timeMins);
  return {
    id: r.id, title, source: ['web', 'other'].includes(r.source) ? r.source : 'other', sourceUrl: url(r.sourceUrl),
    addedBy: person(r.addedBy), addedAt: now, image, timeMins: t >= 1 && t <= 600 ? t : null,
    servings: Math.max(1, Math.min(12, Math.round(+r.servings || 2))), ingredients, steps,
    description: clean(r.description, 300) || null,
    tags: strs(r.tags, 12).map((x) => x.slice(0, 30)), flags: strs(r.flags, 10), cuisine: clean(r.cuisine, 40) || null, notes: clean(r.notes, 500) || null,
    categories: [...new Set(strs(r.categories, 12).map(categoryId).filter(Boolean))], // explicit Library categories, e.g. slow-cooker
  };
}
function applyRecipe(map, op, ctx) {
  if (op.op === 'recipe-add') { const r = cleanRecipe(op.recipe, ctx.now); map.set(r.id, { ...(map.get(r.id) && { firstAddedAt: map.get(r.id).firstAddedAt || map.get(r.id).addedAt }), ...r }); }
  else if (op.op === 'recipe-remove') { if (!map.has(op.id)) throw new Error('no such recipe'); map.delete(op.id); }
}
export async function loadRecipes(env) {
  const rlogs = await readLogs(env, 'rwriters', 'rlog:');
  const map = new Map();
  for (const e of ordered(rlogs)) { try { applyRecipe(map, e.o, ctxOf(e)); } catch { /* skip */ } }
  return { map, rlogs };
}
function applyPrefs(prefs, op, ctx, week) {
  const by = person(op.by);
  if (op.op === 'dislike') {
    if (!by) throw new Error('by must be a short lower-case id');
    if (!ID_RE.test(op.recipeId || '')) throw new Error('bad recipeId');
    if (!prefs.dislikes.some((x) => x.recipeId === op.recipeId && x.by === by)) {
      if (prefs.dislikes.length >= 500) throw new Error('too many dislikes');
      prefs.dislikes.push({ recipeId: op.recipeId, by, at: ctx.now, week, reasons: [] });
    }
  } else if (op.op === 'dislike-reasons') {
    const x = prefs.dislikes.find((d) => d.recipeId === op.recipeId && d.by === by);
    if (!x) throw new Error('no such dislike');
    x.reasons = [...new Set((Array.isArray(op.reasons) ? op.reasons : []).filter((r) => REASONS.includes(r)))];
  } else if (op.op === 'undislike') {
    prefs.dislikes = prefs.dislikes.filter((d) => !(d.recipeId === op.recipeId && (!by || d.by === by)));
  } else if (op.op === 'lock') {
    prefs.history[week] = { dinners: ids(op.dinners, 7), at: ctx.now };
  } else if (op.op === 'unlock') {
    delete prefs.history[week];
  }
}
// Past weeks' locked-in dinners, newest first (the board's "Had before").
const historyList = (prefs) => Object.entries(prefs.history).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 52).map(([week, h]) => ({ week, ...h }));

// ---------- append-only per-writer logs ----------
const WRITER_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const MAX_WRITERS = 40, MAX_LOG = 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (n) => 40 + Math.random() * 120 * (n + 1);

// The writer index is add-only. Registration re-reads to verify, and once an hour a KV list of the log keys repairs
// anything still missing (two new devices registering at the same instant).
async function loadIndex(env, key, prefix) {
  const idx = (await env.STATE.get(key, 'json')) || { writers: [], listedAt: null };
  if (!idx.listedAt || Date.now() - Date.parse(idx.listedAt) > 3600e3) {
    const found = [];
    let cursor;
    do { const r = await env.STATE.list({ prefix, cursor }); found.push(...r.keys.map((k) => k.name.slice(prefix.length))); cursor = r.list_complete ? null : r.cursor; } while (cursor);
    const writers = [...new Set([...idx.writers, ...found])].slice(0, MAX_WRITERS);
    await env.STATE.put(key, JSON.stringify({ writers, listedAt: new Date().toISOString() }));
    return { writers };
  }
  return idx;
}
async function register(env, key, writer) {
  for (let n = 0; n < 4; n++) {
    const idx = (await env.STATE.get(key, 'json')) || { writers: [], listedAt: null };
    if (idx.writers.includes(writer)) return true;
    if (idx.writers.length >= MAX_WRITERS) throw new Error('too many devices this week');
    await env.STATE.put(key, JSON.stringify({ ...idx, writers: [...idx.writers, writer] }));
    await sleep(jitter(n));
    if (((await env.STATE.get(key, 'json'))?.writers || []).includes(writer)) return true;
  }
  return false; // the hourly list still finds the log
}
// Append entries to this writer's own log, re-read to verify, retry up to 3 times with jitter.
async function append(env, key, log, entries) {
  for (let n = 0; n < 4; n++) {
    const next = { ops: [...(log?.ops || []), ...entries].slice(-MAX_LOG) };
    await env.STATE.put(key, JSON.stringify(next));
    const check = await env.STATE.get(key, 'json');
    if (entries.every((e) => check?.ops?.some((x) => x.t === e.t && x.s === e.s))) return next;
    await sleep(jitter(n));
    log = check;
  }
  throw new Error('could not save - try again');
}
async function readLogs(env, idxKey, prefix) {
  const { writers } = await loadIndex(env, idxKey, prefix);
  const logs = await Promise.all(writers.map((w) => env.STATE.get(prefix + w, 'json')));
  return new Map(writers.map((w, i) => [w, logs[i] || { ops: [] }]));
}
const ordered = (logs) => [...logs].flatMap(([w, l]) => l.ops.map((e) => ({ ...e, w }))).sort((a, b) => a.t - b.t || (a.w < b.w ? -1 : a.w > b.w ? 1 : 0) || a.s - b.s);
const ctxOf = (e) => ({ now: new Date(e.t).toISOString(), uid: `${e.w}-${e.t.toString(36)}-${e.s}` });

function foldWeek(base, entries) {
  const s = base;
  for (const e of entries) {
    try { apply(s, e.o, ctxOf(e)); } catch { continue; } // valid when logged; a concurrent op may make it moot
    s.updatedAt = ctxOf(e).now;
    s.updatedBy = person(e.o.by) || person(e.o.person) || s.updatedBy;
  }
  s.version = entries.length;
  return s;
}
function foldPrefs(entries) {
  const p = { dislikes: [], history: {} };
  for (const e of entries) { try { applyPrefs(p, e.o, ctxOf(e), e.wk); } catch { /* skip */ } }
  return p;
}
async function loadAll(env, week) {
  const [wlogs, plogs] = await Promise.all([readLogs(env, 'writers:' + week, `log:${week}:`), readLogs(env, 'pwriters', 'plog:')]);
  const s = foldWeek(blank(week), ordered(wlogs));
  const prefs = foldPrefs(ordered(plogs));
  return { s, prefs, wlogs, plogs };
}

export async function onRequestGet({ request, env }) {
  if (!env.STATE) return json({ error: 'KV binding STATE missing - see docs/SETUP.md' }, 503);
  const params = new URL(request.url).searchParams;
  if (params.get('recipes')) return json({ recipes: [...(await loadRecipes(env)).map.values()] });
  const week = params.get('week') || '';
  if (!WEEK_RE.test(week)) return json({ error: 'week=YYYY-MM-DD needed' }, 400);
  const { s, prefs } = await loadAll(env, week);
  return json({ ...s, dislikes: prefs.dislikes, history: historyList(prefs) });
}

export async function onRequestPost({ request, env }) {
  if (!env.STATE) return json({ error: 'KV binding STATE missing - see docs/SETUP.md' }, 503);
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'JSON only' }, 415);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad JSON' }, 400); }
  const week = body?.week || '';
  if (!WEEK_RE.test(week)) return json({ error: 'week=YYYY-MM-DD needed' }, 400);
  const ops = Array.isArray(body.ops) ? body.ops.slice(0, 100) : [];
  if (JSON.stringify(body).length > 200000) return json({ error: 'too big' }, 413);
  if (!ops.length) return json({ error: 'ops needed' }, 400);
  const writer = WRITER_RE.test(body.writer || '') ? body.writer : 'shared';
  const { s, prefs, wlogs, plogs } = await loadAll(env, week);
  const recipeOps = ops.some((o) => RECIPE_OPS.includes(o?.op));
  const rec = recipeOps ? await loadRecipes(env) : null;
  // Entries get server time; t is bumped past this writer's last entry so its own order is always kept.
  const mine = wlogs.get(writer)?.ops || [];
  const t = Math.max(Date.now(), (mine.at(-1)?.t || 0) + 1);
  let seq = (mine.at(-1)?.s || 0);
  const entries = ops.map((o) => ({ t, s: ++seq, o }));
  try {
    for (const e of entries) {
      const ctx = ctxOf({ ...e, w: writer });
      apply(s, e.o, ctx);
      if (PREF_OPS.includes(e.o?.op)) applyPrefs(prefs, e.o, ctx, week);
      if (RECIPE_OPS.includes(e.o?.op)) applyRecipe(rec.map, e.o, ctx);
      s.updatedAt = ctx.now; s.updatedBy = person(e.o.by) || person(e.o.person) || s.updatedBy;
    }
  } catch (err) { return json({ error: err.message }, 400); }
  try {
    const wentries = entries.filter((e) => !RECIPE_OPS.includes(e.o?.op)); // recipes live in their own logs
    if (wentries.length) {
      await append(env, `log:${week}:${writer}`, wlogs.get(writer), wentries);
      if (!wlogs.has(writer)) await register(env, 'writers:' + week, writer);
    }
    if (recipeOps) {
      const rmine = rec.rlogs.get(writer)?.ops || [];
      const rt = Math.max(t, (rmine.at(-1)?.t || 0) + 1);
      await append(env, 'rlog:' + writer, rec.rlogs.get(writer), entries.filter((e) => RECIPE_OPS.includes(e.o?.op)).map((e, i) => ({ ...e, t: rt, s: (rmine.at(-1)?.s || 0) + i + 1 })));
      if (!rec.rlogs.has(writer)) await register(env, 'rwriters', writer);
    }
    const pentries = entries.filter((e) => PREF_OPS.includes(e.o?.op)).map((e) => ({ ...e, wk: week }));
    if (pentries.length) {
      const pmine = plogs.get(writer)?.ops || [];
      const pt = Math.max(t, (pmine.at(-1)?.t || 0) + 1);
      await append(env, 'plog:' + writer, plogs.get(writer), pentries.map((e, i) => ({ ...e, t: pt, s: (pmine.at(-1)?.s || 0) + i + 1 })));
      if (!plogs.has(writer)) await register(env, 'pwriters', writer);
    }
  } catch (err) { return json({ error: err.message }, 503); }
  s.version = (s.version || 0) + entries.filter((e) => !RECIPE_OPS.includes(e.o?.op)).length;
  return json({ ...s, dislikes: prefs.dislikes, history: historyList(prefs), ...(rec && { recipes: [...rec.map.values()] }) });
}
