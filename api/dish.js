import Anthropic from "@anthropic-ai/sdk";
import { MongoClient } from "mongodb";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

const STEP_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [
        "wash",
        "peel",
        "dice",
        "slice",
        "mince",
        "grate",
        "measure",
        "marinate",
        "mix",
        "preheat",
        "boil",
        "simmer",
        "fry",
        "roast",
        "bake",
        "rest",
        "blend",
        "plate",
      ],
    },
    object: { type: "string" },
    setupMin: { type: "number" },
    perUnitMin: { type: "number" },
    units: { type: "number" },
    resource: {
      type: "string",
      enum: ["hands", "hob", "oven", "blender", "passive"],
    },
    mergeable: { type: "boolean" },
    dependsOn: { type: "array", items: { type: "number" } },
  },
  required: [
    "action",
    "object",
    "setupMin",
    "perUnitMin",
    "units",
    "resource",
    "mergeable",
    "dependsOn",
  ],
  additionalProperties: false,
};

// Section 9, prompt requirements: covers every bullet in that list.
function buildPrompt(dishName) {
  return `You are helping a cooking app break a dish into a timed sequence of steps.

Dish: "${dishName}"

First decide whether this is a real dish that people actually cook. If it is
not a food/dish at all (gibberish, an object, a person, an empty or
nonsensical string), set "valid" to false, "canonicalName" to your best guess
at what was typed, and return an empty "steps" array. Do not invent a recipe
for something that isn't a dish.

If it is a real dish:
- Set "valid" to true.
- Set "canonicalName" to the commonly-used name for the dish, spelling
  corrected, all lowercase (e.g. "chiken tikka masla" -> "chicken tikka
  masala").
- Break the dish into 4 to 10 steps for one standard portion, covering the
  full process from raw ingredients to plating.
- For each step:
  - "action" must be exactly one of: wash, peel, dice, slice, mince, grate,
    measure, marinate, mix, preheat, boil, simmer, fry, roast, bake, rest,
    blend, plate.
  - "object" must be a singular, lowercase noun with no adjectives (e.g.
    "onion", not "finely chopped red onions") — this field is used as a
    literal string match to combine identical prep steps across dishes, so
    adjectives and plurals will break that matching.
  - "setupMin" is the fixed cost paid once for this step regardless of
    quantity (e.g. fetching a cutting board and knife); "perUnitMin" is the
    additional cost per unit. Separate these honestly rather than lumping
    everything into one number.
  - "units" is a small discrete count of distinct pieces this step handles —
    e.g. 1 onion, 2 eggs, 3 garlic cloves. It is never a weight, volume, or
    percentage (never grams, ounces, cups, or a number like 200 or 500). If
    the ingredient isn't naturally counted in discrete pieces (a cut of
    meat, a portion of rice, a cup of cream, a spoonful of a spice), always
    use "units": 1 and put the entire prep time for that ingredient into
    "setupMin" rather than scaling it by a quantity. This keeps
    "perUnitMin" a small, comparable per-piece cost — never a cost meant to
    be multiplied by hundreds.
  - "resource" must be exactly one of: hands, hob, oven, blender, passive.
    "passive" means the step needs no attention (marinating, resting,
    cooling).
  - "mergeable" should be false only when preparing this early would degrade
    the result (e.g. whipping cream, dressing a salad, toasting nuts) — true
    otherwise.
  - "dependsOn" is an array of indices (0-based) into this dish's own steps
    array, naming which earlier steps must finish before this one can start.
    Include every real prerequisite, not just the obviously load-bearing
    ones — a step that washes, peels, or otherwise prepares an ingredient
    is a dependency of every later step that handles that ingredient, even
    if it doesn't feel "blocking". A prep step with nothing depending on it
    has no scheduling reason to happen before anything else, and a low-cost
    step nothing depends on is exactly the kind the scheduler will delay
    until last — which is wrong if the dish still needs it done early (e.g.
    the chicken must be washed before it's seasoned or cooked, so "roast
    chicken" must depend on "wash chicken", not just on preheating and
    seasoning).
  - Describe only what this one dish needs, one step at a time. Never reason
    about how many burners, ovens, or cooks are available — that capacity is
    applied later by a separate scheduler.
  - If this step preheats an oven, encode the temperature in "object" as
    "oven_<temperature>c" (lowercase, no spaces, no degree symbol), e.g.
    "oven_200c".

Return only the structured output — no prose.`;
}

// Section 12: cache the connection in a module-level global.
let cached = global._mongo;
if (!cached) cached = global._mongo = { conn: null, promise: null };

async function getDishes() {
  if (!cached.promise) {
    cached.promise = MongoClient.connect(process.env.MONGODB_URI).then((mongo) => mongo.db("mise"));
  }
  cached.conn = await cached.promise;
  return cached.conn.collection("dishes");
}

// Section 5.6: trim, lowercase, collapse whitespace. Never touch spelling.
function normalizeDishName(raw) {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { dishName } = req.body ?? {};
  if (typeof dishName !== "string" || dishName.trim().length === 0) {
    res.status(400).json({ error: "dishName must be a non-empty string" });
    return;
  }

  const normalized = normalizeDishName(dishName);

  try {
    const dishes = await getDishes();

    // Fast path: exact repeat of a previously normalized/cached name.
    const existing = await dishes.findOne({ _id: normalized });
    if (existing) {
      res.status(200).json({ dish: existing._id, steps: existing.steps });
      return;
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      res.status(503).json({ error: "Live lookup is unavailable" });
      return;
    }

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [{ role: "user", content: buildPrompt(normalized) }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              valid: { type: "boolean" },
              canonicalName: { type: "string" },
              steps: { type: "array", items: STEP_SCHEMA },
            },
            required: ["valid", "canonicalName", "steps"],
            additionalProperties: false,
          },
        },
      },
    });

    const parsed = JSON.parse(response.content.find((b) => b.type === "text").text);

    if (!parsed.valid) {
      res.status(422).json({ valid: false, canonicalName: parsed.canonicalName, steps: [] });
      return;
    }

    // Gotcha #3: lowercase action/object before they ever reach Mongo, since
    // they're the merge key and structured-output capitalization isn't
    // guaranteed to match the schema's enum casing.
    const canonicalName = normalizeDishName(parsed.canonicalName);
    // Gotcha #6: minimums aren't enforceable in the structured-output
    // schema, so a degenerate zero-duration step (setupMin and perUnitMin
    // both 0) has to be caught here instead.
    const steps = parsed.steps.map((step) => {
      const lowered = { ...step, action: step.action.toLowerCase(), object: step.object.toLowerCase() };
      if (lowered.setupMin + lowered.perUnitMin * lowered.units <= 0) {
        lowered.setupMin = 1;
      }
      return lowered;
    });

    // Second cache check, under the canonical name, so a typo and its
    // corrected spelling don't produce two documents (Section 9).
    const canonicalExisting = await dishes.findOne({ _id: canonicalName });
    if (canonicalExisting) {
      res.status(200).json({ dish: canonicalExisting._id, steps: canonicalExisting.steps });
      return;
    }

    const doc = { _id: canonicalName, steps, source: "claude", createdAt: new Date() };
    // upsert rather than insertOne: two concurrent requests for the same new
    // dish would otherwise race on the same _id and one would throw.
    await dishes.replaceOne({ _id: canonicalName }, doc, { upsert: true });

    res.status(200).json({ dish: canonicalName, steps });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unexpected server error" });
  }
}
