#!/usr/bin/env node
// Build the app's data from data/: copies data/config.json, tidies data/recipes.json into site/data/recipes.json, writes a
// small library index (site/data/recipes-index.json) for a fast first load, and writes one static page per recipe at
// site/recipe/<id>.html (served as /recipe/<id>) with schema.org Recipe JSON-LD for Safari's cooking view on HomeView.
//   node scripts/sync-site.mjs
// Run it after editing anything in data/, then deploy. Recipes added on the board live in KV and need no sync.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recipePage, pageProblem } from '../site/recipe-page.js';
import { categorize, ingredientText, CATEGORIES } from '../site/categories.js';
import { parseIngredient } from '../site/shopping.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data');
const DEST = path.join(ROOT, 'site', 'data');
const PAGES = path.join(ROOT, 'site', 'recipe');
const read = async (f) => JSON.parse(await fs.readFile(path.join(SRC, f), 'utf8'));

const config = await read('config.json');
const people = config.people || [];
if (!people.length || people.some((p) => !/^[a-z][a-z0-9-]{0,23}$/.test(p.id || '') || !p.name)) {
  console.error('data/config.json: "people" needs at least one entry like {"id": "alex", "name": "Alex"} (id: lower-case letters, numbers and -)');
  process.exit(1);
}

// Cupboard basics you'd normally already have: shown as "from the cupboard" and flagged on the shopping list.
const BASICS = /^(salt|black pepper|pepper|salt and pepper|olive oil|vegetable oil|sunflower oil|oil|water|sugar|caster sugar|plain flour|flour|butter)$/i;
const tidyIngredient = (i) => {
  const p = typeof i === 'string' ? parseIngredient(i) : { raw: i.raw || i.item, qty: i.qty ?? null, unit: i.unit || null, item: i.item };
  return { ...p, ...((BASICS.test(p.item) || i.notIncluded) && { notIncluded: true }) };
};

let recipes = await read('recipes.json');
if (config.showSampleRecipes === false) recipes = recipes.filter((r) => !String(r.id).startsWith('sample-'));
recipes = recipes.map((r) => ({ servings: 2, source: String(r.id).startsWith('sample-') ? 'sample' : 'own', ...r, ingredients: (r.ingredients || []).map(tidyIngredient) }));
const unique = new Map(recipes.map((r) => [r.id, r])); // last copy wins, the same as the board
recipes = [...unique.values()];

await fs.mkdir(DEST, { recursive: true });
for (const f of await fs.readdir(DEST)) if (f.endsWith('.json')) await fs.rm(path.join(DEST, f));
await fs.writeFile(path.join(DEST, 'config.json'), JSON.stringify(config, null, 1));
await fs.writeFile(path.join(DEST, 'recipes.json'), JSON.stringify(recipes));

// Small index (no ingredients or steps) - the full recipe loads only when you open one.
const index = recipes.map((r) => ({
  id: r.id, name: r.name, subtitle: r.subtitle, emoji: r.emoji, thumbnail: r.thumbnail || r.image || null, image: r.image || null,
  totalTimeMinutes: r.totalTimeMinutes, cuisine: r.cuisine, tags: r.tags, calories: r.calories, source: r.source,
  cats: categorize(r), // Library categories (site/categories.js)
  q: ingredientText(r), // Library search on ingredients
}));
const n = {};
for (const r of index) for (const c of r.cats) n[c] = (n[c] || 0) + 1;
console.log('Categories: ' + CATEGORIES.filter((c) => n[c.id]).map((c) => `${c.label} ${n[c.id]}`).join(', '));
await fs.writeFile(path.join(DEST, 'recipes-index.json'), JSON.stringify(index));
console.log(`Wrote site/data/: config.json, recipes.json and recipes-index.json (${recipes.length} recipes${config.showSampleRecipes === false ? ', samples hidden' : ''})`);

// Static recipe pages, regenerated every sync.
await fs.rm(PAGES, { recursive: true, force: true });
await fs.mkdir(PAGES, { recursive: true });
const skipped = [];
let written = 0;
for (const r of recipes) {
  const why = pageProblem(r);
  if (why) { skipped.push(`${r.id}: ${why}`); continue; }
  await fs.writeFile(path.join(PAGES, `${r.id}.html`), recipePage(r, config.siteUrl || ''));
  written++;
}
console.log(`Wrote ${written} recipe pages to site/recipe/${skipped.length ? `; skipped ${skipped.length}: ${skipped.join('; ')}` : ''}`);
