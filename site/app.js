// Supper Board - vanilla JS, no build step. Reads the recipe library and settings from ./data/ (written by
// scripts/sync-site.mjs). Votes, the week's list, locked-in dinners, shopping extras, "Not for us" and your own recipes are
// shared between phones through /api/state (Cloudflare Pages Function + KV). Recipe and shopping tick-offs stay on each
// device (localStorage).
'use strict';

const DATA = './data/';
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const sheet = $('#sheet');

const state = {
  config: null, people: [], remote: null, sync: 'idle', me: null, index: [], byId: new Map(), week: null, full: null,
  lib: { q: '', cats: [], open: '', tag: '', limit: 40 }, rules: null,
};

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function getJson(name) {
  const res = await fetch(DATA + name, { cache: 'no-cache' });
  if (!res.ok) throw Object.assign(new Error(`${name}: HTTP ${res.status}`), { status: res.status });
  return res.json();
}
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('sb:' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sb:' + k, JSON.stringify(v)); } catch {} },
};
const okImg = (u) => { try { return new URL(u).protocol === 'https:'; } catch { return false; } };
const photo = (url, w, h, alt = '') =>
  url && okImg(url) ? `<img src="${esc(url)}" alt="${esc(alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" width="${w}" height="${h}">` : '';
const placeholder = (r, cls = 'ph') => `<div class="${cls} ph-emoji" aria-hidden="true">${esc(r?.emoji || '🍽️')}</div>`;
const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' });
const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const longFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const clockFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const d = (ymd) => new Date(ymd + 'T00:00:00Z');
const ymd = (t) => t.toISOString().slice(0, 10);
const addDays = (s, n) => { const t = d(s); t.setUTCDate(t.getUTCDate() + n); return ymd(t); };
const mins = (m) => (m ? (m >= 120 ? `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : 's'}` : `${m} min`) : '');
const recipeLink = (id) => `#recipe/${encodeURIComponent(id)}`;
const personName = (id) => state.people.find((p) => p.id === id)?.name || 'someone';
const everyoneLabel = () => (state.people.length === 2 ? 'Both picked' : 'Everyone picked');
const srcTag = (r) => (r.custom
  ? `<span class="src src-own">${r.source === 'web' ? 'From a link' : 'Your recipe'}${r.addedBy ? ' · ' + esc(personName(r.addedBy)) : ''}</span>`
  : r.source === 'sample' ? '<span class="src src-sample">Sample</span>' : '');
function whenTxt(iso) {
  const t = new Date(iso);
  return t.toDateString() === new Date().toDateString() ? `at ${clockFmt.format(t)}` : timeFmt.format(t);
}

// Weeks start on Monday. This week, plus the one before and after, are in the picker.
function mondayOf(t = new Date()) {
  const x = new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return ymd(x);
}
const thisWeek = () => mondayOf();
function setHeader() {
  const w = state.week;
  $('#week-label').textContent = `Week of ${dateFmt.format(d(w))}`;
  const sel = $('#week-select');
  const now = thisWeek();
  const weeks = [addDays(now, -7), now, addDays(now, 7)];
  sel.hidden = false;
  sel.innerHTML = weeks.map((x) => `<option value="${x}"${x === w ? ' selected' : ''}>${x === now ? 'This week' : x < now ? 'Last week' : 'Next week'}</option>`).join('');
}

// ---------- shared state helpers ----------
const rem = () => (state.remote?.week === state.week ? state.remote : null);
const votesFor = (personId) => new Set(rem()?.votes?.[personId] || []);
const history = () => state.remote?.history || [];
const dislikes = () => state.remote?.dislikes || [];
const dislikesOf = (id) => dislikes().filter((x) => x.recipeId === id);
let shortlistMod = null, catMod = null, shopMod = null;

// The week's vote list: the stored one, else a list built from the library. The built list uses a random seed made from the
// week's date, so every phone builds the same one; it's saved as soon as anyone votes.
let autoList = { week: null, list: [] };
function builtList() {
  if (autoList.week === state.week && autoList.list.length) return autoList.list;
  if (!shortlistMod) return [];
  const res = shortlistMod.fill({ library: state.index, recent: recentIds(), dislikes: dislikes(), random: shortlistMod.rng('week:' + state.week), rules: state.rules });
  autoList = { week: state.week, list: res.options };
  return res.options;
}
function optionsOf() {
  const r = rem();
  const base = r?.options?.list?.length ? r.options.list : builtList();
  const added = Object.keys(r?.options?.added || {});
  return [...base, ...added.filter((id) => !base.includes(id))].filter((id) => state.byId.has(id));
}
const storedList = () => !!rem()?.options?.list?.length;
const addedInfo = (id) => rem()?.options?.added?.[id] || null;
const baseList = () => (storedList() ? rem().options.list : builtList());

// ---------- "Had before" (past weeks' locked-in dinners) ----------
function pastDinners() {
  const seen = new Set(), out = [];
  for (const h of history().filter((x) => x.week < state.week)) {
    for (const id of h.dinners) { if (seen.has(id)) continue; seen.add(id); out.push({ id, weekStart: h.week }); }
  }
  return out;
}
function recentIds() {
  const from = addDays(state.week, -7 * (state.rules?.recentWeeks || 3));
  return history().filter((h) => h.week < state.week && h.week >= from).flatMap((h) => h.dinners);
}
function agoTxt(weekStart) {
  const n = Math.round((d(state.week) - d(weekStart)) / (7 * 864e5));
  return n <= 0 ? 'this week' : n === 1 ? 'last week' : `${n} weeks ago`;
}
const hadBefore = (id) => pastDinners().find((p) => p.id === id) || null;

// ---------- week settings: how many dinners, which nights ----------
// The suggestion (weekInfo, set by an agent or scripts/board.mjs) else config.dinnersPerWeek; - / + on the board wins.
function weekInfo() {
  const r = rem(), wi = r?.weekInfo || {};
  const suggested = { dinners: wi.dinners || state.config.dinnersPerWeek || 4, nights: wi.nights || [] };
  const adj = r?.adjust || null;
  return { ...suggested, ...(adj && { dinners: adj.dinners, nights: adj.nights }), note: wi.note || '', suggested, adjust: adj };
}
function adjustedWeek(delta) {
  const wi = weekInfo(), dinners = Math.min(7, Math.max(1, wi.dinners + delta));
  let nights = [...wi.nights].sort();
  if (delta > 0 && nights.length && nights.length < dinners) {
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(state.week, i));
    const free = days.filter((x) => !nights.includes(x));
    const next = free.find((x) => x > nights.at(-1)) || free[0];
    if (next) nights = [...nights, next].sort();
  }
  if (delta < 0) nights = nights.slice(0, dinners);
  return { dinners, nights };
}
function adjustDinners(delta) {
  if (!state.me) { toast('Pick who you are first (on the Vote tab)'); return; }
  const wi = weekInfo(), next = adjustedWeek(delta);
  if (next.dinners === wi.dinners) return;
  const same = next.dinners === wi.suggested.dinners && JSON.stringify(next.nights) === JSON.stringify([...wi.suggested.nights].sort());
  sendOps([same ? { op: 'week-adjust-reset' } : { op: 'week-adjust', dinners: next.dinners, nights: next.nights, by: state.me }]);
}
const picksLimit = () => weekInfo().dinners;
function weekBanner() {
  const { note, nights, dinners, suggested, adjust } = weekInfo();
  const days = nights.map((n) => `${dayFmt.format(d(n))} ${d(n).getUTCDate()}`).join(' · ');
  const line = adjust
    ? `Set to ${adjust.dinners}${adjust.by ? ` by ${esc(personName(adjust.by))}` : ''} · <button class="linkbtn" data-act="dinners-reset">back to ${suggested.dinners}</button>`
    : (note ? esc(note) : '');
  return `<div class="week-note"><span class="ic" aria-hidden="true">🗓️</span><div class="wn-body">
      <div class="wn-top"><strong>${dinners} dinner${dinners === 1 ? '' : 's'} this week</strong>
        <span class="stepper" role="group" aria-label="Dinners this week"><button data-act="dinners-minus" aria-label="One fewer dinner"${dinners <= 1 ? ' disabled' : ''}>−</button><button data-act="dinners-plus" aria-label="One more dinner"${dinners >= 7 ? ' disabled' : ''}>+</button></span></div>
      ${days ? `<span>Dinners on ${esc(days)}</span>` : ''}${line ? `<span class="wn-sug">${line}</span>` : ''}</div></div>`;
}
const shownVotes = (personId) => { const shown = new Set(optionsOf()); return [...votesFor(personId)].filter((id) => shown.has(id)); };
const allPicked = (id) => state.people.every((p) => votesFor(p.id).has(id));

// ---------- views: This week ----------
function lockedMeals() {
  const l = rem()?.locked;
  if (!l) return [];
  const nights = [...weekInfo().nights].sort();
  return l.dinners.map((id, n) => ({ recipeId: id, night: nights[n] || null }));
}
function weekMealsHtml() {
  const meals = lockedMeals();
  if (!meals.length) return `<div class="empty"><strong>No dinners locked in yet</strong>Vote on the Vote tab. When everyone has picked, lock in the winners and they show here.</div>`;
  const cards = meals.map((c) => {
    const r = state.byId.get(c.recipeId);
    if (!r) return `<div class="empty">That recipe isn't in the library any more.</div>`;
    return `<a class="meal" href="${recipeLink(r.id)}">
      <div class="photo">${photo(r.image, 800, 500, r.name) || placeholder(r)}${c.night ? `<div class="night">${esc(dayFmt.format(d(c.night)))}<b>${d(c.night).getUTCDate()}</b></div>` : ''}</div>
      <div class="body"><h3>${esc(r.name)}</h3>${r.subtitle ? `<p class="subtitle">${esc(r.subtitle)}</p>` : ''}
        <div class="meta">${r.totalTimeMinutes ? `<span>⏱ ${mins(r.totalTimeMinutes)}</span>` : ''}${r.cuisine ? `<span>${esc(r.cuisine)}</span>` : ''}${srcTag(r)}</div>
      </div></a>`;
  }).join('');
  return `<div class="status-row"><span class="section-sub">${meals.length} dinner${meals.length === 1 ? '' : 's'}</span><span class="pill sage">Locked in</span></div>${cards}`;
}
function renderWeek() {
  return `<h2 class="section-title">This week</h2>
    <div id="week-note-slot">${weekBanner()}</div>
    <div id="lock-slot">${lockCard()}</div>
    <div id="meals-slot">${weekMealsHtml()}</div>`;
}

// ---------- "Lock in these dinners" ----------
function readiness() {
  if (!shortlistMod?.settle) return null;
  return shortlistMod.settle({ options: optionsOf(), votes: Object.fromEntries(state.people.map((p) => [p.id, [...votesFor(p.id)]])), people: state.people, n: picksLimit() });
}
function lockCard() {
  const r = rem();
  const names = (ids) => ids.map((id) => state.byId.get(id)?.name || id);
  if (r?.locked) {
    const l = r.locked;
    return `<div class="ready-card sent"><div class="rc-top"><span class="ic" aria-hidden="true">✅</span><div>
        <strong>Locked in${l.by ? ` by ${esc(personName(l.by))}` : ''} ${esc(whenTxt(l.at))}</strong>
        <span>The shopping list is ready on the Shopping tab.</span></div></div>
      <button class="linkbtn" data-act="unlock">Undo - not decided yet</button></div>`;
  }
  const rd = readiness();
  if (!rd) return '';
  const why = [...rd.missing, ...(rd.tie ? [`tie for the last ${rd.tie.places === 1 ? 'place' : rd.tie.places + ' places'} between ${names(rd.tie.between).join(', ')}`] : [])];
  return `<div class="ready-card${rd.ok ? ' go' : ''}">
    ${rd.ok ? `<div class="rc-head">Your ${picksLimit()} dinners</div><ul class="rc-list">${names(rd.dinners).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <button class="primary" data-act="lock"${rd.ok && state.me ? '' : ' disabled'}>Lock in these dinners</button>
    <p class="hint">${rd.ok ? (state.me ? 'Puts them on This week and builds the shopping list.' : 'Pick who you are (Vote tab) first.') : `Not yet: ${esc(why.join(' · '))}`}</p></div>`;
}

// ---------- "Not for us" 👎 ----------
const REASONS = [['ingredient', 'Ingredient'], ['spicy', 'Too spicy'], ['fiddly', 'Too fiddly'], ['notkeen', 'Just not keen']];
let nk = null; // the open panel: {id, by, remove, snapshot, hadVote, replace, keptBy, timer}
async function notForUs(id) {
  if (!state.me) { toast('Pick who you are first (on the Vote tab)'); return; }
  if (dislikesOf(id).some((x) => x.by === state.me)) { toast('Already on your "not for us" list'); return; }
  await loadRemote(true);
  const inList = optionsOf().includes(id);
  const keptBy = state.people.find((p) => p.id !== state.me && votesFor(p.id).has(id));
  const remove = inList && !keptBy;
  const snapshot = optionsOf();
  let replace = null;
  if (remove) {
    const list = snapshot.filter((x) => x !== id);
    const seen = [...new Set([...(rem()?.options?.seen || []), ...snapshot])];
    const res = shortlistMod.fill({ library: state.index, keep: list, seen, recent: recentIds(), dislikes: [...dislikes(), { recipeId: id, by: state.me }], rules: { ...state.rules, count: list.length + 1 } });
    replace = res.added[0] || null;
  }
  const hadVote = votesFor(state.me).has(id);
  sendOps([{ op: 'dislike', recipeId: id, by: state.me, remove, base: baseList(), replace }]);
  openNk({ id, by: state.me, remove, inList, snapshot, hadVote, replace, keptBy });
}
function openNk(info) {
  clearTimeout(nk?.timer);
  nk = { ...info, reasons: [], timer: setTimeout(closeNk, 120000) }; // undo for 2 minutes
  let el = document.getElementById('nk');
  if (!el) { el = document.createElement('div'); el.id = 'nk'; el.className = 'nk'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Not for us'); document.body.append(el); el.addEventListener('click', nkClick); }
  renderNk();
}
function renderNk() {
  const el = document.getElementById('nk');
  if (!el || !nk) return;
  const r = state.byId.get(nk.id), rep = nk.replace && state.byId.get(nk.replace);
  const what = !nk.inList ? "Won't be suggested again." : nk.remove ? `Taken off this week${rep ? ` - swapped in “${esc(rep.name)}”` : ''}.` : `Kept on the list - ${esc(nk.keptBy?.name || 'someone')} voted for it.`;
  el.innerHTML = `<div class="nk-top"><strong>👎 Not for us: ${esc(r?.name || '')}</strong><button class="x" data-nk="close" aria-label="Close">×</button></div>
    <div class="nk-what">${what}</div>
    <div class="nk-why"><span>Why? (optional)</span>${REASONS.map(([k, l]) => `<button class="nk-chip${nk.reasons.includes(k) ? ' on' : ''}" data-nk-reason="${k}">${l}</button>`).join('')}</div>
    <button class="linkbtn" data-nk="undo">Undo</button>`;
  el.classList.add('on');
}
function closeNk() { clearTimeout(nk?.timer); nk = null; document.getElementById('nk')?.classList.remove('on'); }
function nkClick(e) {
  if (!nk) return;
  const reason = e.target.closest('[data-nk-reason]')?.dataset.nkReason;
  if (reason) {
    nk.reasons = nk.reasons.includes(reason) ? nk.reasons.filter((x) => x !== reason) : [...nk.reasons, reason];
    sendOps([{ op: 'dislike-reasons', recipeId: nk.id, by: nk.by, reasons: nk.reasons }]);
    renderNk(); return;
  }
  const a = e.target.closest('[data-nk]')?.dataset.nk;
  if (a === 'close') closeNk();
  if (a === 'undo') {
    const ops = [{ op: 'undislike', recipeId: nk.id, by: nk.by, ...(nk.remove && { list: nk.snapshot }) }];
    if (nk.hadVote) ops.push({ op: 'vote', person: nk.by, recipeId: nk.id, on: true });
    sendOps(ops); closeNk(); toast('Undone - back as it was');
  }
}
const nkLabel = (id) => { const xs = dislikesOf(id); return xs.length ? `Not for us (${xs.map((x) => personName(x.by)).join(' & ')})` : ''; };

// ---------- "Add to this week's picks" (Library / recipe page) ----------
// The first op of a week saves the built list, so everyone keeps seeing the same one.
const ensureList = () => (storedList() || !optionsOf().length ? [] : [{ op: 'options-set', list: baseList(), seen: baseList(), by: null }]);
function ruleWhy(id) { const r = state.byId.get(id); return r && shortlistMod ? shortlistMod.classify(r, state.rules).why : []; }
function addToWeek(id) {
  if (!state.me) { toast('Pick who you are first (on the Vote tab)'); return; }
  if (votesFor(state.me).has(id) && optionsOf().includes(id)) { toast("It's already in your picks"); return; }
  const k = shownVotes(state.me).length, n = picksLimit();
  if (k >= n) { toast(k === n ? `You've picked ${n} - untick one first` : `Only ${n} dinners this week - untick ${k - n + 1} first`); return; }
  const ops = ensureList();
  if (!optionsOf().includes(id)) ops.push({ op: 'option-add', recipeId: id, base: baseList(), by: state.me });
  ops.push({ op: 'vote', person: state.me, recipeId: id, on: true });
  sendOps(ops);
  const why = [...ruleWhy(id), ...dislikesOf(id).map((x) => `${personName(x.by)} said not for us`)];
  toast(why.length ? `Added to this week - heads up: ${why.join(', ')}` : "Added to this week's picks ✓");
}
function ruleWarn(id) {
  const why = ruleWhy(id), nkl = nkLabel(id);
  return [why.length ? `⚠️ Outside your usual rules: ${why.join(', ')}` : '', nkl ? `👎 ${nkl}` : ''].filter(Boolean).join(' · ');
}
function addBtn(id, compact) {
  const inList = optionsOf().includes(id), mine = inList && state.me && votesFor(state.me).has(id);
  const label = mine ? '✓ In your picks' : inList ? "👍 Vote - it's on this week's list" : "+ Add to this week's picks";
  if (compact) return `<button class="add-btn${mine ? ' on' : ''}" data-add="${esc(id)}" aria-label="${esc(label)}" title="${esc(label)}">${mine ? '✓' : '+'}</button>`;
  return `<button class="add-wide${mine ? ' on' : ''}" data-add="${esc(id)}">${label}</button>`;
}

let toastTimer;
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = msg; el.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('on'), 3200);
}

function whoPicker(context) {
  if (state.me) {
    const p = state.people.find((x) => x.id === state.me);
    return `<div class="who-chip"><span class="av">${esc(p.name[0])}</span>You're ${esc(p.name)} on this phone <button class="linkbtn" data-act="who-change">Change</button></div>`;
  }
  return `<div class="who-card"><strong>Who's this?</strong><span>So ${esc(context)} know who it was. Asked once per phone.</span>
    <div class="who-btns">${state.people.map((p) => `<button class="who-btn" data-who="${esc(p.id)}"><span class="av">${esc(p.name[0])}</span>${esc(p.name)}</button>`).join('')}</div></div>`;
}

function syncNote() {
  const t = { idle: '', loading: 'Syncing…', saving: 'Saving…', synced: 'Synced between phones', offline: "Offline - changes will save when you're back online", signin: 'Signed out - reload to sign in again', noapi: 'Preview mode (no /api here) - changes stay on this device' }[state.sync] || '';
  return `<span class="sync sync-${esc(state.sync)}">${esc(t)}</span>`;
}

// ---------- Vote ----------
// Order: picked by everyone, then picks by one or more people (this phone's person first; most recent vote first), then
// everything else in the list's own order.
function voteGroups() {
  const opts = optionsOf();
  const sets = Object.fromEntries(state.people.map((p) => [p.id, votesFor(p.id)]));
  const recency = (pid, id) => [...sets[pid]].lastIndexOf(id);
  const all = opts.filter((id) => state.people.every((p) => sets[p.id].has(id)));
  const order = state.me ? [state.me, ...state.people.map((p) => p.id).filter((x) => x !== state.me)] : state.people.map((p) => p.id);
  const placed = new Set(all);
  const singles = order.map((pid) => {
    const ids = opts.filter((id) => sets[pid].has(id) && !placed.has(id)).sort((a, b) => recency(pid, b) - recency(pid, a));
    ids.forEach((id) => placed.add(id));
    return { label: pid === state.me ? 'Your picks' : `Picked by ${personName(pid)}`, ids };
  });
  return [{ label: '★ ' + everyoneLabel(), ids: all }, ...singles, { label: 'Everything else', ids: opts.filter((id) => !placed.has(id)) }].filter((g) => g.ids.length);
}
function voteCards() {
  const groups = voteGroups();
  if (groups.length === 1) return voteCard(groups[0].ids);
  return groups.map((g) => `<div class="vote-sep" role="heading" aria-level="3">${esc(g.label)} <span>${g.ids.length}</span></div>${voteCard(g.ids)}`).join('');
}
function voteCard(ids) {
  const locked = new Set(rem()?.locked?.dinners || []);
  const sets = Object.fromEntries(state.people.map((p) => [p.id, votesFor(p.id)]));
  return ids.map((id) => {
    const r = state.byId.get(id);
    if (!r) return '';
    const voters = state.people.map((p) => {
      const yes = sets[p.id].has(id);
      return `<span class="voter ${yes ? 'yes' : ''}" title="${esc(p.name)} ${yes ? 'voted for this' : 'has not voted for this'}"><span class="av">${esc(p.name[0])}</span>${yes ? 'Yes' : '–'}</span>`;
    }).join('');
    const mine = state.me && sets[state.me].has(id);
    const all = state.people.length > 1 && state.people.every((p) => sets[p.id].has(id));
    const full = state.me && !mine && shownVotes(state.me).length >= picksLimit();
    const add = addedInfo(id), had = hadBefore(id), why = add ? ruleWhy(id) : [];
    const chips = [had ? `<span class="chip had">Had before · ${esc(agoTxt(had.weekStart))}</span>` : '',
      add ? `<span class="chip added">Added${add.by ? ' by ' + esc(personName(add.by)) : ''} from the library</span>` : '',
      why.length ? `<span class="chip warn" title="${esc(ruleWarn(id))}">⚠️ ${esc(why.join(', '))}</span>` : '',
      ...dislikesOf(id).map((x) => `<span class="chip nk">${esc(personName(x.by))}: not keen</span>`)].join('');
    const iNk = state.me && dislikesOf(id).some((x) => x.by === state.me);
    const canRemove = add && !state.people.some((p) => sets[p.id].has(id));
    return `<div class="opt ${locked.has(id) ? 'chosen' : ''}${all ? ' both' : ''}" data-opt="${esc(id)}">
      <a class="opt-link" href="${recipeLink(id)}"><div class="photo">${photo(r.image, 480, 360, r.name) || placeholder(r)}</div>
      ${locked.has(id) ? '<span class="pill sage ribbon">✓ Locked in</span>' : all ? `<span class="pill ribbon both-pill">★ ${everyoneLabel()}</span>` : ''}
      <div class="body"><h3>${esc(r.name)}</h3><div class="meta">${r.totalTimeMinutes ? `<span>⏱ ${mins(r.totalTimeMinutes)}</span>` : ''}${r.cuisine ? `<span>${esc(r.cuisine)}</span>` : ''}${srcTag(r)}</div>${chips ? `<div class="chips">${chips}</div>` : ''}</div></a>
      <div class="opt-foot"><div class="votes">${voters}${state.me && !iNk ? `<button class="nk-btn" data-nk-id="${esc(id)}" title="Not for us" aria-label="Not for us">👎</button>` : ''}</div>${canRemove ? `<button class="linkbtn rm-add" data-rm-add="${esc(id)}">Remove from this week</button>` : ''}
      <button class="vote-btn ${mine ? 'on' : ''}${full ? ' full' : ''}" data-vote="${esc(id)}" aria-pressed="${mine ? 'true' : 'false'}"${state.me ? '' : ' disabled'}>${mine ? '✓ Voted' : '👍 Vote'}</button></div></div>`;
  }).join('');
}
const voteSub = () => `${picksLimit()} dinners this week - pick your ${picksLimit()} from these ${optionsOf().length}.${state.people.length > 1 ? ` The ones you all pick (★) are the likely winners. Votes show on every phone.` : ''}`;
function voteTally() {
  const n = picksLimit();
  const all = state.people.length > 1 ? optionsOf().filter(allPicked).length : 0;
  return state.people.map((p) => { const k = shownVotes(p.id).length; return `<span class="pill ${k > n ? 'mustard' : k === n ? 'sage' : state.me === p.id ? '' : 'grey'}">${esc(p.name)}: ${k} of ${n}${k === n ? ' ✓' : ''}${k > n ? ` - untick ${k - n}` : ''}</span>`; }).join('')
    + (all ? `<span class="pill both-pill">★ ${everyoneLabel()}: ${all}</span>` : '');
}

// Re-sort smoothly (FLIP): remember where each card was, re-render, then slide moved cards from their old spot.
let gridHtml = '';
function flipGrid(html) {
  const grid = document.getElementById('vote-grid');
  if (!grid || gridHtml === html) return;
  gridHtml = html;
  const before = new Map([...grid.querySelectorAll('[data-opt]')].map((el) => [el.dataset.opt, el.getBoundingClientRect()]));
  const orderBefore = [...before.keys()];
  grid.innerHTML = html;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  [...grid.querySelectorAll('[data-opt]')].forEach((el, n) => {
    const old = before.get(el.dataset.opt);
    if (!old || orderBefore.indexOf(el.dataset.opt) === n) return;
    const now = el.getBoundingClientRect(), dx = old.left - now.left, dy = old.top - now.top;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    el.classList.add('moved');
    if (!reduce) {
      el.style.transform = `translate(${dx}px, ${dy}px)`; el.style.transition = 'none';
      requestAnimationFrame(() => requestAnimationFrame(() => { el.style.transition = 'transform .45s cubic-bezier(.2,.8,.2,1)'; el.style.transform = ''; }));
    }
    setTimeout(() => { el.classList.remove('moved'); el.style.transition = ''; }, 1400);
  });
}

// "Show me more": swap every option nobody has voted for (locked-in and library adds stay).
const keptIds = () => {
  const locked = new Set(rem()?.locked?.dinners || []);
  const voted = new Set(state.people.flatMap((p) => [...votesFor(p.id)]));
  return optionsOf().filter((id) => locked.has(id) || voted.has(id) || addedInfo(id));
};
function refreshBar() {
  const o = rem()?.options;
  const swap = optionsOf().length - keptIds().length;
  const note = o?.list?.length && o.at && o.by ? `Refreshed by ${esc(personName(o.by))} ${esc(whenTxt(o.at))}` : '';
  const undo = o?.history?.some((h) => h.list?.length) ? `<button class="linkbtn" data-act="refresh-undo">Undo</button>` : '';
  const busy = state.refreshing;
  return `<div class="refresh-bar">
    <button class="refresh-btn" data-act="refresh"${!state.me || !swap || busy ? ' disabled' : ''}>${busy ? 'Finding more…' : '🔄 Show me more'}</button>
    <span class="refresh-sub">${state.refreshMsg ? esc(state.refreshMsg) : !state.me ? 'Pick who you are first.' : swap ? `Swaps the ${swap} nobody has voted for - votes stay.` : 'Every option has a vote - nothing to swap.'}</span>
    ${note || undo ? `<div class="refresh-note">${note}${note && undo ? ' · ' : ''}${undo}</div>` : ''}</div>`;
}
async function refreshOptions() {
  if (!state.me || state.refreshing) return;
  state.refreshing = true; state.refreshMsg = ''; refreshLive();
  try {
    await loadRemote(true); // someone else may have voted in the last few seconds - keep their picks too
    const current = optionsOf();
    const seen = [...new Set([...(rem()?.options?.seen || []), ...current])];
    const res = shortlistMod.fill({ library: state.index, keep: keptIds(), seen, recent: recentIds(), dislikes: dislikes(), rules: state.rules });
    if (!res.added.length) state.refreshMsg = "That's everything in the library that fits - nothing new to show. Add more recipes in the Library.";
    else sendOps([...ensureList(), { op: 'options-set', list: res.options, seen, by: state.me }]);
  } catch (e) { console.warn(e); state.refreshMsg = "Couldn't load more options - try again."; }
  finally { state.refreshing = false; refreshLive(); }
}

function renderVote() {
  if (!optionsOf().length) return `<h2 class="section-title">Vote</h2><div class="empty"><strong>Nothing to vote on yet</strong>The library is empty. Add a recipe in the Library, by typing it in or from a link.</div>`;
  return `<h2 class="section-title">Vote</h2>
    <div id="week-note-slot">${weekBanner()}</div>
    <p class="section-sub" id="vote-sub">${voteSub()}</p>
    <div id="who-slot">${whoPicker('votes')}</div>
    <div class="tally" id="vote-tally">${voteTally()}</div>
    <div class="sync-row" id="sync-slot">${syncNote()}</div>
    <div id="refresh-slot">${refreshBar()}</div>
    <div class="grid" id="vote-grid">${(gridHtml = voteCards())}</div>
    <div id="lock-slot" class="ready-bottom">${lockCard()}</div>`;
}

// ---------- Library: categories + search ----------
// Chips combine: AND across groups (Chinese + Under 30 min), OR within a group (Chinese or Thai). Time is one choice
// (the time categories are cumulative). Slow cooker is its own toggle.
const PANELS = [{ id: 'time', label: 'Time' }, { id: 'cuisine', label: 'Cuisine' }, { id: 'protein', label: 'Protein' }, { id: 'dish', label: 'Type' }];
const catGroup = (id) => catMod?.CATEGORY_BY_ID.get(id)?.group;
const catsOf = (r) => r.cats || (r.cats = catMod ? catMod.categorize(r) : []);
const libFiltering = () => { const L = state.lib; return !!(L.q || L.cats.length || L.tag); };
function hayOf(r) {
  if (r._hay == null) r._hay = `${r.name} ${r.subtitle || ''} ${r.cuisine || ''} ${(r.tags || []).join(' ')} ${catsOf(r).map((c) => catMod.categoryLabel(c)).join(' ')} ${r.q ?? (catMod ? catMod.ingredientText(r) : '')}`.toLowerCase();
  return r._hay;
}
function catPass(r, skipGroup) {
  const sel = state.lib.cats;
  if (!sel.length) return true;
  const cats = catsOf(r);
  const groups = {};
  for (const id of sel) (groups[catGroup(id)] ||= []).push(id);
  for (const [g, ids] of Object.entries(groups)) if (g !== skipGroup && !ids.some((id) => cats.includes(id))) return false;
  return true;
}
function libraryResults({ skipGroup } = {}) {
  const { q, tag } = state.lib;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hadIds = new Set(pastDinners().map((p) => p.id));
  const nkIds = new Set(dislikes().map((x) => x.recipeId));
  return state.index.filter((r) => {
    if (!catPass(r, skipGroup)) return false;
    if (tag === '__had') { if (!hadIds.has(r.id)) return false; }
    else if (tag === '__nk') { if (!nkIds.has(r.id)) return false; }
    else if (tag === '__own') { if (!r.custom) return false; }
    else if (tag === '__sample') { if (r.source !== 'sample') return false; }
    else if (tag && !(r.tags || []).includes(tag)) return false;
    if (words.length) { const hay = hayOf(r); return words.every((w) => hay.includes(w)); }
    return true;
  });
}
function libTags() {
  const tags = new Map();
  for (const r of state.index) for (const t of r.tags || []) tags.set(t, (tags.get(t) || 0) + 1);
  return [...tags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).filter(([, n]) => n >= 2);
}
function catPanel() {
  const L = state.lib;
  if (!catMod) return '';
  const sel = L.cats.map((id) => `<button class="cat-chip on" data-cat="${esc(id)}" aria-pressed="true">${esc(catMod.categoryLabel(id))} <span aria-hidden="true">✕</span></button>`).join('');
  let panel = '';
  if (L.open) {
    const base = libraryResults({ skipGroup: L.open });
    const chips = catMod.CATEGORIES.filter((c) => c.group === L.open).map((c) => {
      const n = base.filter((r) => catsOf(r).includes(c.id)).length;
      const on = L.cats.includes(c.id);
      return n || on ? `<button class="cat-chip${on ? ' on' : ''}" data-cat="${esc(c.id)}" aria-pressed="${on}">${esc(c.label)} <span class="n">${n}</span></button>` : '';
    }).join('');
    panel = `<div class="cat-panel" role="group" aria-label="${esc(PANELS.find((p) => p.id === L.open)?.label || '')}">${chips || '<span class="cat-none">Nothing here with the other filters.</span>'}</div>`;
  }
  return `${panel}${sel ? `<div class="cat-sel">${sel}<button class="linkbtn" data-act="cats-clear">Clear</button></div>` : ''}`;
}
function catButtons() {
  const L = state.lib;
  if (!catMod) return '';
  const slowOn = L.cats.includes('slow-cooker');
  const nIn = (g) => L.cats.filter((id) => catGroup(id) === g).length;
  return `<button class="cat-btn${slowOn ? ' on' : ''}" data-cat="slow-cooker" aria-pressed="${slowOn}">🍲 Slow cooker</button>`
    + PANELS.map((p) => `<button class="cat-btn${L.open === p.id ? ' open' : ''}${nIn(p.id) ? ' on' : ''}" data-panel="${p.id}" aria-expanded="${L.open === p.id}">${esc(p.label)}${nIn(p.id) ? ` · ${nIn(p.id)}` : ''} <span aria-hidden="true">▾</span></button>`).join('');
}
function refreshLib({ buttons = true } = {}) {
  state.lib.limit = 40;
  if (buttons && $('#cat-btns')) $('#cat-btns').innerHTML = catButtons();
  if ($('#cat-slot')) $('#cat-slot').innerHTML = catPanel();
  if ($('#had-slot')) { $('#had-slot').innerHTML = hadSection(); $('#nk-slot').innerHTML = nkSection(); $('#lib-results').innerHTML = libraryRows(); }
}
function toggleCat(id) {
  const L = state.lib;
  const g = catGroup(id);
  if (L.cats.includes(id)) L.cats = L.cats.filter((x) => x !== id);
  else L.cats = [...L.cats.filter((x) => !(g === 'time' && catGroup(x) === 'time')), id]; // one time at a time
  refreshLib();
}
function libraryRows() {
  const res = libraryResults();
  const rows = res.slice(0, state.lib.limit).map((r) => libRow(r, nkSub(r.id))).join('');
  const more = res.length > state.lib.limit ? `<button class="more" data-act="more">Show ${Math.min(40, res.length - state.lib.limit)} more</button>` : '';
  const empty = state.index.length ? '<div class="empty"><strong>No matches</strong>Try fewer filters.</div>' : '<div class="empty"><strong>No recipes yet</strong>Tap “Add a recipe” to type one in or bring one in from a link.</div>';
  return `<p class="count">${res.length} of ${state.index.length} recipes</p>${rows || empty}${more}`;
}
function libRow(r, sub = '') {
  return `<div class="row"><a class="row-link" href="${recipeLink(r.id)}">
      ${photo(r.thumbnail, 184, 152, '') || placeholder(r)}
      <div class="txt"><h3>${esc(r.name)}</h3>${sub ? `<div class="row-sub">${sub}</div>` : ''}<div class="meta">${r.totalTimeMinutes ? `<span>⏱ ${mins(r.totalTimeMinutes)}</span>` : ''}${r.cuisine ? `<span>${esc(r.cuisine)}</span>` : ''}${srcTag(r)}</div></div></a>
      ${addBtn(r.id, true)}</div>`;
}
function nkSub(id) {
  const xs = dislikesOf(id);
  return xs.length ? `<span class="nk-sub">👎 ${esc(nkLabel(id))}</span> · ${xs.map((x) => `<button class="linkbtn nk-undo" data-undislike="${esc(id)}" data-by="${esc(x.by)}">undo${xs.length > 1 ? ' ' + esc(personName(x.by)) : ''}</button>`).join(' ')}` : '';
}
function nkSection() {
  const L = state.lib;
  if (libFiltering()) return '';
  const ids = [...new Set(dislikes().map((x) => x.recipeId))].reverse().filter((id) => state.byId.has(id));
  if (!ids.length) return '';
  const rows = ids.slice(0, L.nkAll ? 999 : 3).map((id) => libRow(state.byId.get(id), nkSub(id))).join('');
  return `<section class="had nk-list"><h3 class="had-h"><span aria-hidden="true">👎</span> Not for us <span class="cat-n">${ids.length}</span></h3>${rows}
    ${ids.length > 3 && !L.nkAll ? `<button class="more" data-act="nk-all">Show all ${ids.length}</button>` : ''}</section>`;
}
function hadSection() {
  if (libFiltering()) return '';
  const past = pastDinners().filter((p) => state.byId.has(p.id));
  if (!past.length) return '';
  const rows = past.slice(0, state.lib.hadAll ? 99 : 4).map((p) => libRow(state.byId.get(p.id), `Had w/c ${esc(dateFmt.format(d(p.weekStart)))} · ${esc(agoTxt(p.weekStart))}`)).join('');
  return `<section class="had"><h3 class="had-h"><span aria-hidden="true">🍽️</span> Had before <span class="cat-n">${past.length}</span></h3>${rows}
    ${past.length > 4 && !state.lib.hadAll ? `<button class="more" data-act="had-all">Show all ${past.length}</button>` : ''}</section>`;
}
function renderLibrary() {
  const tags = libTags();
  const L = state.lib;
  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  return `<div class="lib-head"><h2 class="section-title">Library</h2><button class="add-recipe-btn" data-act="add-recipe">+ Add a recipe</button></div>
    <div class="filters">
      <input class="search" id="lib-q" type="search" placeholder="Search recipes or ingredients" value="${esc(L.q)}" autocomplete="off" enterkeyhint="search" aria-label="Search recipes or ingredients">
      <div class="filter-row" id="cat-btns">${catButtons()}</div>
    </div>
    <div id="cat-slot">${catPanel()}</div>
    <div class="filter-row tag-row">
      <select id="lib-tag" class="${L.tag ? 'on' : ''}" aria-label="Show">${opt('', 'All recipes', L.tag)}${opt('__had', 'Had before', L.tag)}${opt('__nk', 'Not for us', L.tag)}${state.index.some((r) => r.custom) ? opt('__own', 'Added by you', L.tag) : ''}${state.index.some((r) => r.source === 'sample') ? opt('__sample', 'Samples', L.tag) : ''}${tags.map(([t, n]) => opt(t, `${t} (${n})`, L.tag)).join('')}</select>
    </div>
    <div id="had-slot">${hadSection()}</div>
    <div id="nk-slot">${nkSection()}</div>
    <div id="lib-results">${libraryRows()}</div>`;
}

// ---------- Add a recipe (typed in, or from a link) ----------
const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'recipe';
const ingLine = (i) => [i.qty, i.unit, i.name].filter((x) => x != null && x !== '').join(' ');
function recipeForm(draft = {}) {
  const v = (x) => esc(x ?? '');
  return `<div class="content add-recipe">
    <div class="ar-top"><h2 id="sheet-title">Add a recipe</h2><button class="x" data-act="close" aria-label="Close">×</button></div>
    <form id="link-form" class="ar-link" autocomplete="off">
      <label for="ar-url">From a link</label>
      <p class="hint">Paste a recipe page. Most recipe sites publish the recipe in a standard format, and the board reads that. For your own use only.</p>
      <div class="add-form"><input id="ar-url" type="url" inputmode="url" placeholder="https://..." value="${v(draft.sourceUrl)}"><button type="submit">Fetch</button></div>
      <p class="ar-msg" id="ar-msg" role="status"></p>
    </form>
    <form id="recipe-form" class="ar-form" autocomplete="off">
      <p class="ar-or">${draft.title ? 'Check it over, then save.' : 'Or type it in'}</p>
      <label>Name <input name="title" required maxlength="120" value="${v(draft.title)}"></label>
      <div class="ar-two"><label>Total time (minutes) <input name="timeMins" type="number" min="1" max="600" inputmode="numeric" value="${v(draft.timeMins)}"></label>
        <label>Serves <input name="servings" type="number" min="1" max="12" inputmode="numeric" value="${v(draft.servings || state.config.servings || 2)}"></label></div>
      <label>Cuisine (optional) <input name="cuisine" maxlength="40" placeholder="e.g. Italian" value="${v(draft.cuisine)}"></label>
      <label>Ingredients, one per line <textarea name="ingredients" rows="7" required placeholder="200g penne&#10;1 onion&#10;2 tbsp olive oil">${esc((draft.ingredients || []).map(ingLine).join('\n'))}</textarea></label>
      <label>Method, one step per line <textarea name="steps" rows="7" placeholder="Boil the pasta.&#10;Fry the onion.">${esc((draft.steps || []).join('\n'))}</textarea></label>
      <label>Photo link (optional) <input name="image" type="url" placeholder="https://..." value="${v(draft.image)}"></label>
      <label class="ar-check"><input type="checkbox" name="slow"${(draft.categories || []).includes('slow-cooker') ? ' checked' : ''}> Slow cooker recipe</label>
      <input type="hidden" name="sourceUrl" value="${v(draft.sourceUrl)}"><input type="hidden" name="id" value="${v(draft.id)}"><input type="hidden" name="description" value="${v(draft.description)}">
      <button class="primary" type="submit">Save to the library</button>
    </form></div>`;
}
function openAddRecipe(draft) {
  sheet.innerHTML = recipeForm(draft);
  sheet.hidden = false; sheet.scrollTop = 0;
  document.body.classList.add('sheet-open');
}
async function fetchFromLink(url) {
  const msg = $('#ar-msg', sheet);
  msg.textContent = 'Reading the page…'; msg.className = 'ar-msg';
  try {
    const r = await fetch('/api/import', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.recipe) throw new Error(j.error || (r.status === 404 ? 'Importing needs the Cloudflare version of the board (see docs/SETUP.md).' : `Something went wrong (${r.status}).`));
    openAddRecipe(j.recipe);
    const m2 = $('#ar-msg', sheet); m2.textContent = `Found “${j.recipe.title}”. Check it over, then save.`; m2.className = 'ar-msg ok';
  } catch (e) { msg.textContent = e.message; msg.className = 'ar-msg err'; }
}
function saveRecipeForm(form) {
  const f = new FormData(form);
  const parse = shopMod.parseIngredient;
  const title = String(f.get('title') || '').trim();
  const ingredients = String(f.get('ingredients') || '').split('\n').map((s) => s.trim()).filter(Boolean).map((s) => { const p = parse(s); return { name: p.item, qty: p.qty, unit: p.unit === 'unit' ? null : p.unit }; });
  const steps = String(f.get('steps') || '').split('\n').map((s) => s.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
  if (!title || !ingredients.length) { toast('A name and at least one ingredient, please'); return; }
  const sourceUrl = String(f.get('sourceUrl') || '') || null;
  const id = String(f.get('id') || '') || `${sourceUrl ? 'web' : 'custom'}-${slug(title)}-${Math.random().toString(36).slice(2, 6)}`;
  const recipe = { id, title, source: sourceUrl ? 'web' : 'other', sourceUrl, addedBy: state.me, timeMins: +f.get('timeMins') || null, servings: +f.get('servings') || 2,
    cuisine: String(f.get('cuisine') || '').trim() || null, description: String(f.get('description') || '') || null, image: String(f.get('image') || '').trim() || null,
    ingredients, steps, categories: f.get('slow') ? ['slow-cooker'] : [] };
  sendOps([{ op: 'recipe-add', recipe }]);
  const r = shortlistMod.customToRecipe({ ...recipe, addedAt: new Date().toISOString() });
  state.index = [r, ...state.index.filter((x) => x.id !== r.id)];
  state.byId.set(r.id, r);
  toast(`Saved “${title}” to the library`);
  location.hash = recipeLink(r.id);
}

// ---------- Shopping ----------
// The list is built on the phone from the locked-in dinners (or, until then, the likely ones), merged and grouped by aisle.
async function fullRecipe(id) {
  const c = state.byId.get(id);
  if (c?.custom) return c;
  if (!state.full) state.full = new Map((await getJson('recipes.json')).map((r) => [r.id, r]));
  return state.full.get(id) || null;
}
async function shoppingFor() {
  const locked = rem()?.locked?.dinners;
  const rd = readiness();
  const ids = locked?.length ? locked : (rd?.dinners || []);
  const recipes = (await Promise.all(ids.map(fullRecipe))).filter(Boolean);
  return { locked: !!locked?.length, list: shopMod.buildShoppingList(recipes, { servings: state.config.servings, extras: rem()?.extras || [] }) };
}
const shopTitle = () => `Shopping list - week of ${dateFmt.format(d(state.week))}`;
function extrasHtml() {
  const extras = rem()?.extras || [];
  return extras.length ? `<div class="list">${extras.map((x) => `<div class="check ess-extra"><label><input type="checkbox" data-extra="${esc(x.id)}"${x.on ? ' checked' : ''}>
      <span class="t"><span class="name">${esc(x.text)}</span>${x.by ? `<div class="for">added by ${esc(personName(x.by))}</div>` : ''}</span></label>
      <button class="x" data-extra-rm="${esc(x.id)}" aria-label="Remove ${esc(x.text)}">×</button></div>`).join('')}</div>` : '';
}
async function shoppingBody() {
  const { locked, list } = await shoppingFor();
  const ticked = store.get('shop:' + state.week, {});
  const note = locked ? '' : list.meals.length ? '<p class="hint warn-note">Not locked in yet, so this list follows the current votes and may change.</p>' : '';
  if (!list.itemCount) return `${note}<div class="empty"><strong>Nothing on the list yet</strong>Vote for this week's dinners and the ingredients appear here.</div>`;
  const aisles = list.aisles.filter((a) => a.aisle !== 'Also buy').map((a) => `<section class="aisle"><h3 class="${a.aisle.startsWith('Cupboard') ? 'cupboard' : ''}">${esc(a.aisle)}</h3><div class="list">
      ${a.items.map((i) => `<label class="check"><input type="checkbox" data-shop="${esc(i.id)}"${ticked[i.id] ? ' checked' : ''}>
        <span class="t"><span class="name">${esc(i.item)}</span>${i.display ? ` <span class="amt">· ${esc(i.display)}</span>` : ''}
        ${i.recipes.length ? `<div class="for">for ${esc(i.recipes.join(', '))}</div>` : ''}
        ${i.flags.length && !a.aisle.startsWith('Cupboard') ? `<div class="flags">${i.flags.map((f) => `<span class="pill grey">${esc(f)}</span>`).join('')}</div>` : ''}
        </span></label>`).join('')}</div></section>`).join('');
  return `${note}<p class="section-sub">${list.meals.length} dinner${list.meals.length === 1 ? '' : 's'} · ${list.itemCount} items · grouped by aisle${state.config.servings ? ` · quantities for ${state.config.servings}` : ''}</p>
    <div class="export-row"><button class="export-btn" data-act="shop-copy">📋 Copy list</button>${navigator.share ? '<button class="export-btn" data-act="shop-share">📤 Share</button>' : ''}<button class="export-btn" data-act="shop-download">⬇️ Download</button></div>
    <div class="progress-row"><span id="shop-count"></span><button class="linkbtn" data-act="clear-shop">Clear ticks</button></div>
    <div class="progress"><i id="shop-bar"></i></div>
    ${aisles}`;
}
async function renderShopping() {
  return `<h2 class="section-title">Shopping</h2>
    <div id="shop-body">${await shoppingBody()}</div>
    <section class="aisle"><h3><span class="cat-icon" aria-hidden="true">✍️</span>Also buy</h3>
      <form class="add-form" id="extra-add" autocomplete="off"><input id="extra-add-text" type="text" maxlength="120" placeholder="e.g. milk, bin bags" enterkeyhint="done" aria-label="Add something else"><button type="submit">Add</button></form>
      <div id="extras-slot">${extrasHtml()}</div></section>
    <div class="sync-row" id="sync-slot">${syncNote()}</div>`;
}
async function shopText() { const { list } = await shoppingFor(); return shopMod.shoppingText(list, shopTitle()); }
async function exportShopping(how) {
  const text = await shopText();
  if (how === 'copy') {
    try { await navigator.clipboard.writeText(text); toast('Copied - paste it into a note, a message or your AI agent'); } catch { toast("Couldn't copy here - try Download"); }
  } else if (how === 'share') {
    try { await navigator.share({ title: shopTitle(), text }); } catch { /* cancelled */ }
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `shopping-${state.week}.txt`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
}
function updateShopProgress() {
  const boxes = [...view.querySelectorAll('[data-shop]')];
  if (!boxes.length || !$('#shop-count')) return;
  const n = boxes.filter((b) => b.checked).length;
  $('#shop-count').textContent = `${n} of ${boxes.length} in the basket`;
  $('#shop-bar').style.width = `${Math.round((n / boxes.length) * 100)}%`;
}

// ---------- recipe sheet ----------
let wakeLock = null;
async function setWake(on) {
  const btn = $('#wake', sheet), note = $('#wake-note', sheet);
  try {
    if (on) {
      if (!('wakeLock' in navigator)) throw new Error("This browser can't keep the screen awake.");
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { if (btn && !document.hidden) { btn.classList.remove('on'); btn.textContent = '☀️ Keep screen awake'; } });
    } else if (wakeLock) { await wakeLock.release(); wakeLock = null; }
    if (btn) { btn.classList.toggle('on', on); btn.textContent = on ? '☀️ Screen will stay awake' : '☀️ Keep screen awake'; }
    if (note) note.textContent = on ? 'Tap again to let it sleep.' : '';
  } catch (e) { if (note) note.textContent = e.message; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && $('#wake.on', sheet)) setWake(true); });

async function openRecipe(id) {
  if (!state.byId.get(id)?.custom && !state.full) { sheet.innerHTML = '<div class="empty">Loading recipe...</div>'; sheet.hidden = false; }
  const r = await fullRecipe(id);
  if (!r) { sheet.innerHTML = `<div class="empty"><strong>Recipe not found</strong><a href="#library">Back to the Library</a></div>`; sheet.hidden = false; return; }
  const ticks = store.get('ing:' + id, {});
  const done = store.get('step:' + id, {});
  const night = lockedMeals().find((c) => c.recipeId === id)?.night;
  sheet.innerHTML = `<div class="hero">${photo(r.image, 1200, 800, r.name) || placeholder(r, 'ph-hero')}<button class="back" data-act="close" aria-label="Back">‹</button></div>
    <div class="content">
      ${night ? `<span class="pill">${esc(longFmt.format(d(night)))}</span>` : ''}
      <h2 id="sheet-title">${esc(r.name)}</h2>${r.subtitle ? `<p class="subtitle">${esc(r.subtitle)}</p>` : ''}
      ${r.description ? `<p class="section-sub">${esc(r.description)}</p>` : ''}
      ${srcTag(r) ? `<p class="imported-note">${srcTag(r)}</p>` : ''}
      <div class="meta">${r.totalTimeMinutes ? `<span>⏱ ${mins(r.totalTimeMinutes)}</span>` : ''}<span>👥 Serves ${r.servings || 2}</span>${r.cuisine ? `<span>${esc(r.cuisine)}</span>` : ''}</div>
      <div id="sheet-add">${sheetAdd(id)}</div>
      <button class="wake" id="wake" data-act="wake">☀️ Keep screen awake</button><p class="wake-note" id="wake-note"></p>
      <h4>Ingredients <small>for ${r.servings || 2} · tap to tick</small></h4>
      <div class="list">${r.ingredients.map((i, n) => `<label class="check${i.check ? ' chk' : ''}"><input type="checkbox" data-ing="${n}"${ticks[n] ? ' checked' : ''}>
        <span class="t"><span class="name">${esc(i.item)}</span>${i.qty != null ? ` <span class="amt">· ${esc(fmtAmt(i))}</span>` : ''}${i.check ? ' <span class="chk-tag">- check</span>' : ''}
        ${i.notIncluded ? '<div class="for">from the cupboard</div>' : ''}</span></label>`).join('')}</div>
      ${r.notes ? `<p class="section-sub">${esc(r.notes)}</p>` : ''}
      <h4>Method <small>tap a step when done</small></h4>
      <ol class="steps">${(r.steps || []).map((s, n) => `<li data-step="${n}" class="${done[n] ? 'done' : ''}">${esc(s)}</li>`).join('')}</ol>
      <a class="source-alt" href="recipe/${esc(encodeURIComponent(r.id))}">Recipe page (for Safari's cooking view on HomeView)</a>
      ${r.url ? `<a class="source" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">Original recipe ↗</a>` : ''}
      ${r.custom ? `<button class="linkbtn danger" data-act="remove-recipe" data-id="${esc(r.id)}">Remove from the library</button>` : ''}
    </div>`;
  sheet.hidden = false;
  sheet.scrollTop = 0;
  document.body.classList.add('sheet-open');
  setRecipeLd(r);
}
function sheetAdd(id) {
  const had = hadBefore(id), warn = ruleWarn(id);
  const mine = state.me && dislikesOf(id).some((x) => x.by === state.me);
  const nkBtn = !state.me ? '' : mine ? `<p class="add-note">👎 ${esc(nkLabel(id))} · <button class="linkbtn nk-undo" data-undislike="${esc(id)}" data-by="${esc(state.me)}">undo</button></p>` : `<button class="nk-wide" data-nk-id="${esc(id)}">👎 Not for us</button>`;
  return `${addBtn(id, false)}${nkBtn}${had ? `<p class="add-note">Had before · w/c ${esc(dateFmt.format(d(had.weekStart)))} (${esc(agoTxt(had.weekStart))})</p>` : ''}${warn ? `<p class="add-note warn">${esc(warn)} - you can still add it.</p>` : ''}`;
}
function fmtAmt(i) {
  const q = Number.isInteger(i.qty) ? i.qty : Math.round(i.qty * 100) / 100;
  if (!i.unit || i.unit === 'unit') return String(q);
  if (i.unit === 'g' || i.unit === 'ml' || i.unit === 'kg') return `${q}${i.unit}`;
  return `${q} ${i.unit}${i.qty > 1 && !/s$/.test(i.unit) && !['tbsp', 'tsp', 'lb', 'oz'].includes(i.unit) ? 's' : ''}`;
}
// schema.org Recipe JSON-LD for the open recipe, so Safari's cooking view sees it inside the board too.
async function setRecipeLd(r) {
  document.getElementById('recipe-ld')?.remove();
  if (!r) return;
  try {
    const { recipeJsonLd, ldScriptText } = await import('./recipe-ld.js');
    if (sheet.hidden || decodeURIComponent(location.hash.slice(8)) !== r.id) return;
    const el = document.createElement('script');
    el.type = 'application/ld+json';
    el.id = 'recipe-ld';
    el.textContent = ldScriptText(recipeJsonLd(r, new URL('recipe/' + encodeURIComponent(r.id), location.href).href));
    document.getElementById('recipe-ld')?.remove();
    document.head.append(el);
  } catch (e) { console.warn('recipe JSON-LD', e); }
}
function closeRecipe() {
  setRecipeLd(null);
  if (wakeLock) setWake(false);
  sheet.hidden = true;
  sheet.innerHTML = '';
  document.body.classList.remove('sheet-open');
}

// ---------- Refresh just the live parts of the current tab (keeps text boxes and scroll position) ----------
async function refreshLive() {
  const tab = view.dataset.tab;
  const set = (id, html) => { const el = document.getElementById(id); if (el && el.innerHTML !== html) el.innerHTML = html; };
  set('sync-slot', syncNote());
  set('week-note-slot', weekBanner());
  set('lock-slot', lockCard());
  if (tab === 'week') set('meals-slot', weekMealsHtml());
  if (tab === 'vote') set('vote-sub', voteSub());
  if (tab === 'library') { set('had-slot', hadSection()); set('nk-slot', nkSection()); set('lib-results', libraryRows()); }
  if (tab === 'shopping') { set('extras-slot', extrasHtml()); const html = await shoppingBody(); if (view.dataset.tab === 'shopping') { set('shop-body', html); updateShopProgress(); } }
  if (!sheet.hidden && location.hash.startsWith('#recipe/')) { const h = sheetAdd(decodeURIComponent(location.hash.slice(8))); set('sheet-add', h); }
  if (tab === 'vote' && optionsOf().length) { set('who-slot', whoPicker('votes')); set('vote-tally', voteTally()); set('refresh-slot', refreshBar()); flipGrid(voteCards()); }
}

// ---------- shared state (/api/state) ----------
const API = '/api/state';
// This device's writer id: the server keeps one append-only log per device, so phones never overwrite each other.
const DEVICE = (() => { let x = store.get('device'); if (!/^d-[a-z0-9]{6,20}$/.test(x || '')) { x = 'd-' + Math.random().toString(36).slice(2, 12); store.set('device', x); } return x; })();
let queue = store.get('queue', []); // [{week, ops}] not yet saved
let flushing = false, retryTimer = null;
const setSync = (s) => { state.sync = s; const el = document.getElementById('sync-slot'); if (el) el.innerHTML = syncNote(); };
const blankRemote = (week) => ({ week, votes: {}, options: null, weekInfo: null, adjust: null, locked: null, extras: [], dislikes: [], history: [], updatedAt: null });

async function loadRemote(quiet) {
  const w = state.week;
  if (queue.length) { flush(); return; } // our own changes first, then the server's answer
  if (!quiet) setSync('loading');
  try {
    const r = await fetch(`${API}?week=${encodeURIComponent(w)}`, { cache: 'no-store', credentials: 'same-origin' });
    if (r.status === 401) return setSync('signin');
    if (!r.ok || !(r.headers.get('Content-Type') || '').includes('json')) {
      if (!state.remote || state.remote.week !== w) state.remote = store.get('remote:' + w, blankRemote(w));
      setSync('noapi'); refreshLive(); return;
    }
    const s = await r.json();
    if (state.week !== w) return;
    const changed = JSON.stringify(s) !== JSON.stringify(state.remote);
    state.remote = s; store.set('remote:' + w, s);
    setSync('synced');
    if (changed) refreshLive();
  } catch { if (!state.remote) state.remote = store.get('remote:' + w, blankRemote(w)); setSync('offline'); refreshLive(); }
}

// Mirror of the server's op handling, so taps show at once.
function applyLocal(s, op) {
  const now = new Date().toISOString();
  const blankOpts = () => ({ list: null, by: null, at: null, seen: [], history: [] });
  if (op.op === 'vote') { const v = new Set(s.votes[op.person] || []); op.on ? v.add(op.recipeId) : v.delete(op.recipeId); s.votes[op.person] = [...v]; }
  else if (op.op === 'options-set') {
    const o = s.options || blankOpts();
    s.options = { ...o, list: op.list, by: op.by, at: now, seen: [...new Set([...o.seen, ...op.seen, ...op.list])], history: [...o.history, { list: o.list, by: o.by, at: o.at }] };
  } else if (op.op === 'options-undo' && s.options?.history?.length) {
    const h = [...s.options.history], prev = h.pop();
    s.options = { ...s.options, list: prev.list, by: prev.by, at: prev.at, history: h };
  } else if (op.op === 'option-add') {
    const o = s.options || blankOpts();
    const list = o.list?.length ? o.list : op.base;
    const added = { ...(o.added || {}) };
    if (!list.includes(op.recipeId)) added[op.recipeId] = { by: op.by, at: now };
    s.options = { ...o, list: list.includes(op.recipeId) ? list : [...list, op.recipeId], added };
  } else if (op.op === 'option-remove' && s.options) {
    const added = { ...(s.options.added || {}) }; delete added[op.recipeId];
    s.options = { ...s.options, added, list: s.options.list ? s.options.list.filter((x) => x !== op.recipeId) : null };
  } else if (op.op === 'dislike') {
    s.dislikes = s.dislikes || [];
    if (!s.dislikes.some((x) => x.recipeId === op.recipeId && x.by === op.by)) s.dislikes.push({ recipeId: op.recipeId, by: op.by, at: now, reasons: [] });
    s.votes[op.by] = (s.votes[op.by] || []).filter((x) => x !== op.recipeId);
    if (op.remove) {
      const o = s.options || blankOpts();
      const added = { ...(o.added || {}) }; delete added[op.recipeId];
      let list = (o.list?.length ? o.list : op.base).filter((x) => x !== op.recipeId);
      if (op.replace && !list.includes(op.replace)) list = [...list, op.replace];
      s.options = { ...o, list, added, seen: [...new Set([...(o.seen || []), op.recipeId, ...(op.replace ? [op.replace] : [])])] };
    }
  } else if (op.op === 'dislike-reasons') {
    const x = (s.dislikes || []).find((y) => y.recipeId === op.recipeId && y.by === op.by); if (x) x.reasons = op.reasons;
  } else if (op.op === 'undislike') {
    s.dislikes = (s.dislikes || []).filter((y) => !(y.recipeId === op.recipeId && y.by === op.by));
    if (op.list && s.options) s.options = { ...s.options, list: op.list };
  } else if (op.op === 'week-adjust') s.adjust = { dinners: op.dinners, nights: op.nights, by: op.by, at: now };
  else if (op.op === 'week-adjust-reset') s.adjust = null;
  else if (op.op === 'lock') {
    s.locked = { at: now, by: op.by, dinners: op.dinners };
    s.history = [{ week: s.week, dinners: op.dinners, at: now }, ...(s.history || []).filter((h) => h.week !== s.week)];
  } else if (op.op === 'unlock') { s.locked = null; s.history = (s.history || []).filter((h) => h.week !== s.week); }
  else if (op.op === 'extra-add') { s.extras = s.extras || []; s.extras.push({ id: 'tmp' + Date.now(), text: op.text, on: true, by: op.by }); }
  else if (op.op === 'extra-tick') { const x = (s.extras || []).find((y) => y.id === op.id); if (x) x.on = !!op.on; }
  else if (op.op === 'extra-remove') s.extras = (s.extras || []).filter((y) => y.id !== op.id);
  s.updatedAt = now;
}

function sendOps(ops) {
  const w = state.week;
  if (!state.remote || state.remote.week !== w) state.remote = blankRemote(w);
  for (const op of ops) applyLocal(state.remote, op);
  store.set('remote:' + w, state.remote);
  refreshLive();
  if (state.sync === 'noapi') return;
  queue.push({ week: w, ops, by: state.me });
  store.set('queue', queue);
  flush();
}

async function flush() {
  if (flushing || !queue.length) return;
  flushing = true; clearTimeout(retryTimer); setSync('saving');
  try {
    while (queue.length) {
      // Everything queued for the same week goes in one request (at most 100 ops, the server's limit).
      let n = 0, count = 0;
      while (n < queue.length && queue[n].week === queue[0].week && (n === 0 || count + queue[n].ops.length <= 100)) count += queue[n++].ops.length;
      const batch = queue.slice(0, n);
      const q = { week: batch[0].week, by: batch.at(-1).by, writer: DEVICE, ops: batch.flatMap((x) => x.ops) };
      const r = await fetch(API, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
      if (r.status === 401) { setSync('signin'); return; }
      if (r.status >= 500 || r.status === 429) throw new Error('HTTP ' + r.status);
      queue.splice(0, n); store.set('queue', queue); // a 4xx means the change itself was bad: drop it rather than retry forever
      if (!r.ok) { const j = await r.json().catch(() => ({})); toast(`Couldn't save that: ${j.error || r.status}`); continue; }
      if (q.week === state.week && !queue.some((x) => x.week === q.week)) {
        const s = await r.json();
        delete s.recipes;
        state.remote = s; store.set('remote:' + q.week, s);
      }
    }
    setSync('synced'); refreshLive();
  } catch { setSync('offline'); retryTimer = setTimeout(flush, 8000); }
  finally { flushing = false; }
}

// ---------- routing ----------
let lastTab = 'week';
const TABS = ['week', 'vote', 'library', 'shopping'];
async function route() {
  const hash = location.hash.slice(1) || 'week';
  if (hash.startsWith('recipe/')) {
    try { await openRecipe(decodeURIComponent(hash.slice(7))); } catch (e) { showError(e); }
    if (view.innerHTML) return;
  } else if (hash === 'add-recipe') {
    openAddRecipe();
    if (view.innerHTML) return;
  } else closeRecipe();
  const tab = TABS.includes(hash) ? hash : lastTab;
  lastTab = tab;
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  const html = tab === 'week' ? renderWeek() : tab === 'vote' ? renderVote() : tab === 'library' ? renderLibrary() : await renderShopping();
  view.innerHTML = html;
  view.dataset.tab = tab;
  if (tab === 'shopping') updateShopProgress();
  loadRemote(!!state.remote);
  if (!hash.startsWith('recipe/') && hash !== 'add-recipe') window.scrollTo(0, 0);
}
function showError(e) {
  console.error(e);
  view.innerHTML = `<div class="empty"><strong>Couldn't load the board</strong>${esc(e.message)}</div>`;
}

// ---------- events ----------
let searchTimer;
view.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'lib-q') {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.lib.q = t.value; refreshLib({ buttons: false }); }, 120);
  }
});
view.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'lib-tag') { state.lib.tag = t.value; t.classList.toggle('on', !!t.value); refreshLib({ buttons: false }); }
  if (t.dataset.extra) { sendOps([{ op: 'extra-tick', id: t.dataset.extra, on: t.checked }]); return; }
  if (t.dataset.shop) {
    const k = 'shop:' + state.week, v = store.get(k, {});
    if (t.checked) v[t.dataset.shop] = 1; else delete v[t.dataset.shop];
    store.set(k, v); updateShopProgress();
  }
});
view.addEventListener('click', (e) => {
  const catb = e.target.closest('[data-cat]');
  if (catb) { e.preventDefault(); toggleCat(catb.dataset.cat); return; }
  const pnl = e.target.closest('[data-panel]');
  if (pnl) { e.preventDefault(); state.lib.open = state.lib.open === pnl.dataset.panel ? '' : pnl.dataset.panel; refreshLib(); return; }
  const who = e.target.closest('[data-who]')?.dataset.who;
  if (who) { state.me = who; store.set('me', who); refreshLive(); return; }
  const add = e.target.closest('[data-add]');
  if (add) { e.preventDefault(); addToWeek(add.dataset.add); return; }
  const nkb = e.target.closest('[data-nk-id]');
  if (nkb) { e.preventDefault(); notForUs(nkb.dataset.nkId); return; }
  const und = e.target.closest('[data-undislike]');
  if (und) { e.preventDefault(); sendOps([{ op: 'undislike', recipeId: und.dataset.undislike, by: und.dataset.by }]); return; }
  const rmAdd = e.target.closest('[data-rm-add]');
  if (rmAdd) { e.preventDefault(); sendOps([{ op: 'option-remove', recipeId: rmAdd.dataset.rmAdd }]); return; }
  const vote = e.target.closest('[data-vote]');
  if (vote) {
    e.preventDefault();
    if (!state.me) return;
    const on = !votesFor(state.me).has(vote.dataset.vote);
    const k = shownVotes(state.me).length, n = picksLimit();
    if (on && k >= n) { toast(k === n ? `You've picked ${n} - untick one first` : `Only ${n} dinners this week - untick ${k - n + 1} first`); return; }
    sendOps([...ensureList(), { op: 'vote', person: state.me, recipeId: vote.dataset.vote, on }]);
    return;
  }
  const rm = e.target.closest('[data-extra-rm]');
  if (rm) { sendOps([{ op: 'extra-remove', id: rm.dataset.extraRm }]); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'refresh') { refreshOptions(); return; }
  if (act === 'lock') { const rd = readiness(); if (rd?.ok && state.me) sendOps([...ensureList(), { op: 'lock', by: state.me, dinners: rd.dinners }]); return; }
  if (act === 'unlock') { sendOps([{ op: 'unlock' }]); return; }
  if (act === 'nk-all') { state.lib.nkAll = true; refreshLive(); return; }
  if (act === 'had-all') { state.lib.hadAll = true; refreshLive(); return; }
  if (act === 'dinners-plus' || act === 'dinners-minus') { adjustDinners(act === 'dinners-plus' ? 1 : -1); return; }
  if (act === 'dinners-reset') { sendOps([{ op: 'week-adjust-reset' }]); return; }
  if (act === 'refresh-undo') { state.refreshMsg = ''; sendOps([{ op: 'options-undo' }]); return; }
  if (act === 'who-change') { state.me = null; store.set('me', null); refreshLive(); return; }
  if (act === 'cats-clear') { state.lib.cats = []; refreshLib(); return; }
  if (act === 'add-recipe') { location.hash = 'add-recipe'; return; }
  if (act === 'more') { state.lib.limit += 40; $('#lib-results').innerHTML = libraryRows(); }
  if (act === 'clear-shop') { store.set('shop:' + state.week, {}); view.querySelectorAll('[data-shop]').forEach((b) => (b.checked = false)); updateShopProgress(); }
  if (act === 'shop-copy') exportShopping('copy');
  if (act === 'shop-share') exportShopping('share');
  if (act === 'shop-download') exportShopping('download');
});
sheet.addEventListener('click', (e) => {
  const add = e.target.closest('[data-add]');
  if (add) { addToWeek(add.dataset.add); return; }
  const nkb = e.target.closest('[data-nk-id]');
  if (nkb) { notForUs(nkb.dataset.nkId); return; }
  const und = e.target.closest('[data-undislike]');
  if (und) { sendOps([{ op: 'undislike', recipeId: und.dataset.undislike, by: und.dataset.by }]); return; }
  const actEl = e.target.closest('[data-act]'), act = actEl?.dataset.act;
  if (act === 'close') { location.hash = lastTab; return; }
  if (act === 'wake') { setWake(!$('#wake', sheet).classList.contains('on')); return; }
  if (act === 'remove-recipe') {
    const id = actEl.dataset.id;
    if (!confirm('Remove this recipe from the library? Everyone will stop seeing it.')) return;
    sendOps([{ op: 'recipe-remove', id }]);
    state.index = state.index.filter((r) => r.id !== id); state.byId.delete(id);
    toast('Removed from the library'); location.hash = 'library'; return;
  }
  const li = e.target.closest('[data-step]');
  if (li) {
    const id = decodeURIComponent(location.hash.slice(8)), k = 'step:' + id, v = store.get(k, {});
    li.classList.toggle('done');
    if (li.classList.contains('done')) v[li.dataset.step] = 1; else delete v[li.dataset.step];
    store.set(k, v);
  }
});
sheet.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.ing != null) {
    const id = decodeURIComponent(location.hash.slice(8)), k = 'ing:' + id, v = store.get(k, {});
    if (t.checked) v[t.dataset.ing] = 1; else delete v[t.dataset.ing];
    store.set(k, v);
  }
});
sheet.addEventListener('submit', (e) => {
  e.preventDefault();
  if (e.target.id === 'link-form') { const u = $('#ar-url', sheet).value.trim(); if (u) fetchFromLink(u); }
  if (e.target.id === 'recipe-form') saveRecipeForm(e.target);
});
view.addEventListener('submit', (e) => {
  if (e.target.id !== 'extra-add') return;
  e.preventDefault();
  const input = $('#extra-add-text'), text = input.value.replace(/\s+/g, ' ').trim();
  if (!text) return;
  sendOps([{ op: 'extra-add', text, by: state.me }]);
  input.value = '';
});
// Keep phones in step: re-read the shared state when the app comes back and every 20 s while open.
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadRemote(true); });
setInterval(() => { if (!document.hidden) loadRemote(true); }, 20000);
window.addEventListener('online', flush);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) location.hash = lastTab; });
$('#week-select').addEventListener('change', (e) => {
  state.week = e.target.value;
  state.remote = null;
  setHeader(); route();
});
window.addEventListener('hashchange', route);

// ---------- boot ----------
(async function boot() {
  try {
    [shortlistMod, catMod, shopMod] = await Promise.all([import('./shortlist.js'), import('./categories.js'), import('./shopping.js')]);
    const [config, index] = await Promise.all([getJson('config.json'), getJson('recipes-index.json')]);
    state.config = config;
    state.people = config.people || [];
    state.rules = shortlistMod.rulesFrom(config);
    if (config.title) { document.title = config.title; $('#app-title').textContent = config.title; }
    state.me = state.people.some((p) => p.id === store.get('me')) ? store.get('me') : (state.people.length === 1 ? state.people[0].id : null);
    // Your own recipes (typed in, from a link, or added by an agent) from /api/state.
    const custom = await fetch('/api/state?recipes=1', { credentials: 'same-origin', cache: 'no-store' })
      .then((r) => (r.ok && (r.headers.get('Content-Type') || '').includes('json') ? r.json() : { recipes: [] })).catch(() => ({ recipes: [] }));
    const own = (custom.recipes || []).map(shortlistMod.customToRecipe);
    state.index = [...own.filter((r) => !index.some((x) => x.id === r.id)), ...index];
    state.byId = new Map(state.index.map((r) => [r.id, r]));
    state.week = thisWeek();
    setHeader();
    state.remote = null;
    await loadRemote(false);
    await route();
    document.documentElement.dataset.ready = '1';
    if (queue.length) flush();
  } catch (e) { showError(e); document.documentElement.dataset.ready = 'error'; }
})();
