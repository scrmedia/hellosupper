// Ingredient parsing, aisles and the week's shopping list. ES module, no dependencies: used by the board (Shopping tab),
// functions/api/import.js (parsing ingredient lines from other sites) and scripts/board.mjs (the shopping list for an agent).

const UNIT_MAP = {
  grams: 'g', gram: 'g', g: 'g',
  kilogram: 'kg', kilograms: 'kg', kg: 'kg',
  'milliliter(s)': 'ml', milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', ml: 'ml',
  'liter(s)': 'l', litre: 'l', l: 'l',
  'unit(s)': 'unit', unit: 'unit', units: 'unit',
  'sachet(s)': 'sachet', sachet: 'sachet', sachets: 'sachet',
  'pot(s)': 'pot', pot: 'pot', pots: 'pot',
  'bunch(es)': 'bunch', bunch: 'bunch',
  'pack(s)': 'pack', pack: 'pack', 'packet(s)': 'pack',
  'tin(s)': 'tin', tin: 'tin', 'can(s)': 'tin',
  'carton(s)': 'carton', 'jar(s)': 'jar', 'bag(s)': 'bag',
  'clove(s)': 'clove', clove: 'clove', cloves: 'clove',
  'tbsp': 'tbsp', 'tablespoon(s)': 'tbsp', tablespoon: 'tbsp',
  'tsp': 'tsp', 'teaspoon(s)': 'tsp', teaspoon: 'tsp',
  'pinch(es)': 'pinch', pinch: 'pinch',
  'rasher(s)': 'rasher', rasher: 'rasher', 'nest(s)': 'nest', nest: 'nest',
  'slice(s)': 'slice', 'piece(s)': 'piece', 'ball(s)': 'ball', 'cup(s)': 'cup',
  tablespoons: 'tbsp', teaspoons: 'tsp', tbsps: 'tbsp', tsps: 'tsp', cup: 'cup', cups: 'cup',
  pound: 'lb', pounds: 'lb', lb: 'lb', lbs: 'lb', ounce: 'oz', ounces: 'oz', oz: 'oz', tins: 'tin', cans: 'tin', can: 'tin',
};

export function normalizeUnit(u) {
  if (!u) return null;
  const k = String(u).trim().toLowerCase();
  return UNIT_MAP[k] || k;
}

const FRACTIONS = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125 };

function parseQty(s) {
  s = s.trim();
  if (FRACTIONS[s] != null) return FRACTIONS[s];
  const mixed = /^(\d+)\s*([½¼¾⅓⅔⅛])$/.exec(s);
  if (mixed) return +mixed[1] + FRACTIONS[mixed[2]];
  const frac = /^(\d+)\/(\d+)$/.exec(s);
  if (frac) return +frac[1] / +frac[2];
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse an ingredient line like "350 grams salad potatoes" or "½ green chilli". If structured data is supplied it is
 * trusted instead.
 */
export function parseIngredient(raw, structured) {
  raw = String(raw).replace(/\s+/g, ' ').trim();
  let qty = null, unit = null, item = raw, shipped = true;
  if (structured) {
    qty = structured.qty ?? null;
    unit = normalizeUnit(structured.unit);
    item = structured.item;
    shipped = structured.shipped !== false;
  } else {
    const glued = /^(\d+(?:[.,]\d+)?)\s?(g|kg|ml|l|tbsp|tsp)\b\.?\s+(.*)$/i.exec(raw); // "200g pasta", "1.5 kg potatoes"
    const m = glued ? null : /^((?:\d+(?:[.,]\d+)?|\d+\/\d+)?\s*[½¼¾⅓⅔⅛]?)\s+(.*)$/.exec(raw);
    if (glued) {
      qty = parseFloat(glued[1].replace(',', '.'));
      unit = normalizeUnit(glued[2]);
      item = glued[3];
    } else if (m && m[1].trim()) {
      qty = parseQty(m[1].replace(',', '.'));
      item = m[2];
      const u = /^([a-z]+(?:\([a-z]+\))?)\s+(.*)$/i.exec(item);
      if (u && UNIT_MAP[u[1].toLowerCase()]) {
        unit = normalizeUnit(u[1]);
        item = u[2];
      }
    }
  }
  if (qty != null) qty = Math.round(qty * 1000) / 1000;
  const out = { raw, qty, unit, item: item.trim() };
  if (!shipped) out.notIncluded = true; // a cupboard basic such as oil or salt
  return out;
}

// ---------- Aisles ----------
// Order here = order on the shopping list. First matching rule wins.
export const CUPBOARD = 'Cupboard - check you have it';
export const AISLES = [
  ['Fruit & veg', /\b(onion|shallot|garlic|ginger|potato|carrot|pepper(?!corn)|chilli(?! (flakes|powder|sauce|jam|oil|paste))|(?<!chopped )tomato(?!e?s? (paste|puree|passata|ketchup))|cherry tom|lettuce|spinach|kale|cabbage|broccoli|tenderstem|courgette|aubergine|cucumber|lemon|lime|orange|apple|pear|avocado|mushroom|leek|celery|squash|pumpkin(?! seed)|sweet potato|parsnip|beetroot|pea shoots|rocket|salad leaves|baby leaf|mixed leaves|leaves|spring onion|radish|fennel|asparagus|green beans|mangetout|sugar snap|corn on the cob|sweetcorn cob|pak choi|bok choi|coriander|parsley|basil|mint|dill|rosemary|thyme|chives|sage|tarragon|lemongrass|herbs?|cauliflower|sprouts|mango|pomegranate|grapes|berries|banana|plum|fig|spring greens|sweet pea pods|kohlrabi|swede|turnip|jalape)/i],
  ['Meat & poultry', /\b(chicken|beef|steak|mince|pork|lamb|bacon|lardons|sausage|chorizo|ham\b|prosciutto|pancetta|turkey|duck|venison|meatball|salami|nduja|'nduja|gammon|pulled)/i],
  ['Fish & seafood', /\b(salmon|cod|haddock|basa|hake|prawn|shrimp|tuna|mackerel|sea bass|seabass|trout|pollock|fish|scallop|mussel|squid|crab)/i],
  ['Dairy, eggs & chilled', /\b((?<!coconut )milk|(?<!coconut )cream|creme fraiche|crème fraîche|yoghurt|yogurt|(?<!peanut )butter(?! beans)|cheese|cheddar|mozzarella|parmesan|parmigiano|grana padano|hard italian|feta|halloumi|ricotta|mascarpone|paneer|goats|goat's|brie|eggs?\b(?! noodle)|fresh pasta|gnocchi|tofu|hummus|houmous|tzatziki|pesto|soured cream|sour cream|plant[- ]based|quorn|vegan)/i],
  ['Bakery', /\b(bread|bun|brioche|ciabatta|naan|flatbread|tortilla|wrap|pitta|pita|baguette|roll|focaccia|crumpet|bagel|panko|breadcrumb|croutons)/i],
  ['Pasta, rice & grains', /\b(pasta|spaghetti|linguine|penne|rigatoni|fusilli|orzo|tagliatelle|macaroni|conchiglie|casarecce|tortiglioni|farfalle|orecchiette|pappardelle|fettuccine|lasagne|noodle|rice(?! vinegar| wine)|couscous|bulgur|bulgar|quinoa|freekeh|pearl barley|giant couscous|lentil|oats|polenta)/i],
  ['Tins, jars & sauces', /\b(tin|chopped tomatoes|passata|tomato puree|tomato paste|ketchup|mayo|mayonnaise|mustard|soy sauce|worcester|sriracha|hoisin|teriyaki|sweet chilli|chilli jam|chutney|vinegar|honey|maple|syrup|jam|stock|gravy|coconut milk|coconut cream|beans|chickpea|kidney|butter beans|cannellini|black beans|olives|capers|gherkin|sundried|sun-dried|jalapenos|pickled|peanut butter|tahini|sauce|oil|harissa|pesto)/i],
  ['Herbs, spices & baking', /\b(spice|seasoning|paprika|cumin|coriander seed|turmeric|garam|curry powder|chilli flakes|chili flakes|chilli powder|oregano|dried|cinnamon|nutmeg|pepper ?corn|black pepper|salt|sugar|flour|cornflour|baking|yeast|stock cube|za'atar|zaatar|dukkah|sesame|seeds|nuts|almond|cashew|peanut|pine nut|walnut|pecan|raisin|sultana|cranberr)/i],
  ['Frozen', /\b(frozen|peas\b|edamame|sweetcorn)/i],
  ['Other', /.*/],
  [CUPBOARD, null],
];

/** Pastes, spice mixes and dried herbs you'd normally already have in the cupboard rather than buy for one recipe. */
export function isCupboardSachet(ing) {
  const u = ing.unit || '';
  const name = ing.item || '';
  if (u === 'sachet' || u === 'pot') return true;
  return /\b(paste|spice mix|seasoning|spice blend|stock paste|stock pot|stock powder|stock cube|stock mix|curry paste|harissa paste|garlic paste|ginger paste|chipotle paste|miso paste|tomato paste|gochujang|tikka paste|korma paste|rogan josh|massaman|rendang|dukkah|za'?atar|ras el hanout|baharat|berbere|shichimi|furikake|cajun|jerk|bbq spice|fajita spice|mexican spice|moroccan spice|smoked paprika|ground cumin|ground coriander|garam masala|curry powder|chilli flakes|dried oregano|dried thyme|mixed herbs|italian herbs|herbes de provence|five spice|chinese five)\b/i.test(name);
}

export function aisleFor(ing) {
  if (isCupboardSachet(ing)) return CUPBOARD;
  const name = ing.item || '';
  if (/\b(stock|gravy)\b/i.test(name)) return 'Tins, jars & sauces'; // "beef stock" isn't meat
  for (const [aisle, re] of AISLES) if (re && re.test(name)) return aisle;
  return 'Other';
}

/** Key for merging duplicates across recipes: lowercase, drop trademark symbols/plurals/qualifiers. */
export function itemKey(name) {
  return String(name)
    .toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/\b(british|fresh|free range|free-range|organic|for the [a-z ]+)\b/g, '')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/oes$/, 'o')
    .replace(/([^s])s$/, '$1');
}

export const fmtQty = (q) => (q == null ? '' : Number.isInteger(q) ? String(q) : String(Math.round(q * 100) / 100));

// ---------- The week's shopping list ----------
const SKIP = /^(water|boiled water|cold water|hot water|ice)\b/i; // never worth listing
// "a small handful of fresh mint" -> "fresh mint" on the shopping list (the recipe keeps the full wording)
const LOOSE = /^(?:a|an|1)\s+(?:(?:small|large|big|good|generous)\s+)?(?:handful|pinch|bunch|sprig|few sprigs|splash|drizzle|knob|squeeze)s?\s+of\s+/i;
const CUPBOARD_NOTE = 'check the cupboard';
const UNIT_LABEL = { unit: '', g: 'g', ml: 'ml', kg: 'kg', l: 'l', tbsp: ' tbsp', tsp: ' tsp', lb: ' lb', oz: ' oz' };
export function displayAmount(amounts) {
  return amounts
    .map(({ qty, unit }) => {
      if (qty == null) return unit || '';
      const u = unit == null ? '' : UNIT_LABEL[unit] ?? ` ${unit}${qty > 1 && !/s$/.test(unit) ? 's' : ''}`;
      return `${fmtQty(qty)}${u}`;
    })
    .filter(Boolean)
    .join(' + ');
}

/**
 * One merged list for the week's dinners.
 *   recipes: full recipes ({name, servings, ingredients: [{qty, unit, item, notIncluded?}]})
 *   servings: how many you cook for - each recipe is scaled from its own servings to this (default: as written)
 *   extras: shared "also buy" items [{text, on}]
 * Returns { meals, aisles: [{aisle, items: [{id, item, display, recipes, flags}]}], itemCount }.
 */
export function buildShoppingList(recipes, { servings = null, extras = [] } = {}) {
  const items = new Map();
  for (const recipe of recipes) {
    const scale = servings && recipe.servings ? servings / recipe.servings : 1;
    for (let ing of recipe.ingredients || []) {
      if (!ing.item || SKIP.test(ing.item)) continue;
      if (LOOSE.test(ing.item)) ing = { ...ing, item: ing.item.replace(LOOSE, '') };
      const key = itemKey(ing.item);
      let line = items.get(key);
      if (!line) {
        line = { key, item: ing.item.replace(/\s+for the [a-z ]+$/i, ''), aisle: ing.notIncluded ? CUPBOARD : aisleFor(ing), amounts: [], recipes: [], flags: [] };
        items.set(key, line);
      }
      // Sum where units match; different units stay as separate amounts on the same line ("1 + 200g").
      const unit = ing.unit || null;
      const qty = ing.qty == null ? null : Math.round(ing.qty * scale * 100) / 100;
      const amt = line.amounts.find((a) => a.unit === unit && a.qty != null && qty != null);
      if (amt) amt.qty = Math.round((amt.qty + qty) * 1000) / 1000;
      else line.amounts.push({ qty, unit });
      if (!line.recipes.includes(recipe.name)) line.recipes.push(recipe.name);
      if ((isCupboardSachet(ing) || ing.notIncluded) && !line.flags.includes(CUPBOARD_NOTE)) line.flags.push(CUPBOARD_NOTE);
    }
  }
  const extraLines = (extras || []).filter((x) => x.on).map((x) => ({ id: 'extra-' + x.id, item: x.text, display: '', recipes: [], flags: [] }));
  const aisles = AISLES.map((a) => a[0])
    .map((name) => ({
      aisle: name,
      items: [...items.values()].filter((l) => l.aisle === name).sort((a, b) => a.item.localeCompare(b.item))
        .map(({ key, aisle, amounts, ...l }) => ({ id: key.replace(/[^a-z0-9]+/g, '-'), ...l, display: displayAmount(amounts) })),
    }))
    .filter((a) => a.items.length);
  if (extraLines.length) aisles.push({ aisle: 'Also buy', items: extraLines });
  return {
    meals: recipes.map((r) => r.name),
    aisles,
    itemCount: aisles.reduce((n, a) => n + a.items.length, 0),
  };
}

/** Plain text for copying into a notes app, a message, or an AI agent. */
export function shoppingText(list, title = 'Shopping list') {
  const out = [title];
  if (list.meals.length) out.push(`For: ${list.meals.join('; ')}`);
  out.push('');
  for (const a of list.aisles) {
    out.push(a.aisle.toUpperCase());
    for (const i of a.items) out.push(`- ${i.item}${i.display ? ' - ' + i.display : ''}${i.flags.length && a.aisle !== CUPBOARD ? ` (${i.flags.join('; ')})` : ''}`);
    out.push('');
  }
  return out.join('\n').trim() + '\n';
}
