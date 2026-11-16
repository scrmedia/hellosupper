// HelloSupper recipe categories - ONE place for "which categories is this recipe in", shared by the board (Library chips),
// scripts/sync-site.mjs (precomputed `cats` in recipes-index.json), scripts/board.mjs, functions/api/state.js (explicit
// categories on added recipes), shortlist.js (the rules) and recipe-ld.js (JSON-LD `keywords`). ES module, no dependencies.
// A recipe can be in many categories (Chinese + Under 20 min + Chicken). Rules prefer leaving a recipe out over guessing.
//   categorize(r) -> ['chinese', 'under-20', 'under-30', ..., 'chicken']   (r = recipes.json shape, or customToRecipe())
// Custom recipes can name categories explicitly: recipe.json "categories": ["slow-cooker", "chinese"] (ids or labels).

export const GROUPS = [
  { id: 'time', label: 'Time' },
  { id: 'cuisine', label: 'Cuisine' },
  { id: 'protein', label: 'Main protein' },
  { id: 'dish', label: 'Type' },
  { id: 'slow', label: 'Slow cooker' },
];

// Cuisine buckets. `from` = values of the recipe's own cuisine field that map to this bucket.
// `name` = words in the recipe NAME that put it in this bucket whatever the field says ("Thai-Style ..." under "Asian").
// `dish` = dish words in the name, used only when the field is vague (Fusion / Asian / empty) - so an "Italian" recipe
// doesn't become Mexican just because it says "fajita pasta".
const CUISINES = [
  { id: 'italian', label: 'Italian', from: ['Italian'], name: /\b(italian|tuscan|sicilian|neapolitan|roman)\b/i,
    dish: /\b(risotto|carbonara|bolognese|ragu|arrabbiata|puttanesca|cacio e pepe|alfredo|parmigiana|saltimbocca|cacciatore|gnocchi|lasagne|lasagna|pesto|pizza|calzone|bruschetta|tagliatelle|linguine|rigatoni|orecchiette|tortelloni|tortellini|ravioli|pappardelle|penne|spaghetti|fusilli|tortiglioni|casarecce|farfalle|'?nduja|porchetta|focaccia|panzanella|minestrone|arancini)\b/i },
  { id: 'british', label: 'British', from: ['British'], name: /\b(british|english|scottish|welsh|irish)\b/i,
    dish: /\b(cottage pie|shepherd'?s pie|toad in the hole|bangers|fish and chips|ploughman'?s|yorkshire|sunday roast|pie and mash|bubble and squeak)\b/i },
  { id: 'indian', label: 'Indian', from: ['Indian', 'South Asian', 'Pakistani', 'Nepalese'], name: /\b(indian|punjabi|keralan|goan|bengali|bombay|madras|kashmiri|sri lankan|nepalese|pakistani)\b/i,
    dish: /\b(tikka|masala|korma|jalfrezi|dhansak|dopiaza|rogan josh|vindaloo|madras|balti|bhuna|biryani|dal|dahl|daal|tarka|keema|saag|paneer|pakora|bhaji|samosa|naan|tandoori|butter chicken|chana|aloo|makhani|raita|kofta curry)\b/i },
  { id: 'chinese', label: 'Chinese', from: ['Chinese'], name: /\b(chinese|cantonese|szechuan|sichuan|hunan|shanghai|peking|hong kong|kung pao)\b/i,
    dish: /\b(chow mein|lo mein|char siu|kung pao|sweet (and|&|n'?) sour|hoisin|crispy chilli beef|salt (and|&) pepper|egg fried rice|black bean sauce|five[- ]spice|dumplings?|bao|wontons?|dan dan|mapo|general tso'?s?|chop suey|spring rolls?|bang bang)\b/i },
  { id: 'thai', label: 'Thai', from: ['Thai'], name: /\bthai\b/i,
    dish: /\b(pad thai|pad see ew|massaman|panang|penang|green curry|red curry|tom yum|tom kha|larb|satay|khao)\b/i },
  { id: 'japanese', label: 'Japanese', from: ['Japanese'], name: /\b(japanese|tokyo)\b/i,
    dish: /\b(katsu|teriyaki|ramen|udon|soba|yakitori|tonkatsu|donburi|gyoza|miso|tempura|furikake|okonomiyaki|yaki ?soba|sushi|tataki)\b/i },
  { id: 'korean', label: 'Korean', from: ['Korean'], name: /\bkorean\b/i,
    dish: /\b(gochujang|bulgogi|bibimbap|kimchi|japchae|gochugaru|ssamjang)\b/i },
  { id: 'se-asian', label: 'South East Asian', from: ['Vietnamese', 'Indonesian', 'Filipino'], name: /\b(vietnamese|indonesian|malaysian|singapore|filipino|cambodian|balinese|burmese)\b/i,
    dish: /\b(banh mi|pho|nasi goreng|mee goreng|rendang|laksa|adobo|sambal|bun cha)\b/i },
  { id: 'mexican', label: 'Mexican', from: ['Mexican'], name: /\b(mexican|tex[- ]mex)\b/i,
    dish: /\b(fajitas?|tacos?|burritos?|enchiladas?|quesadillas?|nachos|chimichangas?|chipotle|tostadas?|chilli con carne|chili con carne|carnitas|birria|elote|pico de gallo|guac(amole)?)\b/i },
  { id: 'american', label: 'American', from: ['American', 'Cajunsk'], name: /\b(american|cajun|creole|southern|nashville|texas|louisiana|new york|philly|californian?|tennessee|kentucky)\b/i,
    dish: /\b(mac (and|&|n'?) cheese|sloppy joes?|buffalo|bbq|barbecue|hot dogs?|cheesesteak|jambalaya|gumbo|po'? boy|cornbread|ranch)\b/i },
  { id: 'mediterranean', label: 'Mediterranean', from: ['Mediterranean', 'Greek', 'Spanish', 'Portuguese'], name: /\b(mediterranean|greek|spanish|portuguese|cypriot|catalan|andalusian)\b/i,
    dish: /\b(souvlaki|gyros?|moussaka|tzatziki|paella|patatas bravas|tapas|romesco)\b/i },
  { id: 'middle-eastern', label: 'Middle Eastern', from: ['Middle Eastern', 'Turkish', 'Lebanese', 'Moroccan'], name: /\b(middle eastern|turkish|lebanese|moroccan|persian|syrian|israeli|egyptian|tunisian|levantine)\b/i,
    dish: /\b(shawarma|falafel|tagine|za'?atar|shakshuka|kofte?a?s?|dukkah|baharat|ras el hanout|tabbouleh|fattoush|hummus|houmous|freekeh|pomegranate molasses)\b/i },
  { id: 'french', label: 'French', from: ['French'], name: /\b(french(?! (toast|fries|beans|dressing|mustard|stick))|proven[cç]al|parisian|normandy|bourguignon)\b/i,
    dish: /\b(bourguignon|dauphinoise|gratin|au poivre|coq au vin|cassoulet|ratatouille|croque|nicoise|béarnaise|bearnaise|tartiflette)\b/i },
  { id: 'caribbean', label: 'Caribbean', from: ['Caribbean'], name: /\b(caribbean|jamaican|trinidad(ian)?|bajan)\b/i,
    dish: /\b(jerk|rice and peas|plantain)\b/i },
];
const VAGUE_CUISINE = new Set(['', 'Fusion', 'Fusion cuisine', 'Asian', 'East Asian']);
const ASIAN_IDS = ['chinese', 'thai', 'japanese', 'korean', 'se-asian'];

// Main proteins. Matched on the name first; only if the name names none, on the included ingredients (never stock,
// gravy, sauces - "chicken stock" doesn't make a dish a chicken dish).
const PROTEINS = [
  { id: 'chicken', label: 'Chicken', re: /\bchicken\b(?! (stock|gravy|bouillon|seasoning|salt))/i },
  { id: 'beef', label: 'Beef', re: /\b(beef|(?<!(lamb|pork|gammon|tuna|salmon|cauliflower|halloumi|turkey|chicken|fish|cod|aubergine|celeriac|swordfish|mushroom|tofu|veg|vegetable|cabbage) )steaks?|brisket|sirloin|rump|ribeye|bavette|feather blade)\b(?! (stock|gravy|bouillon|tomatoes))|\b(beef )?burgers?\b(?=.*\bbeef\b)/i },
  { id: 'pork', label: 'Pork, bacon & ham', re: /\b(pork|gammon|bacon|lardons|ham|pancetta|chorizo|'?nduja|prosciutto|parma ham|serrano|pepperoni|salami)\b(?! (stock|gravy))|\b(pork |cumberland |lincolnshire |toulouse )?sausages?\b/i,
    not: /\b(chicken|turkey|veg(gie|etarian|an)?|plant[- ]based|meat[- ]free|meatless|quorn|halloumi|beef|lamb|merguez|vegan)\s+(sausages?|bacon|chorizo|ham)\b|\bham(?=burger)/gi },
  { id: 'lamb', label: 'Lamb', re: /\blamb\b(?! (stock|gravy|lettuce))/i },
  { id: 'turkey', label: 'Turkey', re: /\bturkey\b(?! (stock|gravy))/i },
  { id: 'duck', label: 'Duck', re: /\bduck\b(?! (stock|gravy|sauce|egg))/i },
  { id: 'fish', label: 'Fish & seafood', re: /\b(fish(?! sauce)|salmon|cod|haddock|basa|hake|pollock|coley|prawns?|shrimps?|tuna|mackerel|sea ?bass|bream|trout|sardines?|scallops?|mussels?|clams?|squid|calamari|crab|lobster|seafood|kipper|tilapia|monkfish|plaice|halibut|seabream)\b/i },
];
// Anything here in an ingredient = not vegetarian (stock included - chicken stock in a "veggie" dish isn't veggie).
const MEAT_ANY = /\b(chicken|beef|steak|brisket|pork|gammon|bacon|lardons|ham|pancetta|chorizo|'?nduja|prosciutto|salami|pepperoni|sausages?|lamb|mince|turkey|duck|venison|meatballs?|fish(?! sauce)|salmon|cod|haddock|prawns?|tuna|mackerel|anchov(y|ies)|seafood|mussels?|squid|crab|gelatine|fish sauce|oyster sauce|worcestershire)\b/i;
const MEAT_FREE = /\b(meat[- ]free|plant[- ]based|vegan|vegetarian|veggie|quorn|meatless|this\W{0,3}\s*isn[’']?t)/i;
const VEG_TAG = /^(vegetarian|veggie|vegan|plant-based)/i;

// Type of dish (name-based; reliable enough to filter on).
const DISHES = [
  { id: 'pasta', label: 'Pasta', re: /\b(pasta|penne|spaghetti|linguine|tagliatelle|fusilli|rigatoni|orzo|gnocchi|tortell\w*|ravioli|lasagne|lasagna|macaroni|mac (and|&|n'?) cheese|conchiglie|orecchiette|farfalle|pappardelle|cannelloni|bucatini|casarecce|campanelle|fettuccine|carbonara|cavatappi|trofie|mafalde|radiatori|tortiglioni|bolognese|spag bol)\b/i },
  { id: 'curry', label: 'Curry', re: /\b(curry|curried|tikka masala|korma|jalfrezi|dhansak|rogan josh|vindaloo|madras|balti|bhuna|biryani|massaman|panang|dal|dahl|daal|keema|saag|rendang|laksa|makhani|butter chicken)\b/i },
  { id: 'noodles', label: 'Noodles', re: /\b(noodles?|udon|ramen|soba|chow mein|lo mein|pad thai|pad see ew|vermicelli|japchae|yaki ?soba|laksa|pho)\b/i },
  { id: 'burgers', label: 'Burgers & wraps', re: /\b(burgers?|tacos?|burritos?|wraps?|quesadillas?|kebabs?|pittas?|flatbreads?|sandwich(es)?|bao|sliders?|subs?|toasties?|hot dogs?|baguettes?|naan wraps?)\b/i },
  { id: 'one-pot', label: 'One pot / one tray', re: /\b(one[- ](pot|pan|tray)|traybake|tray[- ]bake|sheet[- ]pan|tray[- ]roast(ed)?|all[- ]in[- ]one)\b/i },
  { id: 'family', label: 'Family friendly', tags: /^(family friendly|family classics|family|kid friendly|kids)$/i },
  { id: 'lighter', label: 'Lighter (≤ 600 kcal)' },
];

// Time (cumulative: a 15 min recipe is in Under 20, Under 30, Under 40 and Under 60).
const TIMES = [
  { id: 'under-20', label: 'Under 20 min', max: 20 }, { id: 'under-30', label: 'Under 30 min', max: 30 },
  { id: 'under-40', label: 'Under 40 min', max: 40 }, { id: 'under-60', label: 'Under 60 min', max: 60 },
  { id: 'over-60', label: '60+ min', min: 61 },
];
// "Under 20" means 20 minutes or less (that's how most recipe sites label a 20-minute recipe).

const SLOW = /\b(slow[- ]?cooker|crock[- ]?pot|crockpot)\b/i;

export const CATEGORIES = [
  { id: 'slow-cooker', label: 'Slow cooker', group: 'slow', icon: '🍲' }, // its own group: ANDs with Type (slow cooker + curry)
  ...TIMES.map((t) => ({ id: t.id, label: t.label, group: 'time' })),
  ...CUISINES.map((c) => ({ id: c.id, label: c.label, group: 'cuisine' })),
  { id: 'asian', label: 'Any Asian', group: 'cuisine' },
  { id: 'other-cuisine', label: 'Other cuisines', group: 'cuisine' },
  ...PROTEINS.map((p) => ({ id: p.id, label: p.label, group: 'protein' })),
  { id: 'veggie', label: 'Veggie', group: 'protein' },
  ...DISHES.map((x) => ({ id: x.id, label: x.label, group: 'dish' })),
];
export const CATEGORY_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));
export const categoryLabel = (id) => CATEGORY_BY_ID.get(id)?.label || id;

// "Slow Cooker", "slow-cooker", "slow cooker" -> 'slow-cooker'; unknown -> null. Labels work too ("Under 30 min").
export function categoryId(x) {
  const s = String(x ?? '').trim().toLowerCase();
  if (!s) return null;
  const slug = s.replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (CATEGORY_BY_ID.has(slug)) return slug;
  const byLabel = CATEGORIES.find((c) => c.label.toLowerCase() === s);
  if (byLabel) return byLabel.id;
  const alias = { 'slowcooker': 'slow-cooker', 'crockpot': 'slow-cooker', 'crock-pot': 'slow-cooker', 'vegetarian': 'veggie', 'vegan': 'veggie',
    'fish': 'fish', 'seafood': 'fish', 'one-tray': 'one-pot', 'one-pan': 'one-pot', 'traybake': 'one-pot', 'kid-friendly': 'family',
    'kids': 'family', 'south-east-asian': 'se-asian', 'southeast-asian': 'se-asian', 'vietnamese': 'se-asian', 'indonesian': 'se-asian',
    'malaysian': 'se-asian', 'greek': 'mediterranean', 'spanish': 'mediterranean', 'portuguese': 'mediterranean', 'turkish': 'middle-eastern',
    'lebanese': 'middle-eastern', 'moroccan': 'middle-eastern', 'under-20-min': 'under-20', 'under-30-min': 'under-30',
    'under-40-min': 'under-40', 'under-60-min': 'under-60', '60-min': 'over-60', '60': 'over-60', 'burgers': 'burgers', 'wraps': 'burgers' };
  return alias[slug] || null;
}

const minutesOf = (r) => r.totalTimeMinutes || r.timeMins || r.prepTimeMinutes || null;

// The categories for one recipe (sorted in CATEGORIES order). Explicit `r.categories` (custom recipes) are added on top.
export function categorize(r) {
  const out = new Set();
  const name = String(r.name || r.title || '');
  const included = (r.ingredients || []).filter((i) => !i.notIncluded).map((i) => String(i.item || i.name || i.raw || ''));
  const allIngs = (r.ingredients || []).map((i) => String(i.item || i.name || i.raw || '')).join(' | ');
  const tags = (r.tags || []).map((t) => String(t).trim());
  const steps = (r.steps || []).join(' ');

  // time
  const m = minutesOf(r);
  if (m) for (const t of TIMES) if ((t.max && m <= t.max) || (t.min && m >= t.min)) out.add(t.id);

  // cuisine
  const field = String(r.cuisine || '').trim();
  const vague = VAGUE_CUISINE.has(field);
  for (const c of CUISINES) {
    if (c.from.includes(field) || c.name.test(name) || (vague && c.dish.test(name))) out.add(c.id);
  }
  if (ASIAN_IDS.some((id) => out.has(id)) || ['Asian', 'East Asian'].includes(field) || /\basian\b/i.test(name)) out.add('asian');
  if (field && !CUISINES.some((c) => out.has(c.id)) && !out.has('asian') && !vague) out.add('other-cuisine'); // e.g. German, Russian, Brazilian

  // protein: name first, else included ingredients
  const hits = (text) => PROTEINS.filter((p) => p.re.test(p.not ? text.replace(p.not, ' ') : text)).map((p) => p.id);
  let prot = hits(name.replace(MEAT_FREE_NAME, ' '));
  if (!prot.length && !MEAT_FREE.test(name)) prot = hits(included.join(' | '));
  for (const p of prot) out.add(p);
  // Veggie = no meat or fish anywhere (name or ingredients, stock included) once "meat-free mince" etc. are taken out.
  // The source's Vegetarian tags aren't trusted on their own (a "Prawn Thai Red Curry" carries one).
  const meatless = !MEAT_ANY.test(allIngs.replace(MEAT_FREE_NAME, ' ')) && !MEAT_ANY.test(name.replace(MEAT_FREE_NAME, ' '));
  if (meatless && ((r.ingredients || []).length || tags.some((t) => VEG_TAG.test(t)))) { out.add('veggie'); for (const p of PROTEINS) out.delete(p.id); }

  // type of dish
  for (const x of DISHES) {
    if (x.re && x.re.test(name) && !(x.id === 'pasta' && /\brisotto\b/i.test(name))) out.add(x.id);
    if (x.tags && tags.some((t) => x.tags.test(t))) out.add(x.id);
  }
  if (r.calories && r.calories <= 600) out.add('lighter');
  if (SLOW.test(name) || SLOW.test(steps) || tags.some((t) => SLOW.test(t))) out.add('slow-cooker');

  for (const c of r.categories || []) { const id = categoryId(c); if (id) out.add(id); }
  return CATEGORIES.map((c) => c.id).filter((id) => out.has(id));
}
// "Meat-free mince", "vegan chicken", "plant-based sausages" etc. don't count as meat.
const MEAT_FREE_NAME = /\b(meat[- ]free|plant[- ]based|vegan|vegetarian|veggie|quorn|meatless|this\W{0,3}\s*isn[’']?t)\s+\w+(\s+(mince|sausages?|chicken|bacon|pieces|burgers?|meatballs?))?/gi;

// Search text for one recipe: name, subtitle, cuisine, tags, category labels and ingredients - lower-case, one string.
// sync-site.mjs stores only the ingredient part (`q`) in recipes-index.json; the board adds the rest from the index row.
const PANTRY = /^(salt|black pepper|pepper|olive oil|vegetable oil|oil|water|sugar|butter|flour|plain flour|cooking oil|sunflower oil|caster sugar)$/i;
export const ingredientText = (r) => [...new Set((r.ingredients || []).map((i) => String(i.item || i.name || '').toLowerCase().trim())
  .filter((x) => x && !PANTRY.test(x)))].join(' ');
export function searchText(r, cats = r.cats || categorize(r)) {
  return [r.name || r.title, r.subtitle, r.cuisine, ...(r.tags || []), ...cats.map(categoryLabel), r.q ?? ingredientText(r)]
    .filter(Boolean).join(' ').toLowerCase().replace(/\s+/g, ' ');
}
