// Backend proxy for "What We Cooking Today".
// Keeps the Anthropic API key server-side and enforces strict recipe rules
// so the AI can't be looser than the local demo fallback was.
//
// Setup:
//   npm install
//   cp .env.example .env   (put your real ANTHROPIC_API_KEY in .env)
//   npm start
//
// Then in the app, set API_BASE_URL (in the <script> near the top of
// WhatWeCookingToday.html) to wherever you deploy this.

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';

async function callClaude(messages, maxTokens, system) {
  const body = { model: MODEL, max_tokens: maxTokens, messages };
  if (system) body.system = system;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }
  const data = await res.json();
  const block = (data.content || []).find(b => b.type === 'text');
  if (!block) throw new Error('Empty response from model');
  return block.text.trim();
}

// Claude is instructed to return ONLY JSON, but real-world responses can
// occasionally include a code fence or a short lead-in sentence despite
// that instruction. Rather than silently swallowing a parse failure and
// returning an empty array (which the app displays as "nothing found" —
// indistinguishable from a genuine empty result), extract the JSON
// substring robustly and only give up after that also fails, so a real
// parsing problem surfaces as an actual error the app can report.
function extractJson(raw, kind /* 'array' | 'object' */) {
  let text = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(text);
  } catch (e) { /* fall through to bracket extraction */ }

  const openChar = kind === 'array' ? '[' : '{';
  const closeChar = kind === 'array' ? ']' : '}';
  const start = text.indexOf(openChar);
  const end = text.lastIndexOf(closeChar);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`No ${kind} found in model response: ${text.slice(0, 300)}`);
  }
  const candidate = text.slice(start, end + 1);
  return JSON.parse(candidate); // let this throw if still invalid — caller handles it
}

const LANG_NAMES = { el: 'Greek', en: 'English', es: 'Spanish', de: 'German', fr: 'French', it: 'Italian' };
const CUISINE_NAMES = { el: 'Greek', en: 'British/American', es: 'Spanish', de: 'German', fr: 'French', it: 'Italian' };

// ============================================================
// POST /api/barcode  { code }
// -> { name, category } | { notFound: true }
// ============================================================
// Tries several free, key-less databases in turn. Open Food Facts covers
// groceries well but only food; its sibling databases (Products, Beauty)
// use the same engine and cover household and personal-care items, and
// UPCItemDB's trial tier catches general retail that none of them index.
// All are queried server-side so the app isn't subject to per-site CORS
// rules, and so sources can be added later without shipping a new build.
const OFF_FAMILY = [
  { host: 'world.openfoodfacts.org', defaultCategory: 'pantry' },
  { host: 'world.openproductsfacts.org', defaultCategory: 'pantry' },
  { host: 'world.openbeautyfacts.org', defaultCategory: 'pantry' }
];

function categoryFromTags(tags, fallback) {
  const s = (tags || []).join(' ').toLowerCase();
  if (/frozen|surgel|tiefkühl|congel/.test(s)) return 'freezer';
  if (/dairy|milk|yogurt|yoghurt|cheese|butter|cream|egg|fresh|charcuterie|meat|fish|seafood/.test(s)) return 'fridge';
  return fallback || 'pantry';
}

async function lookupOffFamily(code) {
  for (const src of OFF_FAMILY) {
    try {
      const url = `https://${src.host}/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,product_name_en,brands,categories_tags`;
      const r = await fetch(url, { headers: { 'User-Agent': 'WhatWeCookingToday/1.0 (contact via app)' } });
      if (!r.ok) continue;
      const data = await r.json();
      if (data.status !== 1 || !data.product) continue;
      const p = data.product;
      const name = p.product_name_en || p.product_name;
      if (!name || !String(name).trim()) continue;
      const brand = (p.brands || '').split(',')[0].trim();
      return {
        name: brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${name}` : name,
        category: categoryFromTags(p.categories_tags, src.defaultCategory),
        source: src.host
      };
    } catch (e) {
      console.warn('[barcode] source failed', src.host, e.message);
    }
  }
  return null;
}

async function lookupUpcItemDb(code) {
  try {
    // Trial tier: no key, but only ~100 lookups/day per IP — used strictly
    // as a last resort after the open databases come up empty.
    const r = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(code)}`);
    if (!r.ok) return null;
    const data = await r.json();
    const item = data && Array.isArray(data.items) ? data.items[0] : null;
    if (!item || !item.title) return null;
    return {
      name: item.title,
      category: categoryFromTags([item.category || ''], 'pantry'),
      source: 'upcitemdb'
    };
  } catch (e) {
    console.warn('[barcode] upcitemdb failed', e.message);
    return null;
  }
}

app.post('/api/barcode', async (req, res) => {
  try {
    const code = (req.body && req.body.code ? String(req.body.code) : '').trim();
    if (!code) return res.status(400).json({ error: 'missing code' });

    let product = await lookupOffFamily(code);
    if (!product) product = await lookupUpcItemDb(code);

    if (!product) return res.json({ notFound: true });
    res.json(product);
  } catch (err) {
    console.error('[barcode] failed:', err.message);
    res.status(500).json({ error: 'barcode lookup failed', detail: err.message });
  }
});


// ============================================================
// POST /api/identify  { image: base64, mediaType: 'image/jpeg' }
// -> [{ name, category, quantity, unit }]
// ============================================================
app.post('/api/identify', async (req, res) => {
  try {
    const { image, mediaType } = req.body;
    if (!image) return res.status(400).json({ error: 'missing image' });

    const text = await callClaude([{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
        { type: 'text', text: `Look at this photo (fridge, pantry, or food items). Identify only the distinct food items you can clearly see — do not guess at items that are ambiguous or out of frame.
Reply with ONLY a JSON array, no prose, no markdown. Each item: {"name": "...", "category": "fridge" | "freezer" | "pantry", "quantity": "optional number as string or null", "unit": "optional unit or null"}.
If nothing is clearly identifiable, return [].` }
      ]
    }], 700);

    let parsed;
    try {
      parsed = extractJson(text, 'array');
    } catch (parseErr) {
      console.error('[identify] JSON parse failed. Raw model output:', text);
      throw parseErr;
    }
    res.json(Array.isArray(parsed) ? parsed : []);
  } catch (err) {
    console.error('[identify] failed:', err.message);
    res.status(500).json({ error: 'identify failed', detail: err.message });
  }
});

// ============================================================
// POST /api/recipes  { ingredients, filters, lang }
// -> [{ title, time_minutes, difficulty, meal_type, uses, extra_needed,
//        instructions, calories, protein, carbs, fat, is_local, diets }]
// ============================================================
app.post('/api/recipes', async (req, res) => {
  try {
    const { ingredients, filters = {}, lang = 'en' } = req.body;
    if (!Array.isArray(ingredients) || !ingredients.length) {
      return res.status(400).json({ error: 'missing ingredients' });
    }
    const langName = LANG_NAMES[lang] || 'English';
    const cuisine = CUISINE_NAMES[lang] || 'Mediterranean';

    const ingredientLines = ingredients.map(i => {
      const bits = [i.name];
      if (i.quantity) bits.push(`(${i.quantity}${i.unit ? ' ' + i.unit : ''})`);
      if (i.urgent) bits.push('[expiring soon — prioritize this]');
      if (i.isLeftover) bits.push('[leftover from a previous meal]');
      return '- ' + bits.join(' ');
    }).join('\n');

    const filterLines = [];
    if (filters.meal) filterLines.push(`Meal type requested: ${filters.meal} (only return this meal type).`);
    if (filters.time) filterLines.push(`Max time: ${filters.time} minutes per recipe.`);
    if (filters.diff) filterLines.push(`Difficulty requested: ${filters.diff}.`);
    const diets = filters.diets && filters.diets.length ? filters.diets : (filters.diet ? [filters.diet] : []);
    if (diets.length) filterLines.push(`Dietary requirement (must genuinely satisfy, not just label): ${diets.join(', ')}.`);
    if (filters.preferLocal) {
      filterLines.push(`Prefer ${cuisine} cooking. First choice is a genuine traditional ${cuisine} dish these ingredients can actually make. If no authentic traditional dish fits, do NOT fall back to generic international recipes — instead stay within ${cuisine} home cooking: use its everyday techniques, flavour pairings and staples (for Greek: olive oil, lemon, oregano, garlic, tomato, feta, yogurt, dill, parsley) to build a dish that would be recognisable in a ${cuisine} kitchen. Only set "is_local": true for genuinely traditional named dishes; a ${cuisine}-style dish that isn't a classic should have "is_local": false but should still be clearly ${cuisine} in character.`);
    }
    if (filters.preferUrgent) filterLines.push('Strongly prioritize the ingredients marked as expiring soon.');

    const system = `You are a careful home-cooking assistant. You generate recipes strictly from the ingredients the user actually has (plus common staples: salt, pepper, oil, water). You write in ${langName}.

HARD RULES — never break these:
1. Every recipe must be something a competent home cook could actually make and eat. No invented combinations that don't make culinary sense (e.g. never suggest baking or sweetening ingredients that are clearly savory-only, like onion+garlic+meat, into a "dessert").
2. DESSERT RULE (strict): only produce a recipe with meal_type "dessert" if the available ingredients genuinely support making something sweet — i.e. at least one clearly sweet ingredient (fruit, honey, sugar, chocolate, jam, etc.) OR at least two baking-base ingredients together (e.g. flour+egg, or butter+sugar). If the ingredient list is entirely savory (vegetables, meat, fish, rice, pasta, cheese, alliums) with nothing sweet-compatible, DO NOT include a dessert at all — simply return fewer recipes covering only the meal types that make sense. Never force a dessert into the output just to fill a slot.
3. Diet tags in "diets" must be factually true for the exact recipe you wrote, not assumed:
   - "vegan" only if there is no meat, fish, dairy, egg, or honey in the recipe.
   - "vegetarian" only if there is no meat or fish.
   - "lactose-free" only if there is no milk, cheese, butter, cream, or yogurt.
   - "gluten-free" only if there is no wheat flour, pasta, bread, or similar gluten-containing ingredient.
   - "high-protein" only if protein is genuinely high for the dish (roughly 15g+ per serving).
   - "low-cal" only if calories are genuinely modest (roughly under 400 kcal per serving).
   If a diet filter was requested and the ingredients cannot honestly satisfy it, adapt the recipe (e.g. suggest a dairy-free substitution) rather than mislabeling it — and only claim the tag if the adapted version truly satisfies it.
4. Use realistic, non-invented calorie/macro estimates — round numbers, no false precision.
5. "uses" must only list ingredients that were actually given to you. "extra_needed" is for anything genuinely missing that isn't a basic staple (salt, pepper, oil, water don't need to be listed).
6. Even with a fairly ordinary, savory-only ingredient list, you should almost always be able to produce at least 1-2 sensible everyday recipes (e.g. a simple sandwich, salad, pita, stir-fry, pasta, or grain bowl) — reserve returning zero recipes for genuinely unworkable or near-empty ingredient lists. Never sacrifice culinary or dietary honesty to hit a target count, but do not be overly conservative either.
7. Respond with EXACTLY one JSON array and nothing else: no markdown code fences, no leading sentence like "Here are the recipes", no trailing commentary, no explanation of your reasoning. The very first character of your reply must be "[" and the very last character must be "]". Each element:
{"title": string, "time_minutes": number, "difficulty": "easy"|"medium"|"hard", "meal_type": "breakfast"|"lunch"|"dinner"|"snack"|"dessert", "uses": string[], "extra_needed": string[], "instructions": string[], "calories": number, "protein": number, "carbs": number, "fat": number, "is_local": boolean, "diets": string[]}`;

    const userMsg = `Available ingredients:
${ingredientLines}

${filterLines.length ? 'Filters:\n' + filterLines.join('\n') : 'No specific filters — aim for a variety: one snack, one lunch, one dinner, and a dessert ONLY if rule 2 allows it.'}

Return 2-4 recipes as a JSON array following the schema exactly.`;

    const text = await callClaude([{ role: 'user', content: userMsg }], 2200, system);

    let parsed;
    try {
      parsed = extractJson(text, 'array');
    } catch (parseErr) {
      console.error('[recipes] JSON parse failed. Raw model output:', text);
      throw parseErr;
    }
    res.json(Array.isArray(parsed) ? parsed : []);
  } catch (err) {
    console.error('[recipes] failed:', err.message);
    res.status(500).json({ error: 'recipes failed', detail: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, hasKey: !!API_KEY }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WWCT backend running on port ${PORT}`));
