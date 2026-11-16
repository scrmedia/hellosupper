// The /recipe/<id> page (Safari's cooking view on Apple HomeView, and anything else that reads recipe data): plain HTML
// with schema.org Recipe JSON-LD in the markup itself, no JavaScript. ES module, no dependencies. Used by
// scripts/sync-site.mjs (static pages for the recipes in data/recipes.json) and by functions/recipe/[id].js (recipes you
// add on the board, rendered from KV on request), so every recipe gets the same page.
import { recipeJsonLd, ldScriptText, ingredientLine } from './recipe-ld.js';

const SOURCE_NAMES = { web: 'the original site', other: 'the original site' };
export const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const isId = (id) => /^[A-Za-z0-9-]+$/.test(id);

// CSP for the page: no scripts at all; photos from this site, or the recipe's own https image.
export function recipeCsp(r) {
  let host = '';
  try { const o = r?.image && new URL(r.image).origin; if (o && o.startsWith('https://')) host = ' ' + o; } catch { /* no image */ }
  return `default-src 'none'; img-src 'self'${host}; style-src 'self'; base-uri 'none'; form-action 'none'`;
}

// Why a recipe can't get a page ('' = it can).
export const pageProblem = (r) => (!isId(String(r.id)) ? 'id not URL-safe' : !r.name ? 'no name' : !r.ingredients?.length ? 'no ingredients' : !r.steps?.length ? 'no steps' : '');

// r is a library-shaped recipe (recipes.json, or customToRecipe() for added ones). origin = the site's address, e.g.
// https://dinners.example.com (data/config.json "siteUrl" for static pages, the request's own address for added recipes).
export function recipePage(r, origin = '') {
  const ld = recipeJsonLd(r, origin ? `${origin.replace(/\/$/, '')}/recipe/${r.id}` : undefined);
  const meta = [r.totalTimeMinutes && `⏱ ${r.totalTimeMinutes} min`, r.servings && `👥 Serves ${r.servings}`, r.calories && `🔥 ${r.calories} kcal each`, r.cuisine].filter(Boolean);
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${recipeCsp(r)}">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#fbf6ef">
<title>${h(r.name)} · Supper Board</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/recipe.css">
<script type="application/ld+json">${ldScriptText(ld)}</script>
</head>
<body>
<main class="recipe">
<p class="back"><a href="/#recipe/${h(encodeURIComponent(r.id))}">‹ Open in Supper Board</a></p>
${ld.image ? `<img class="hero" src="${h(r.image)}" alt="${h(r.name)}" width="1200" height="800" referrerpolicy="no-referrer">` : r.emoji ? `<div class="hero-emoji" aria-hidden="true">${h(r.emoji)}</div>` : ''}
<h1>${h(r.name)}</h1>
${r.subtitle ? `<p class="subtitle">${h(r.subtitle)}</p>` : ''}
${meta.length ? `<p class="meta">${meta.map((m) => `<span>${h(m)}</span>`).join('')}</p>` : ''}
${r.description ? `<p class="desc">${h(r.description)}</p>` : ''}
<h2>Ingredients <small>for ${h(r.servings || 2)}</small></h2>
<ul class="ingredients">
${(r.ingredients || []).map((i) => `<li>${h(ingredientLine(i))}${i.notIncluded ? ' <small>from the cupboard</small>' : ''}${i.check ? ' <small>- check</small>' : ''}</li>`).join('\n')}
</ul>
<h2>Method</h2>
<ol class="steps">
${(r.steps || []).map((s) => `<li>${h(s)}</li>`).join('\n')}
</ol>
${r.allergens?.length ? `<p class="note">Allergens: ${h(r.allergens.join(', '))}</p>` : ''}${r.custom && r.notes ? `\n<p class="note">${h(r.notes)}</p>` : ''}
${r.url ? `<p class="note"><a href="${h(r.url)}" rel="noopener noreferrer">Original recipe on ${h(SOURCE_NAMES[r.source] || 'the original site')} ↗</a></p>` : ''}
</main>
</body>
</html>
`;
}

// What Safari's cooking view on HomeView needs, from the JSON-LD we'd emit. Returns a list of missing/weak fields.
export function homeviewGaps(r) {
  const ld = recipeJsonLd(r);
  const gaps = [];
  if (!ld.name) gaps.push('name');
  if (!ld.image) gaps.push('image (no photo on the cooking view)');
  if (!ld.prepTime && !ld.totalTime) gaps.push('prepTime/totalTime (timeMins)');
  if (!ld.recipeYield) gaps.push('recipeYield (servings)');
  if (!ld.recipeIngredient?.length) gaps.push('recipeIngredient');
  if (!ld.recipeInstructions?.length) gaps.push('recipeInstructions');
  else if (ld.recipeInstructions.length < 2) gaps.push('recipeInstructions is a single step - split the method into separate steps');
  return gaps;
}
