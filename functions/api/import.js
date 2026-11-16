// "Add a recipe from a link": fetch one recipe page the user pasted, read its schema.org Recipe JSON-LD (the same data
// search engines and Safari's cooking view use) and hand back a draft recipe. Nothing is saved here - the board shows
// the draft, and saving it is a normal "recipe-add" op on /api/state.
//   POST /api/import  {"url":"https://example.com/some-recipe"}  -> {recipe: {...}} or {error}
// Runs behind functions/_middleware.js, so only signed-in devices can use it. For personal use: it fetches one page
// when you ask, the same as opening it in a browser. It doesn't crawl, and it doesn't copy photos (it keeps the link).
import { parseIngredient } from '../../site/shopping.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
const MAX_BYTES = 3_000_000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", deg: '°', frac12: '½', frac14: '¼', frac34: '¾' };
const decode = (s) => String(s ?? '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENTITIES[e.toLowerCase()] ?? m;
  })
  .replace(/\s+/g, ' ').trim();

// Pull every JSON-LD block out of the page and find the first thing typed Recipe (top level, in an array, or in @graph).
export function findRecipe(html) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const isRecipe = (x) => x && typeof x === 'object' && [].concat(x['@type'] || []).some((t) => String(t).toLowerCase() === 'recipe');
  const walk = (x) => {
    if (!x || typeof x !== 'object') return null;
    if (Array.isArray(x)) { for (const y of x) { const r = walk(y); if (r) return r; } return null; }
    if (isRecipe(x)) return x;
    return walk(x['@graph']) || walk(x.mainEntity) || null;
  };
  for (const b of blocks) {
    try { const r = walk(JSON.parse(b.trim())); if (r) return r; } catch { /* broken block - try the next */ }
  }
  return null;
}

// "PT1H30M" -> 90
export function isoMinutes(s) {
  const m = /^P(?:\d+D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?/i.exec(String(s || '').trim());
  if (!m) return null;
  const n = Math.round((+(m[1] || 0)) * 60 + +(m[2] || 0));
  return n > 0 ? n : null;
}

const imageOf = (img) => {
  const first = Array.isArray(img) ? img[0] : img;
  const u = typeof first === 'string' ? first : first?.url || first?.contentUrl;
  return typeof u === 'string' && /^https:\/\//.test(u) ? u : null;
};

function stepsOf(ins) {
  const out = [];
  const add = (x) => {
    if (!x) return;
    if (typeof x === 'string') { decode(x).split(/\n+|(?<=\.)\s+(?=\d+\.\s)/).map((s) => s.replace(/^\d+[.)]\s*/, '').trim()).filter(Boolean).forEach((s) => out.push(s)); return; }
    if (Array.isArray(x)) { x.forEach(add); return; }
    if (x.itemListElement) { add(x.itemListElement); return; } // HowToSection
    if (x.text || x.name) out.push(decode(x.text || x.name));
  };
  add(ins);
  return out.filter(Boolean).slice(0, 40);
}

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'recipe';

// The JSON-LD Recipe -> the board's recipe shape (the same one /api/state's recipe-add takes).
export function toDraft(ld, pageUrl) {
  const title = decode(ld.name).slice(0, 120);
  const total = isoMinutes(ld.totalTime) || ((isoMinutes(ld.prepTime) || 0) + (isoMinutes(ld.cookTime) || 0)) || null;
  const yieldTxt = [].concat(ld.recipeYield || []).map(String).join(' ');
  const servings = parseInt((/\d+/.exec(yieldTxt) || [])[0], 10) || 2;
  const ingredients = [].concat(ld.recipeIngredient || ld.ingredients || []).map((s) => {
    const p = parseIngredient(decode(s));
    return { name: p.item, qty: p.qty, unit: p.unit === 'unit' ? null : p.unit };
  }).filter((i) => i.name);
  const cuisine = decode([].concat(ld.recipeCuisine || [])[0] || '') || null;
  const host = (() => { try { return new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { return 'web'; } })();
  return {
    id: `web-${slug(host.split('.')[0])}-${slug(title)}`.slice(0, 64),
    title, source: 'web', sourceUrl: pageUrl, image: imageOf(ld.image), timeMins: total, servings,
    description: decode(ld.description).slice(0, 300) || null, cuisine, ingredients, steps: stepsOf(ld.recipeInstructions),
    tags: [], flags: [], categories: [],
  };
}

// Only public http(s) pages: no credentials in the URL, no local or private addresses.
function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h) || h.includes(':') || !h.includes('.')) return null;
  return u;
}

export async function onRequestPost({ request }) {
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'JSON only' }, 415);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad JSON' }, 400); }
  const u = checkUrl(body?.url);
  if (!u) return json({ error: "That doesn't look like a web address. Paste the full link, starting https://" }, 400);
  let res;
  try {
    res = await fetch(u.href, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SupperBoard/1.0; personal recipe import)', Accept: 'text/html,application/xhtml+xml' },
    });
  } catch { return json({ error: "Couldn't reach that page. Check the link and try again." }, 502); }
  if (!res.ok) return json({ error: `That page answered with an error (${res.status}). Some sites block automatic reading - you can type the recipe in instead.` }, 502);
  const text = (await res.text()).slice(0, MAX_BYTES);
  const ld = findRecipe(text);
  if (!ld) return json({ error: "No recipe data found on that page. Not every site publishes it - you can type the recipe in instead." }, 422);
  const recipe = toDraft(ld, res.url || u.href);
  if (!recipe.title || !recipe.ingredients.length) return json({ error: 'The recipe on that page has no name or no ingredients.' }, 422);
  return json({ recipe });
}
