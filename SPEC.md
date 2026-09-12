# SPEC.md — Mise

A cooking timeline optimizer. Built solo in an 18-hour hackathon.

---

## 0. How to use this document

Read the whole file before writing any code.

This spec is written for an AI coding agent. It is deliberately prescriptive.
Where it gives exact code, use that code — do not "improve" it. Where it gives
a data shape, treat it as frozen. Sections marked **FROZEN** are load-bearing:
changing them silently breaks the demo.

Work through Section 10 (Build Phases) in order. Each phase has a checkpoint.
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
  Greedy is specified in Section 7 and is what we want.
- Dark mode, animations, onboarding, empty-state illustrations
- Tests beyond the two algorithm test files named in Section 10
- Modelling pans, pots, trays, or mixing bowls as resources. Only the five
  resources in the enum exist. See the note at the end of Section 4.

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
| LLM     | Claude API                  | Exact call shape in Section 9                                      |

### File tree

```
/api
  dish.js              # POST { dishName } -> { dish, steps }
/src
  App.jsx              # screen state, holds the trip through the app
  main.jsx
  data/
    seed.json          # pre-cached dish breakdowns (Section 11)
  lib/
    merge.js           # batching pass
    merge.test.js
    schedule.js        # greedy scheduler
    schedule.test.js
    resources.js       # default resource capacity table
  screens/
    PickDishes.jsx
    Timeline.jsx
  components/
    Gantt.jsx
    SavingsBanner.jsx
    KitchenPanel.jsx
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

Kitchens differ. Capacity is therefore **a parameter, not a constant**. The
table below is the default used when the caller supplies nothing.

```js
export const DEFAULT_CAPACITY = {
  hands: 1, // one cook
  hob: 4, // four burners
  oven: 1,
  blender: 1,
  passive: Infinity,
};
```

The scheduler must respect these. A naive "one step per resource" model is
wrong — it will serialise four pots that could sit on four burners and your
optimised number will be badly inflated.

**Never read this table directly inside `schedule.js`.** It is passed in as an
argument (Section 7) and may be overridden by the user (Section 8.9). A
scheduler that imports the constant works identically today and is a painful
refactor tomorrow.

The errors here are asymmetric, which is why the defaults are what they are.
Assuming fewer appliances than the user has produces a conservative schedule
and they finish early. Assuming more produces an optimistic schedule and they
fall behind. When a default is uncertain, err low.

**Known limitation — do not fix.** The real constraint on the hob is often
pans rather than burners, and pans are not modelled. Three dishes each wanting
a saucepan will schedule concurrently even if the user owns two. Modelling
vessels separately from heat sources roughly doubles the resource logic for
marginal realism, so it is a stated non-goal. Leave it.

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

## 5. Implementation Contracts & Clarifications

This section resolves implementation details that are intentionally not left to agent judgment. These rules are part of the specification.

### 5.1 Step identity and dependency remapping

`dependsOn` indices refer to positions in the original dish's `steps` array.

Before flattening or merging steps, assign every step an internal identity. This identity is implementation-only and must not be persisted as part of the frozen Step schema.

When steps are merged:

1. Create one merged step representing the group.
2. Map every original step in the group to that merged step.
3. Rewrite every dependency in every downstream step through this mapping.
4. If a dependency points to a step that was merged, the dependent step must depend on the merged step instead.
5. Remove duplicate dependencies after remapping.
6. A step must never depend on itself after remapping.

Example:

```text
Dish A:
A1 = dice onion
A2 = simmer sauce, dependsOn [A1]

Dish B:
B1 = dice onion
B2 = simmer dal, dependsOn [B1]
```

After merging:

```text
M1 = dice onion, representing [A1, B1]

A2 dependsOn M1
B2 dependsOn M1
```

The dependency graph must therefore be constructed **after** the merge mapping has been applied.

### 5.2 Frozen Step schema vs internal scheduling fields

The Step schema in Section 4 is the persisted/API schema and is frozen.

Internal implementation may maintain additional metadata needed for computation, including:

- stable internal step identity
- original dish name
- original step index
- merged-step membership
- dependency/dependent references
- computed duration

These fields must not be written to `seed.json`, MongoDB, or the Claude structured-output schema unless explicitly specified elsewhere.

`duration` is always computed as:

```text
setupMin + (perUnitMin * units)
```

It does not become a persisted Step field.

For UI purposes, a merged step may additionally retain its contributing `dishes` list as internal/display metadata.

### 5.3 Resource capacity is checked across the entire interval

A scheduled step occupies its resource continuously from:

```text
[startMin, endMin)
```

Resource capacity must be valid for the **entire interval**, not merely at the candidate start time.

A candidate placement is valid only when, at every point during the step's duration:

```text
number of concurrent steps on resource < CAPACITY[resource]
```

Steps ending at exactly `startMin` do not count as concurrent.

Example:

```text
CAPACITY.hob = 2

Existing A: 0 → 10
Existing B: 5 → 20
Candidate C: duration 15
```

C cannot start at 0 because the interval 5 → 10 would contain three hob steps.

### 5.4 Scheduler candidate times

For each step, begin searching at:

```text
max(endMin of all dependencies)
```

If the resource cannot accommodate the step for its entire duration, advance the candidate start time to the next relevant resource-availability boundary rather than incrementing time one minute at a time.

The scheduler must select the earliest valid start time.

All scheduling times are integer minutes.

### 5.5 Scheduler tie-breaking

For scheduler prioritization, slack means the remaining critical-path length from a step to the end of the dependency graph. It is a static DAG property computed before scheduling begins; it is not deadline slack or dynamic scheduling slack.

For each step:

```text
if dependents(step) is empty:
    slack(step) = duration(step)
else:
    slack(step) = duration(step) + max( slack(d) for d in dependents(step) )
```

Thus, slack(step) is the total duration of the longest dependency path beginning at that step and ending at any terminal step, including the duration of the step itself.

Worked example:

```text
A (3 min) → B (15 min) → end
C (5 min) → end

slack(B) = 15                 (no dependents)
slack(A) = 3 + 15 = 18
slack(C) = 5

Scheduling order: A (18), B (15), C (5)
```

Note the direction: a step on the **longest** remaining path has the **largest** slack value under this definition, and is scheduled **first**. This is the opposite of "slack" in classical scheduling literature, where slack means spare time and less is more urgent. The definition in this section is the one the implementation must use.

When multiple steps are ready to schedule, sort them by:

1. **Descending slack** — steps on the longest remaining critical path are scheduled first.
2. **Original flattened input order** — the deterministic tie-breaker when slack values are equal.

The scheduler must produce deterministic output: identical input steps and dependencies must produce identical scheduling results.

### 5.6 Dish-name normalization

The normalized cache key is produced by:

1. trimming leading and trailing whitespace;
2. converting to lowercase;
3. replacing every run of whitespace characters with a single space.

Do not remove punctuation, rewrite spelling, or otherwise alter the user's input during this normalization step.

For example:

```text
"  Chicken   Curry  "
→ "chicken curry"
```

Canonical correction of misspellings is the responsibility of the Claude API and occurs separately.

### 5.7 `/api/dish` request and response contract

The endpoint accepts:

```http
POST /api/dish
Content-Type: application/json
```

with:

```json
{
  "dishName": "chicken curry"
}
```

A successful response is:

```json
{
  "dish": "chicken curry",
  "steps": [
    /* Step objects */
  ]
}
```

For a valid Claude response, `dish` is the returned `canonicalName`.

For invalid dish input, return HTTP `422`:

```json
{
  "valid": false,
  "canonicalName": "asdfgh",
  "steps": []
}
```

For a missing/unavailable Claude API key, return HTTP `503`.

For unexpected server/API failures, return HTTP `500`.

The frontend should use the HTTP status to distinguish these cases and display the copy specified in Section 8.4.

The endpoint must reject requests that do not contain a non-empty string `dishName`.

### 5.8 MongoDB configuration

Use the following environment variable:

```text
MONGODB_URI
```

The database name is:

```text
mise
```

The single collection is:

```text
dishes
```

The normalized dish name is used as the MongoDB document `_id`.

The MongoDB connection must be cached at module scope as described in Section 12.

### 5.9 Seed-data shape

`src/data/seed.json` contains an array of dish documents using the same shape as the MongoDB dish document:

```json
[
  {
    "_id": "tomato pasta",
    "steps": [
      /* Step objects */
    ],
    "source": "seed"
  }
]
```

`createdAt` is not required in `seed.json`; it is a MongoDB persistence field.

The frontend seed lookup uses the normalized `_id` value.

### 5.10 Error-state scheduling

When the user has a mixture of ready and errored dishes, only dishes with:

```text
status === "ready"
```

are included when building the timeline.

Errored dishes remain visible on the pick screen and are never silently removed.

Therefore:

```text
ready + error + error
```

produces a timeline using the one ready dish.

If there are no ready dishes, the Build button is disabled and the message from Section 8.7 is shown.

### 5.11 Gantt rendering with resource capacity > 1

There is one logical Gantt row per resource.

Multiple steps may therefore overlap within the same resource row when the resource has capacity greater than one.

Within a row, overlapping bars should be vertically stacked into sub-lanes so that their labels remain readable. The row height may grow as necessary.

For example, four simultaneous hob steps occupy four visual sub-lanes inside the single `hob` resource row.

This visual stacking does not alter scheduling or resource capacity.

### 5.12 Merged-step visual priority

A normal scheduled step uses its source dish's assigned Mantine colour.

A merged step overrides this rule:

- use a neutral grey background;
- use a dashed border;
- show the contributing-dish count badge;
- expose the contributing dish names on tap/hover.

A merged step does not use one dish's colour because it represents work shared by multiple dishes.

### 5.13 Oven-conflict message

An oven conflict exists when scheduled/prepared oven steps contain more than one distinct `object` value of the form:

```text
oven_<temperature>c
```

Do not average, normalize, or otherwise alter temperatures.

The Timeline may construct the explanatory callout dynamically from the actual dish names and scheduled order.

At minimum, it must clearly communicate:

1. the distinct temperatures requested; and
2. that the oven work has been sequenced rather than run simultaneously.

Example:

```text
Your dishes want different oven temperatures (200°C and 180°C).
I've sequenced them so the oven changes temperature between dishes.
```

The exact dish-specific prose may be generated from the schedule; the scheduling result itself must remain deterministic.

### 5.14 Time representation

Internally, scheduling uses integer minutes relative to `t = 0`.

`serveTime` is represented as a JavaScript `Date`.

The default serve time is exactly two hours after the current time.

The displayed start time is:

```text
serveTime - makespan
```

If that time is in the past, still display it and additionally show the required "You'd have needed to start X minutes ago." message.

Crossing midnight is valid and must not be treated as an error.

### 5.15 Dish colour assignment

Assign colours using the fixed rotation:

```js
const DISH_COLORS = ["blue", "grape", "teal", "orange", "pink", "lime"];
```

The colour is assigned when the dish is added and stored on the Dish entry.

The colour must remain stable for that Dish entry across re-renders and while navigating between the two screens.

Removing a dish removes its colour assignment. A newly added dish receives the next colour according to the current insertion position in the list.

### 5.16 Determinism requirement

Given the same:

- selected dishes,
- Step data,
- dependencies,
- resource capacities,
- and serve time,

the merge and scheduling functions must produce the same result every time.

Do not use randomness, current time, API calls, or UI state inside `merge.js` or `schedule.js`.

The algorithm layer must be pure and independently testable.

## 6. The merge pass — `src/lib/merge.js`

Input: a flat array of steps from all selected dishes, each tagged with which
dish it came from. Output: a new array where batchable steps have been combined.

### Rules

A group of steps merges if and only if **all** of these hold:

- Same `action` **compared case-insensitively** (see Section 9 gotcha #3)
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

## 7. The scheduler — `src/lib/schedule.js`

**Schedule forward from t = 0.** Do not attempt to schedule backwards from the
serving time. Compute the makespan, then the UI displays
`startTime = serveTime − makespan`. Identical result, far simpler code.

### Signature — **FROZEN**

Capacity is an argument, never an import inside the algorithm. Write it this
way from the start, even though nothing overrides the default until
Section 8.9.

```js
import { DEFAULT_CAPACITY } from "./resources.js";

export function schedule(steps, capacity = DEFAULT_CAPACITY) { ... }
```

`merge.js` takes no capacity argument — batching is independent of how many
burners exist.

### Algorithm — greedy list scheduling

1. Build the dependency graph over merged steps.
2. Topologically sort. If a cycle exists, throw with the offending step names.
3. For each step compute **slack** exactly as defined in **Section 5.5** — the
   longest path from that step to any terminal step, including its own
   duration. Sort the ready-list by **descending slack**, so steps on the
   longest remaining critical path go first, breaking ties on original
   flattened input order. Section 5.5 is authoritative; do not infer the sort
   direction from the word "slack", which means the opposite in most
   scheduling literature.
4. Walk the list. Place each step at the earliest time `t` where:
   - all its dependencies have finished, **and**
   - its resource has spare capacity for the whole duration
     (count concurrent steps on that resource at `t`; must be
     `< capacity[r]`, read from the argument)
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

Two dishes, each needing one diced onion. Scheduled with `DEFAULT_CAPACITY`.

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

**After merging** (Section 6), the graph is three steps:

```
M1  dice onion   5 min   hands   deps: none        (merges A1 + B1)
A2  simmer sauce 15 min  hob     deps: M1
B2  simmer dal   25 min  hob     deps: M1
```

**Slack, per Section 5.5** — compute these by hand and check your
implementation produces the same values. Getting the sort direction wrong is
the most likely silent failure in this phase:

```
slack(A2) = 15                       (no dependents → own duration)
slack(B2) = 25                       (no dependents → own duration)
slack(M1) = 5 + max(15, 25) = 30

Scheduling order, descending slack:  M1 (30), B2 (25), A2 (15)
```

Note that **B2 is scheduled before A2**. If your order is M1, A2, B2, you have
sorted ascending and Section 5.5 is being violated.

**Expected results with `DEFAULT_CAPACITY`:**

```
sequentialTotal = 3 + 15 + 3 + 25          = 46
merged dice onion = 1 + (2 * 2 units)      = 5 min
batchSaving      = (2 - 1) * 1             = 1

schedule: M1 hands  0->5
          B2 hob    5->30
          A2 hob    5->20

makespan                                   = 30
parallelSaving   = 46 - 1 - 30             = 15
```

Both simmers run concurrently because `DEFAULT_CAPACITY.hob === 4`, so here
the sort order doesn't affect the times. If your scheduler returns a makespan
of 45, you have ignored resource capacity.

### Capacity test — also required

Run the same fixture with `{ ...DEFAULT_CAPACITY, hob: 1 }`. The two simmers
must now serialise, and B2 takes the hob first because its slack is higher:

```
schedule: M1 hands  0->5
          B2 hob    5->30
          A2 hob    30->45

makespan       = 45
batchSaving    = 1      (unchanged — batching is capacity-independent)
parallelSaving = 46 - 1 - 45 = 0
```

This test does double duty.

**It proves capacity is wired through as an argument** rather than read from
the module. A scheduler that ignores the parameter still returns 30 here and
looks correct on the first test alone.

**It is also the only check that catches a reversed slack sort.** Scheduling
A2 first would give `A2 5->20, B2 20->45` — a _different schedule with the
same makespan of 45_. Makespan alone cannot tell the two apart.

**Therefore `schedule.test.js` must assert per-step `startMin` and `endMin`
for all three steps in this case, not just the makespan and the savings.** An
assertion on makespan alone is a false green.

**Write `merge.test.js` and `schedule.test.js` against these exact numbers
before building any UI.** The algorithm is the product; it must be correct
before anything is drawn on screen.

---

## 8. Frontend — screens, states, and behaviour

Two screens, switched by `const [screen, setScreen] = useState("pick")`.
No router.

### 8.1 Global shape

All state lives in `App.jsx` and is passed down as props:

```js
const [screen, setScreen] = useState("pick"); // "pick" | "timeline"
const [dishes, setDishes] = useState([]); // see Dish entry below
const [serveTime, setServeTime] = useState(/* now + 2h */);
const [capacity, setCapacity] = useState(/* see 8.9 */);
const [result, setResult] = useState(null); // scheduler output
```

A **Dish entry** in the `dishes` array:

```js
{
  name:   "tomato pasta",   // canonical, lowercase
  steps:  [ /* Step objects */ ],
  status: "ready",          // "loading" | "ready" | "error"
  error:  null,             // user-facing message when status === "error"
  color:  "blue"            // Mantine colour name, assigned on add
}
```

Assign colours from a fixed rotation so a dish keeps the same colour between
the chip on screen one and its bars on screen two:

```js
const DISH_COLORS = ["blue", "grape", "teal", "orange", "pink", "lime"];
```

### 8.2 Screen one — Pick dishes

Single centred column, max width ~640px. Top to bottom:

1. **Title**: "Mise". Beneath it, one line of explanation:
   _"Tell me what you're cooking. I'll work out the order."_
2. **Serve time input** — Mantine `TimeInput`, labelled "I want to eat at".
   Default to two hours from now.
3. **Dish input** — Mantine `Autocomplete`, labelled "What are you making?",
   placeholder "Start typing a dish…". Its suggestions are the seeded dish
   names, but it must accept free text that isn't in the list. Submitting on
   Enter adds the dish; the field then clears and keeps focus so a user can
   type three dishes without touching the mouse.
4. **Selected dishes** — the `dishes` array rendered as Mantine `Chip`s or
   `Badge`s in the dish's colour, each with a remove "×".
5. **Kitchen panel** — collapsed by default. See 8.9.
6. **Primary button** — "Build my timeline". Disabled when `dishes` is empty
   or any dish has `status: "loading"`.

**Empty state.** With no dishes added, show three example chips beneath the
input — "tomato pasta", "roast chicken", "dal" — that add themselves on click.
A first-time user should be able to reach a timeline without typing anything.
Do not show an illustrated empty state or an onboarding tour.

**Limits.** Cap at **6 dishes**. On the seventh, disable the input and show
"That's plenty — six is the limit." Beyond six the Gantt becomes unreadable
and the point of the demo is lost.

**Duplicates.** If a dish is already in the list, don't add it again; briefly
highlight the existing chip instead.

### 8.3 Adding a dish — the full flow

This is the most state-heavy interaction in the app. Implement it exactly:

1. On submit, immediately push a chip with `status: "loading"` and the raw
   typed name. The UI must respond instantly, before any network call.
2. Look the normalized name up in `seed.json`. On a hit, set `status: "ready"`
   and stop — no network call at all.
3. On a miss, `POST /api/dish`. Show the chip with a small Mantine `Loader`
   and the text "Looking up…".
4. On success, replace the chip's name with the `canonicalName` returned by
   the API (see Section 9), store the steps, set `status: "ready"`.
5. On failure, set `status: "error"` with a message from the table in 8.4.

**Timeout.** Abort the request after **12 seconds** using an `AbortController`
and treat it as an error. Never let a hung request leave a chip spinning
forever — a frozen UI in front of judges is worse than an error message.

### 8.4 Error states — required copy

| Condition                            | Chip shows                                      | Behaviour                                                            |
| ------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------- |
| `valid: false` from API (not a dish) | "Not sure that's a dish"                        | Chip is removable, offers "try one of these" with 3 seed suggestions |
| Network failure / 500                | "Couldn't reach the server"                     | Chip has a retry button                                              |
| Timeout (12s)                        | "That took too long"                            | Chip has a retry button                                              |
| API key missing / 503                | "Live lookup is off — seeded dishes still work" | Shown once as a banner, not per-chip                                 |

Error chips are **never silently removed**. The user must see what failed and
choose to remove or retry. An error on one dish must not block building a
timeline from the others — the button stays enabled as long as at least one
dish is `ready`.

### 8.5 Screen two — Timeline

Top to bottom:

1. **Back link** — "← Change dishes". Preserves the `dishes` array so
   returning doesn't lose work.

2. **Savings banner** (`SavingsBanner.jsx`) — the most prominent element on
   the page. Larger than everything else.

   ```
   Sequential: 46 min  →  Optimized: 30 min

   1 min saved by batching 1 shared prep step
   15 min saved by overlapping
   ```

   The two saving lines must be separate and separately attributed. If
   `batchSaving === 0`, replace that line with "No shared prep in these
   dishes" rather than showing "0 min saved" — a zero reads as a bug.

3. **Start time** — one line, large: "Start cooking at 6:14 PM".
   Computed as `serveTime − makespan`.

4. **Gantt** (`Gantt.jsx`) — see 8.6.

5. **Step list** — every scheduled step in chronological order, as
   `6:14 — Dice onion (2 dishes) · 5 min`. This is the part someone would
   actually cook from, and it's about fifteen lines of code since you're
   just sorting `scheduled` by `startMin`. Do not build a live "current step"
   mode with timers; that is a non-goal.

### 8.6 The Gantt

Absolute-positioned divs inside a relatively-positioned container. No chart
library.

- **One row per resource**, in this fixed order: `hands, hob, oven, blender,
passive`. Omit any resource with no steps.
- Row label on the left, fixed width ~70px.
- `const PX_PER_MIN = 8;` — a 90-minute cook is then 720px wide. Let the
  container scroll horizontally rather than compressing.
- Each bar: `left: startMin * PX_PER_MIN`, `width: duration * PX_PER_MIN`,
  background in the source dish's colour.
- Time axis along the top, a label every 10 minutes.
- Bars shorter than ~40px can't hold a label. Show the text on hover/tap via
  a Mantine `Tooltip` instead of shrinking the font.

**Merged steps** get a visible marker — a dashed border and a count badge,
e.g. "Dice onion ×3". Colour them neutral grey rather than any single dish's
colour, since they belong to several. Tapping one lists the contributing
dishes. This is the visual proof of your headline number, so make it obvious.

**Oven conflicts.** If two or more `preheat` steps land on the oven with
different `object` values, render a callout above the Gantt:

> Your dishes want different oven temperatures (200°C and 180°C).
> I've sequenced them — roast potatoes go in after the chicken comes out.

Detect this in the Timeline component by grouping oven preheat steps by
`object`; if more than one distinct value exists, show the callout. This is a
scheduling reality the app surfaces rather than hides — do not "solve" it by
averaging temperatures.

### 8.7 Edge cases to handle explicitly

| Case                              | Required behaviour                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| One dish only                     | Works normally. Batch saving will be 0 — use the copy from 8.5.                        |
| Serve time in the past            | Still compute and show the timeline, with "You'd have needed to start 20 minutes ago." |
| All dishes errored                | Button disabled, message: "Add a dish that loaded successfully."                       |
| Makespan exceeds time until serve | Show the start time anyway, flagged in red. Don't block.                               |

### 8.8 Visual direction

One accent colour plus Mantine's defaults. Do not introduce a custom theme, a
font import, dark mode, or animation. The Gantt supplies all the visual
interest this project needs; everything else should be quiet enough not to
compete with it.

### 8.9 Kitchen panel — `KitchenPanel.jsx`

Kitchens differ, but asking about appliances up front taxes every user to
serve a minority. The panel is therefore **collapsed by default and never
blocks anything**.

**Collapsed** — one muted line beneath the dish chips, summarising the current
values and acting as the toggle:

```
🍳 My kitchen: 1 cook · 4 burners · 1 oven · 1 blender — adjust
```

**Expanded** — four Mantine `NumberInput` steppers, min 1, max 6:

| Label    | Key       | Default |
| -------- | --------- | ------- |
| Cooks    | `hands`   | 1       |
| Burners  | `hob`     | 4       |
| Ovens    | `oven`    | 1       |
| Blenders | `blender` | 1       |

`passive` is not shown and is always `Infinity`.

**Persistence.** Write the object to `localStorage` under `mise:capacity` on
change, and read it on mount, falling back to `DEFAULT_CAPACITY`. A user is
asked at most once, ever. This is the only permitted use of `localStorage` in
the project.

**Wiring.** The value is held in `App.jsx` as `capacity` and passed to
`schedule(steps, capacity)`. Nothing else reads it.

**Live re-solve.** Changing a value while on the Timeline screen must re-run
the scheduler and re-render the Gantt immediately, with no page reload. This
is the single most valuable thirty seconds of the demo: a judge asks "what if
I had two ovens?", you change the number, and the chart visibly re-solves in
front of them. Make the panel reachable from both screens for this reason.

**The interesting stepper is `hands`, not `oven`.** Setting cooks to 2 models
cooking with a partner and changes the schedule dramatically. Use that one
when demonstrating.

Do not add: appliance presets, a kitchen-setup wizard, per-appliance detail
(oven size, pan count), or any prompt encouraging users to open the panel.

---

## 9. Claude API integration — `/api/dish.js`

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
```

### Validity guard and canonical naming

Two fields exist to handle bad input, which is a frontend requirement from
section 8.4:

**`valid`** — `false` when the input isn't a dish anyone cooks ("asdfgh",
"my car", an empty string). The model returns `valid: false` with
`steps: []`, and the handler responds **422** with the canonical name echoed
back. Without this guard the model will cheerfully invent a plausible recipe
for nonsense input and the app will look broken in a subtle, hard-to-explain
way.

**`canonicalName`** — the corrected, normalized dish name. A user typing
"chiken tikka masla" gets back `"chicken tikka masala"`. Two benefits: the
chip on screen shows the corrected spelling, and — more importantly — **the
cache key is the canonical name, not the raw input.** Otherwise every typo
creates its own MongoDB document and a fresh API call, and your cache hit rate
collapses at exactly the moment a judge is typing.

Cache lookups therefore happen **twice**: once on the raw normalized input
(fast path, exact repeat), and once on the returned `canonicalName` before
writing, so you don't store a duplicate under a different spelling.

### Prompt requirements

The prompt must instruct the model to:

- Set `valid: false` and return an empty steps array for anything that isn't
  a real dish, rather than inventing one
- Return `canonicalName` as the commonly-used name for the dish, spelling
  corrected, lowercase
- Break the dish into 4–10 steps for one standard portion
- Use `object` as a singular lowercase noun with no adjectives —
  `"onion"` not `"finely chopped red onions"`. Merging is a string match;
  adjectives break it.
- Separate fixed setup cost from per-unit cost honestly. Dicing one onion:
  `setupMin` covers fetching the board and knife; `perUnitMin` is the dicing.
- Set `mergeable: false` for steps whose output degrades if prepared early
- Encode oven preheats as `object: "oven_200c"` (lowercase, no spaces)
- Use `dependsOn` indices referring to positions in this dish's own steps array
- Describe what each step _needs_, one dish at a time, and never reason about
  how many appliances the cook owns. A step's `resource` is a requirement;
  capacity is applied later by the scheduler.

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

## 10. Build phases

### Phase 1 — Skeleton and deploy

Scaffold Vite + React + Mantine. Two screens switched by
`const [screen, setScreen] = useState("pick")`. **Deploy to Vercel now**, while
it is empty and the deploy is trivial to debug.

> **Checkpoint 1:** A live Vercel URL renders a Mantine button. Do not proceed
> until this is true.

### Phase 2 — Algorithms, with tests, no UI

Write `resources.js`, `merge.js`, `schedule.js`, and their two test files.
Use the Section 7 worked example as the fixture, including the capacity test.
Run the tests from the command line.

> **Checkpoint 2:** `merge.test.js` and `schedule.test.js` both pass, producing
> `sequentialTotal: 46, batchSaving: 1, makespan: 30, parallelSaving: 15` with
> the default capacity, and `makespan: 45, parallelSaving: 0` when called with
> `{ ...DEFAULT_CAPACITY, hob: 1 }`. No React code has been written yet. Do not
> proceed until this is true.

### Phase 3 — Seed data and the pick screen

Load `seed.json` (Section 11). Build `PickDishes.jsx` to the spec in **section
8.2**, seed-only for now — the autocomplete accepts free text but anything not
in the seed simply errors until Phase 5. On submit, run merge + schedule and
log the result object to the console.

> **Checkpoint 3:** Selecting three seeded dishes logs a valid schedule object
> with a makespan lower than `sequentialTotal`. The colour assigned to each
> chip is stable across re-renders.

### Phase 4 — Timeline and Gantt

Build `Timeline.jsx`, `SavingsBanner.jsx`, and `Gantt.jsx` to the spec in
**sections 8.5 and 8.6**. Read those before starting — they specify the layout,
the `PX_PER_MIN` constant, the merged-step marker, the oven-conflict callout,
and the exact copy for the savings banner.

Also handle the edge cases in **section 8.7**, particularly the one-dish case
where `batchSaving` is zero.

> **Checkpoint 4:** Three seeded dishes produce a readable Gantt and a correct
> savings banner. A single dish on its own also renders without showing
> "0 min saved by batching".

### Phase 5 — Live API and cache

Build `/api/dish.js`. Flow: normalize the raw name → look up in MongoDB →
on miss, call Claude → if `valid: false` return 422 → otherwise lowercase
`action`/`object`, check the cache again under `canonicalName`, write, return.

Wire it into the add-dish flow in **section 8.3**, including the loading chip
and the 12-second abort.

> **Checkpoint 5:** Typing a dish not in the seed returns a breakdown within
> ~5s and the chip relabels to the canonical spelling. Typing the same dish
> again returns instantly from cache. Typing "asdfgh" produces the
> "Not sure that's a dish" chip rather than an invented recipe.

### Phase 6 — Failure handling

Implement every row of the error table in **section 8.4**. The app must
degrade gracefully: clear message, retry where sensible, seeded dishes
unaffected. **The demo must survive the API being unreachable.** This is a
stated feature, not just defensive coding.

> **Checkpoint 6:** With the `ANTHROPIC_API_KEY` env var deliberately removed,
> the app still fully works using seeded dishes, and a live lookup shows the
> banner from 8.4 rather than a spinner that never resolves.

### Phase 7 — Kitchen panel and polish

Build `KitchenPanel.jsx` to the spec in **section 8.9**. Because the scheduler
already takes capacity as an argument, this is wiring rather than refactoring.
If it turns out to be a refactor, Phase 2 was built wrong and that is what to
fix.

Then: one accent colour, consistent spacing, readable type. Nothing else.

> **Checkpoint 7:** Changing burners from 4 to 1 while on the Timeline screen
> visibly re-solves the Gantt with no page reload, and reloading the page
> preserves the setting.

### Remaining hours: buffer

Do not start new features with leftover time. Re-test and rehearse instead.

---

## 11. Seed data — `src/data/seed.json`

Pre-cache **15 dishes** so the app is fully demonstrable with no network.
Include deliberate overlap so batching has something to find — at least four
dishes should need diced onion, and at least three should need a 200°C oven.

Suggested set: tomato pasta, dal, roast chicken, roast potatoes, garlic bread,
green salad, rice pilaf, chicken curry, miso soup, stir-fried greens,
shepherd's pie, roasted carrots, guacamole, scrambled eggs, apple crumble.

Generate these by running the Phase 5 endpoint once each, then commit the
output. Seed documents get `source: "seed"`.

---

## 12. MongoDB notes

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

## 13. Definition of done

- [ ] Live URL, works on a phone
- [ ] Both algorithm test files pass, including the reduced-capacity case
- [ ] Three seeded dishes produce a correct Gantt and savings banner
- [ ] An arbitrary typed dish is fetched from Claude and cached
- [ ] A second request for that dish is served from MongoDB
- [ ] Removing the API key does not break the seeded flow
- [ ] Oven temperature conflicts are visible in the timeline
- [ ] The savings banner attributes batching and parallelism separately
- [ ] Nonsense input produces a clear "not a dish" chip, never an invented recipe
- [ ] A misspelled dish relabels to its canonical spelling
- [ ] One dish alone renders without a "0 min saved" line
- [ ] No interaction can leave a chip spinning indefinitely
- [ ] Changing a kitchen capacity re-solves the timeline live
- [ ] Kitchen settings survive a page reload

---

## 14. If you get stuck

State the blocker plainly and propose the smallest change that unblocks it.
Prefer cutting scope over inventing architecture. In priority order, the things
to cut are: the kitchen panel UI (the scheduler argument stays regardless),
then oven-conflict display, then the live API path (fall back to seed only),
then the number of seeded dishes.

The merge pass, the scheduler, and the savings banner are the project. They do
not get cut.
