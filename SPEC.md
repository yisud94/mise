# SPEC.md — Mise

A cooking timeline optimizer. Built solo in an 18-hour hackathon.

---

## 0. How to use this document

Read the whole file before writing any code.

This spec is written for an AI coding agent. It is deliberately prescriptive.
Where it gives exact code, use that code — do not "improve" it. Where it gives
a data shape, treat it as frozen. Sections marked **FROZEN** are load-bearing:
changing them silently breaks the demo.

Work through Section 8 (Build Phases) in order. Each phase has a checkpoint.
**Do not start a phase until the previous checkpoint passes.** If a checkpoint
fails, fix it before moving on — do not accumulate broken layers.

If something in this spec seems wrong or impossible, stop and say so rather
than silently substituting your own approach.

---

## 1. What the project is

The user tells the app which dishes they're cooking and when they want to eat.
The app returns a single unified timeline telling them what to do and when, so
that everything finishes at the same moment.

The total time is less than the sum of the dishes' individual times, for two
separate reasons:

1. **Parallelism** — the oven roasts while the hob simmers. Steps using
   different resources overlap.
2. **Batching** — three dishes each need diced onion, so you dice all the onion
   once instead of three times.

The app computes both savings, attributes them separately, and displays them.
That attributed number is the product. Everything else is packaging.

Dish breakdowns come from the Claude API and are cached in MongoDB.

---

## 2. Non-goals

Do not build any of these. They are out of scope, and adding them costs time
that the project does not have.

- User accounts, authentication, login, sessions
- Recipe editing, saving, sharing, favouriting
- Shopping lists, nutrition info, dietary filters, substitutions
- Multi-user / realtime / collaborative anything
- Mobile-responsive polish beyond "does not look broken on a phone"
- A router. There are two screens; use a state variable.
- A state management library. `useState` in `App.jsx` is sufficient.
- An exact/optimal scheduler (ILP, constraint solver, branch and bound).
  Greedy is specified in Section 6 and is what we want.
- Dark mode, animations, onboarding, empty-state illustrations
- Tests beyond the two algorithm test files named in Section 8

If you find yourself writing an abstraction to support a future case, stop.
There is no future case. The demo is tomorrow.

---

## 3. Stack

| Layer   | Choice                      | Note                                                               |
| ------- | --------------------------- | ------------------------------------------------------------------ |
| Build   | Vite                        | `npm create vite@latest -- --template react`                       |
| UI      | React + Mantine             | Mantine supplies all visual defaults. Do not add Tailwind.         |
| Charts  | Hand-rolled divs            | The Gantt is absolute-positioned divs. Do not add a chart library. |
| Backend | Vercel serverless functions | `/api/*.js` at repo root                                           |
| DB      | MongoDB Atlas (free tier)   | One collection                                                     |
| LLM     | Claude API                  | Exact call shape in Section 7                                      |

### File tree

```
/api
  dish.js              # POST { dishName } -> { dish, steps }
/src
  App.jsx              # screen state, holds the trip through the app
  main.jsx
  data/
    seed.json          # pre-cached dish breakdowns (Section 9)
  lib/
    merge.js           # batching pass
    merge.test.js
    schedule.js        # greedy scheduler
    schedule.test.js
    resources.js       # resource capacity table
  screens/
    PickDishes.jsx
    Timeline.jsx
  components/
    Gantt.jsx
    SavingsBanner.jsx
```

---

## 4. Data model — **FROZEN**

### Step

Every step in the system has this exact shape. Do not add fields. Do not rename
fields. Do not collapse `setupMin` and `perUnitMin` into a single `duration` —
the split is what makes batching computable.

```js
{
  action:     "dice",      // enum, see below. lowercase.
  object:     "onion",     // singular lowercase noun, no adjectives
  setupMin:   1,           // fixed cost paid once, regardless of quantity
  perUnitMin: 2,           // cost per unit
  units:      1,           // quantity
  resource:   "hands",     // enum, see below
  mergeable:  true,        // false if batching would degrade the result
  dependsOn:  []           // array of indices into this dish's own steps array
}
```

Duration of a step: `setupMin + (perUnitMin * units)`.

**`action` enum** (exactly these, lowercase):

```
wash, peel, dice, slice, mince, grate, measure, marinate, mix,
preheat, boil, simmer, fry, roast, bake, rest, blend, plate
```

**`resource` enum** (exactly these, lowercase):

```
hands, hob, oven, blender, passive
```

`passive` means the step needs no attention — marinating, resting dough,
cooling. Passive steps never conflict with anything.

**`mergeable`** is set by the model, not by hardcoded rules. It should be
`false` where making something early ruins it: whipped cream, dressed salad,
toasted nuts that go soft. Your merge pass respects this flag.

### Oven temperature convention

Preheat steps encode the temperature in the object:

```js
{ action: "preheat", object: "oven_200c", resource: "oven", ... }
```

Two dishes at 200°C merge automatically under the normal merge rule. Two
dishes at different temperatures do not merge, and the scheduler will serialise
them on the `oven` resource. This is intentional and is a feature we surface in
the UI — do not "fix" it by normalising temperatures together.

### Resource capacity — `src/lib/resources.js`

```js
export const CAPACITY = {
  hands: 1,
  hob: 4, // four burners
  oven: 1,
  blender: 1,
  passive: Infinity,
};
```

The scheduler must respect these. A naive "one step per resource" model is
wrong — it will serialise four pots that could sit on four burners and your
optimised number will be badly inflated.

### Dish document (MongoDB)

```js
{
  _id:       "chicken biryani",   // normalized: trimmed, lowercased, single-spaced
  steps:     [ /* Step objects */ ],
  source:    "claude" | "seed",
  createdAt: ISODate()
}
```

---

## 5. The merge pass — `src/lib/merge.js`

Input: a flat array of steps from all selected dishes, each tagged with which
dish it came from. Output: a new array where batchable steps have been combined.

### Rules

A group of steps merges if and only if **all** of these hold:

- Same `action` **compared case-insensitively** (see Section 7 gotcha #3)
- Same `object`, compared case-insensitively
- `resource === "hands"` — only prep work batches. Cooking steps do not merge;
  two pans are two pans.
- Every step in the group has `mergeable: true`

### Merged step construction

```
units      = sum of all units in the group
setupMin   = setupMin of the group (they are identical by definition)
perUnitMin = perUnitMin of the group
duration   = setupMin + (perUnitMin * totalUnits)
dependsOn  = union of the group's dependencies
dependents = union of the group's dependents
dishes     = array of every dish that contributed (for UI display)
```

### The saving formula

```
batchSaving = (groupSize - 1) * setupMin,  summed over all merged groups
```

Return this number alongside the merged array. The UI needs it.

### Caveat to preserve

Merging pulls work earlier in the schedule for whichever dish needed it later.
This is correct for onions and wrong for delicate things, which is exactly what
`mergeable: false` is for. Do not add heuristics on top of the flag.

---

## 6. The scheduler — `src/lib/schedule.js`

**Schedule forward from t = 0.** Do not attempt to schedule backwards from the
serving time. Compute the makespan, then the UI displays
`startTime = serveTime − makespan`. Identical result, far simpler code.

### Algorithm — greedy list scheduling

1. Build the dependency graph over merged steps.
2. Topologically sort. If a cycle exists, throw with the offending step names.
3. For each step compute **slack** = (longest path from this step to any end
   step). Sort the ready-list by least slack first — critical path steps go
   first.
4. Walk the list. Place each step at the earliest time `t` where:
   - all its dependencies have finished, **and**
   - its resource has spare capacity for the whole duration
     (count concurrent steps on that resource at `t`; must be `< CAPACITY[r]`)
5. `makespan` = max end time across all steps.

### Output shape

```js
{
  scheduled: [ { ...step, startMin, endMin } ],
  makespan: 30,
  sequentialTotal: 46,
  batchSaving: 1,
  parallelSaving: 15      // sequentialTotal - batchSaving - makespan
}
```

`sequentialTotal` is the sum of the durations of the **unmerged** steps. It is
the "if you did everything one at a time" baseline. Compute it before merging.

### Worked example — use this as your test fixture

Two dishes, each needing one diced onion.

**tomato pasta**
| step | action | object | setup | perUnit | units | resource | deps |
|---|---|---|---|---|---|---|---|
| A1 | dice | onion | 1 | 2 | 1 | hands | — |
| A2 | simmer | sauce | 1 | 14 | 1 | hob | A1 |

**dal**
| step | action | object | setup | perUnit | units | resource | deps |
|---|---|---|---|---|---|---|---|
| B1 | dice | onion | 1 | 2 | 1 | hands | — |
| B2 | simmer | dal | 1 | 24 | 1 | hob | B1 |

Expected results:

```
sequentialTotal = 3 + 15 + 3 + 25          = 46
merged dice onion = 1 + (2 * 2 units)      = 5 min
batchSaving      = (2 - 1) * 1             = 1
schedule: M1 hands 0->5, A2 hob 5->20, B2 hob 5->30
makespan                                   = 30
parallelSaving   = 46 - 1 - 30             = 15
```

Both simmers run concurrently because `CAPACITY.hob === 4`. If your scheduler
returns a makespan of 45, you have ignored resource capacity.

**Write `merge.test.js` and `schedule.test.js` against these exact numbers
before building any UI.** The algorithm is the product; it must be correct
before anything is drawn on screen.

---

## 7. Claude API integration — `/api/dish.js`

### Request shape — use exactly this

```js
import Anthropic from "@anthropic-ai/sdk";

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

const response = await client.messages.create({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 2048,
  messages: [{ role: "user", content: buildPrompt(dishName) }],
  output_config: {
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          dish: { type: "string" },
          steps: { type: "array", items: STEP_SCHEMA },
        },
        required: ["dish", "steps"],
        additionalProperties: false,
      },
    },
  },
});

const parsed = JSON.parse(response.content.find((b) => b.type === "text").text);
```

### Prompt requirements

The prompt must instruct the model to:

- Break the dish into 4–10 steps for one standard portion
- Use `object` as a singular lowercase noun with no adjectives —
  `"onion"` not `"finely chopped red onions"`. Merging is a string match;
  adjectives break it.
- Separate fixed setup cost from per-unit cost honestly. Dicing one onion:
  `setupMin` covers fetching the board and knife; `perUnitMin` is the dicing.
- Set `mergeable: false` for steps whose output degrades if prepared early
- Encode oven preheats as `object: "oven_200c"` (lowercase, no spaces)
- Use `dependsOn` indices referring to positions in this dish's own steps array

### Gotchas — these will cost you hours if ignored

1. **The parameter is `output_config.format`, not `output_format`.** The older
   `output_format` name and the `structured-outputs-2025-11-13` beta header are
   legacy. Use `output_config.format` with no beta header.

2. **Every object in the schema needs `additionalProperties: false`.** Omitting
   it returns a 400.

3. **Enum capitalization is not guaranteed.** Structured outputs may return a
   value that differs from the schema only in capitalization. Since `action`
   and `object` form the merge key, a stray `"Dice"` would silently fail to
   batch and quietly shrink the headline number. **Lowercase `action` and
   `object` on the way out of the API handler, before writing to MongoDB.**

4. **Do not change the schema on demo day.** The first request with a given
   schema pays extra latency while the grammar compiles; compiled grammars are
   then cached for 24 hours from last use. Freeze the schema early.

5. **The API key must never reach the browser bundle.** It lives in a Vercel
   environment variable and is read only inside `/api/dish.js`. Do not add
   `VITE_` to its name — that prefix exposes it to the client.

6. **Numerical constraints like `minimum` / `maximum` are not supported** in
   structured output schemas. Do not add them; validate in JS instead.

---

## 8. Build phases

### Phase 1 — Skeleton and deploy (target: 1h)

Scaffold Vite + React + Mantine. Two screens switched by
`const [screen, setScreen] = useState("pick")`. **Deploy to Vercel now**, while
it is empty and the deploy is trivial to debug.

> **Checkpoint 1:** A live Vercel URL renders a Mantine button. Do not proceed
> until this is true.

### Phase 2 — Algorithms, with tests, no UI (target: 3h)

Write `resources.js`, `merge.js`, `schedule.js`, and their two test files.
Use the Section 6 worked example as the fixture. Run the tests from the
command line.

> **Checkpoint 2:** `merge.test.js` and `schedule.test.js` both pass, producing
> `sequentialTotal: 46, batchSaving: 1, makespan: 30, parallelSaving: 15`.
> No React code has been written yet. Do not proceed until this is true.

### Phase 3 — Seed data and the pick screen (target: 2h)

Load `seed.json` (Section 9). Build `PickDishes.jsx`: a multi-select of seeded
dish names, plus a serving-time input. On submit, run merge + schedule and log
the result object to the console.

> **Checkpoint 3:** Selecting three seeded dishes logs a valid schedule object
> with a makespan lower than `sequentialTotal`.

### Phase 4 — Timeline and Gantt (target: 4h)

`Timeline.jsx` renders `SavingsBanner.jsx` and `Gantt.jsx`.

The Gantt is absolute-positioned divs: one row per resource, one bar per step,
`left: startMin * PX_PER_MIN`, `width: duration * PX_PER_MIN`. Colour bars by
source dish. Merged steps get a visual marker and list their contributing
dishes on hover or tap.

The savings banner is the single most important element on screen:

```
Sequential: 46 min  →  Optimized: 30 min
1 min saved by batching 1 shared prep step
15 min saved by overlapping
```

> **Checkpoint 4:** Three seeded dishes produce a readable Gantt chart and a
> correct savings banner.

### Phase 5 — Live API and cache (target: 2h)

Build `/api/dish.js`. Flow: normalize the dish name → look up in MongoDB →
on miss, call Claude → lowercase `action`/`object` → write to MongoDB →
return. Wire a free-text "add any dish" input into the pick screen.

> **Checkpoint 5:** Typing a dish not in the seed returns a breakdown within
> ~5s, and typing the same dish again returns instantly from the cache.

### Phase 6 — Failure handling (target: 1h)

If the Claude call fails or times out, the app must degrade gracefully: show a
clear message and keep every seeded dish working. **The demo must survive the
API being unreachable.** This is a stated feature, not just defensive coding.

> **Checkpoint 6:** With the `ANTHROPIC_API_KEY` env var deliberately removed,
> the app still fully works using seeded dishes.

### Phase 7 — Polish (target: 2h)

One accent colour. Consistent spacing. Readable type. Nothing else.

### Remaining hours: buffer

Do not start new features with leftover time. Re-test and rehearse instead.

---

## 9. Seed data — `src/data/seed.json`

Pre-cache **15 dishes** so the app is fully demonstrable with no network.
Include deliberate overlap so batching has something to find — at least four
dishes should need diced onion, and at least three should need a 200°C oven.

Suggested set: tomato pasta, dal, roast chicken, roast potatoes, garlic bread,
green salad, rice pilaf, chicken curry, miso soup, stir-fried greens,
shepherd's pie, roasted carrots, guacamole, scrambled eggs, apple crumble.

Generate these by running the Phase 5 endpoint once each, then commit the
output. Seed documents get `source: "seed"`.

---

## 10. MongoDB notes

Serverless functions must **cache the connection in a module-level global**, or
you will exhaust the Atlas connection limit after a few dozen requests:

```js
let cached = global._mongo;
if (!cached) cached = global._mongo = { conn: null, promise: null };
// reuse cached.conn if present; otherwise await cached.promise
```

Atlas free tier requires an IP allowlist entry of `0.0.0.0/0` for Vercel
functions to connect. Set this early — it is a silent failure otherwise.

---

## 11. Definition of done

- [ ] Live URL, works on a phone
- [ ] Both algorithm test files pass
- [ ] Three seeded dishes produce a correct Gantt and savings banner
- [ ] An arbitrary typed dish is fetched from Claude and cached
- [ ] A second request for that dish is served from MongoDB
- [ ] Removing the API key does not break the seeded flow
- [ ] Oven temperature conflicts are visible in the timeline
- [ ] The savings banner attributes batching and parallelism separately

---

## 12. If you get stuck

State the blocker plainly and propose the smallest change that unblocks it.
Prefer cutting scope over inventing architecture. In priority order, the things
to cut are: oven-conflict display, then the live API path (fall back to seed
only), then the number of seeded dishes.

The merge pass, the scheduler, and the savings banner are the project. They do
not get cut.
