// schema.org Recipe JSON-LD for a HelloSupper recipe - what Safari on Apple HomeView reads to build its step-by-step
// cooking view (https://webkit.org/blog/18608/safari-on-apple-homeview/). ES module, no dependencies: used by
// scripts/sync-site.mjs (static /recipe/<id> pages), site/recipe-page.js and app.js (the open recipe sheet).
// Only fields we actually have are emitted; nothing is made up (no cookTime unless it's in the data, no ratings, etc).
import { categorize, categoryLabel } from './categories.js';

// "12g", "2 tbsps", "1" - same wording as the board's ingredient list.
export function fmtAmt(i) {
  const q = Number.isInteger(i.qty) ? i.qty : Math.round(i.qty * 100) / 100;
  if (!i.unit || i.unit === 'unit') return String(q);
  if (i.unit === 'g' || i.unit === 'ml' || i.unit === 'kg') return `${q}${i.unit}`;
  return `${q} ${i.unit}${i.qty > 1 && !/s$/.test(i.unit) && !['tbsp', 'tsp', 'lb', 'oz'].includes(i.unit) ? 's' : ''}`;
}

export const ingredientLine = (i) => (i.qty != null ? `${fmtAmt(i)} ${i.item}` : String(i.item || i.raw || '')).trim();

// 95 -> "PT1H35M"
export function isoDuration(minutes) {
  const m = Math.round(Number(minutes));
  if (!m || m < 0) return undefined;
  const h = Math.floor(m / 60), r = m % 60;
  return `PT${h ? h + 'H' : ''}${r || !h ? r + 'M' : ''}`;
}

const okUrl = (u) => typeof u === 'string' && /^https:\/\//.test(u);

export function recipeJsonLd(r, pageUrl) {
  const ld = { '@context': 'https://schema.org', '@type': 'Recipe', name: r.name };
  if (okUrl(r.image)) ld.image = r.image;
  if (r.description || r.subtitle) ld.description = r.description || r.subtitle;
  if (okUrl(pageUrl)) ld.url = pageUrl;
  const prep = isoDuration(r.prepTimeMinutes), total = isoDuration(r.totalTimeMinutes);
  if (prep) ld.prepTime = prep;
  if (total) ld.totalTime = total;
  if (r.servings) ld.recipeYield = `${r.servings} servings`;
  if (r.cuisine) ld.recipeCuisine = r.cuisine;
  ld.recipeCategory = 'Dinner';
  const cats = r.cats || categorize(r); // Library categories (site/categories.js), e.g. "Chinese, Under 20 min, Chicken"
  if (cats.length) ld.keywords = cats.map(categoryLabel).join(', ');
  if (r.calories) ld.nutrition = { '@type': 'NutritionInformation', calories: `${r.calories} kcal` };
  ld.recipeIngredient = (r.ingredients || []).map(ingredientLine).filter(Boolean);
  ld.recipeInstructions = (r.steps || []).map((s) => String(s).trim()).filter(Boolean).map((text) => ({ '@type': 'HowToStep', text }));
  if (okUrl(r.url)) ld.isBasedOn = r.url;
  return ld;
}

// JSON for inside <script type="application/ld+json">: "<" escaped so a recipe can never close the script element.
export const ldScriptText = (ld) => JSON.stringify(ld).replace(/</g, '\\u003c');
