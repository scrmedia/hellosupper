// Supper Board shortlist rules: one place for "what goes on the weekly vote". Shared by the board (the first list of
// the week, "Show me more" and "Not for us") and by scripts/board.mjs. ES module, no dependencies apart from categories.js.
// The rules come from data/config.json ("rules"), so you can change them without touching code:
//   "rules": { "maxMinutes": 45, "exclude": ["fish"], "maxSameProtein": 3, "maxSlowCooker": 1 }
//   exclude = Library category ids (site/categories.js) that are never suggested, e.g. "fish", "pork", "over-60".
//   Anything can still be added by hand from the Library - the board just shows a warning.
import { categorize, ingredientText, categoryLabel } from './categories.js';

export const DEFAULT_RULES = { count: 10, maxMinutes: null, exclude: [], maxSameProtein: null, maxSlowCooker: 2, recentWeeks: 3 };
export const rulesFrom = (config = {}) => ({ ...DEFAULT_RULES, count: config.optionsPerWeek || DEFAULT_RULES.count, ...(config.rules || {}) });

const PROTEIN_IDS = ['chicken', 'beef', 'pork', 'lamb', 'turkey', 'duck', 'fish', 'veggie'];
const catsOf = (r) => r.cats || (r.cats = categorize(r));

// One recipe against the rules -> { ok, why[], minutes, slow, protein }
export function classify(r, rules = DEFAULT_RULES) {
  const cats = catsOf(r);
  const minutes = r.totalTimeMinutes || null;
  const slow = cats.includes('slow-cooker');
  const why = [];
  for (const id of rules.exclude || []) if (cats.includes(id)) why.push(categoryLabel(id).toLowerCase());
  // Slow-cooker recipes take hours but almost no hands-on time, so the time limit doesn't apply to them.
  if (rules.maxMinutes && !slow && minutes > rules.maxMinutes) why.push(`${minutes} min`);
  const protein = PROTEIN_IDS.find((p) => cats.includes(p)) || 'other';
  return { ok: why.length === 0, why, minutes, slow, protein };
}

const normName = (s) => String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').replace(/\b(quick|easy|the|with|and|a)\b/g, ' ').replace(/\s+/g, ' ').trim();

// Seeded random numbers (mulberry32), so every phone builds the same first list for a week.
export function rng(seed = Date.now()) {
  let a = typeof seed === 'string' ? [...seed].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261) : seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Fill a list up to rules.count.
//   library: recipes (full, or index rows); keep: ids that must stay (voted / added); seen: ids not to bring back this week;
//   recent: ids picked in the last few weeks (avoided if possible); dislikes: [{recipeId, by, reasons}]; random: () => [0,1)
// Returns { options, added, relaxed } - options sorted quickest first.
export function fill({ library, keep = [], seen = [], recent = [], dislikes = [], random = Math.random, rules = DEFAULT_RULES }) {
  const count = Math.max(rules.count, keep.length);
  const disliked = new Set(dislikes.map((x) => x.recipeId));
  const pen = dislikePatterns(dislikes, library, rules);
  const byId = new Map(library.map((r) => [r.id, r]));
  const chosen = keep.map((id) => byId.get(id)).filter(Boolean);
  const names = new Set(chosen.map((r) => normName(r.name)));
  const seenSet = new Set([...seen, ...keep]);
  const recentSet = new Set(recent);
  // Weighted random order: every refresh differs; a protein or cuisine someone keeps saying no to comes up less often.
  const ranked = library.filter((r) => classify(r, rules).ok && !seenSet.has(r.id) && !disliked.has(r.id))
    .map((r) => ({ r, k: Math.pow(random(), 1 / penaltyFor(r, pen, rules)) }))
    .sort((a, b) => b.k - a.k).map((x) => x.r);
  const relaxed = [];
  const tally = { slow: 0, protein: {} };
  for (const r of chosen) { const f = classify(r, rules); if (f.slow) tally.slow++; tally.protein[f.protein] = (tally.protein[f.protein] || 0) + 1; }
  const fits = (r, strict) => {
    const f = classify(r, rules);
    if (names.has(normName(r.name))) return false;
    if (!strict) return true;
    if (f.slow && rules.maxSlowCooker != null && tally.slow >= rules.maxSlowCooker) return false;
    if (rules.maxSameProtein && f.protein !== 'other' && (tally.protein[f.protein] || 0) >= rules.maxSameProtein) return false;
    return true;
  };
  const added = [];
  const pass = (ok, strict) => {
    for (const r of ranked) {
      if (chosen.length >= count) return;
      if (added.includes(r) || !ok(r) || !fits(r, strict)) continue;
      const f = classify(r, rules);
      chosen.push(r); added.push(r); names.add(normName(r.name));
      if (f.slow) tally.slow++;
      tally.protein[f.protein] = (tally.protein[f.protein] || 0) + 1;
    }
  };
  pass((r) => !recentSet.has(r.id), true);
  if (chosen.length < count) { pass(() => true, true); if (added.some((r) => recentSet.has(r.id))) relaxed.push('allowed recent dinners'); }
  if (chosen.length < count) { pass(() => true, false); relaxed.push('ignored the variety limits'); }
  const options = [...chosen].sort((a, b) => (classify(a, rules).slow - classify(b, rules).slow) || ((a.totalTimeMinutes || 999) - (b.totalTimeMinutes || 999))).map((r) => r.id);
  return { options, added: added.map((r) => r.id), relaxed };
}

// ---- "Not for us" learning ----
// 2+ "Ingredient" dislikes from the same person sharing a main protein or cuisine -> that protein / cuisine comes up less often.
export const REASON_LABELS = { ingredient: 'Ingredient', spicy: 'Too spicy', fiddly: 'Too fiddly', notkeen: 'Just not keen' };
export const PENALTY = { minDislikes: 2, factor: 0.35 };
export function dislikePatterns(dislikes, library, rules = DEFAULT_RULES) {
  const byId = new Map(library.map((r) => [r.id, r]));
  const out = {};
  for (const x of dislikes) {
    if (!(x.reasons || []).includes('ingredient')) continue;
    const r = byId.get(x.recipeId);
    if (!r) continue;
    const p = (out[x.by] ||= { protein: {}, cuisine: {} });
    const f = classify(r, rules);
    if (!['veggie', 'other'].includes(f.protein)) p.protein[f.protein] = (p.protein[f.protein] || 0) + 1;
    if (r.cuisine) p.cuisine[r.cuisine] = (p.cuisine[r.cuisine] || 0) + 1;
  }
  for (const p of Object.values(out)) for (const k of ['protein', 'cuisine'])
    p[k] = Object.fromEntries(Object.entries(p[k]).filter(([, n]) => n >= PENALTY.minDislikes));
  return out;
}
export function penaltyFor(r, patterns, rules = DEFAULT_RULES) {
  let w = 1;
  const f = classify(r, rules);
  for (const p of Object.values(patterns || {})) {
    if (p.protein[f.protein]) w *= PENALTY.factor;
    if (r.cuisine && p.cuisine[r.cuisine]) w *= PENALTY.factor;
  }
  return Math.max(w, 0.05);
}
// A summary per person, for an agent to read out ("not keen on: X, Y").
export function dislikeSummary(dislikes, library, rules = DEFAULT_RULES) {
  const byId = new Map(library.map((r) => [r.id, r]));
  const pats = dislikePatterns(dislikes, library, rules);
  const people = {};
  for (const x of dislikes) {
    const p = (people[x.by] ||= { count: 0, reasons: {}, recipes: [] });
    p.count++;
    for (const r of x.reasons || []) p.reasons[r] = (p.reasons[r] || 0) + 1;
    p.recipes.push(byId.get(x.recipeId)?.name || x.recipeId);
  }
  for (const [who, p] of Object.entries(people)) p.patterns = [...Object.keys(pats[who]?.protein || {}), ...Object.keys(pats[who]?.cuisine || {})];
  return people;
}

// The options shown for a week: the stored list plus anything added from the Library (pinned through refreshes and Undo).
export function effectiveOptions(remote) {
  const base = remote?.options?.list || [];
  const added = Object.keys(remote?.options?.added || {});
  return [...base, ...added.filter((id) => !base.includes(id))];
}

// ---- Are this week's dinners settled? ----
// Settled = everyone has picked exactly n, and the top n by votes (picked by most people first, then list order) has no tie
// at the cut-off. Returns { ok, dinners (the likely n), missing: [reasons], tie: {votes, places, between} }.
export function settle({ options, votes, people, n }) {
  const shown = new Set(options);
  const missing = [];
  for (const p of people) {
    const k = (votes[p.id] || []).filter((id) => shown.has(id)).length;
    if (k < n) missing.push(`${p.name}: ${k} of ${n} picked`);
    if (k > n) missing.push(`${p.name}: ${k} of ${n} - untick ${k - n}`);
  }
  const ranked = options.map((id, pos) => ({ id, pos, who: people.filter((p) => (votes[p.id] || []).includes(id)).map((p) => p.id) }))
    .filter((x) => x.who.length).sort((a, b) => b.who.length - a.who.length || a.pos - b.pos);
  const likely = ranked.slice(0, n);
  const cut = likely.length === n ? likely[n - 1].who.length : null;
  const tiedAll = cut != null ? ranked.filter((x) => x.who.length === cut) : [];
  const places = likely.filter((x) => x.who.length === cut).length;
  const tie = tiedAll.length > places ? { votes: cut, places, between: tiedAll.map((x) => x.id) } : null;
  if (likely.length < n && !missing.length) missing.push(`only ${likely.length} of ${n} dinners have a vote`);
  return { ok: !missing.length && !tie, dinners: likely.map((x) => x.id), ranked, missing, tie };
}

// ---- Your own recipes (stored through /api/state recipe-add) -> the library's recipe shape ----
export function customToRecipe(r) {
  const out = {
    id: r.id, name: r.title, subtitle: '', description: r.description || '', image: r.image || null, thumbnail: r.image || null,
    totalTimeMinutes: r.timeMins || null, cuisine: r.cuisine || null, tags: r.tags || [], calories: null, source: r.source || 'other',
    custom: true, addedBy: r.addedBy || null, addedAt: r.addedAt || null, url: r.sourceUrl || null, servings: r.servings || 2,
    steps: r.steps || [], flags: r.flags || [], notes: r.notes || null, allergens: [], categories: r.categories || [],
    ingredients: (r.ingredients || []).map((i) => ({ raw: [i.qty, i.unit, i.name].filter((x) => x != null && x !== '').join(' '), qty: i.qty ?? null, unit: i.unit || null, item: i.name, ...(i.check && { check: true }) })),
  };
  out.cats = categorize(out);
  out.q = ingredientText(out);
  return out;
}
