import { describe, expect, test } from "vitest";
import { flattenDishes } from "./merge.js";
import { schedule } from "./schedule.js";
import { DEFAULT_CAPACITY } from "./resources.js";

// ---------------------------------------------------------------------------
// Primary fixture — Section 7's worked example ("tomato pasta" + "dal").
// Every numeric expectation in the two describe blocks below is copied
// verbatim from Section 7's text.
// ---------------------------------------------------------------------------
function twoDishFixture() {
  return [
    {
      name: "tomato pasta",
      steps: [
        { action: "dice", object: "onion", setupMin: 1, perUnitMin: 2, units: 1, resource: "hands", mergeable: true, dependsOn: [] }, // A1
        { action: "simmer", object: "sauce", setupMin: 1, perUnitMin: 14, units: 1, resource: "hob", mergeable: true, dependsOn: [0] }, // A2
      ],
    },
    {
      name: "dal",
      steps: [
        { action: "dice", object: "onion", setupMin: 1, perUnitMin: 2, units: 1, resource: "hands", mergeable: true, dependsOn: [] }, // B1
        { action: "simmer", object: "dal", setupMin: 1, perUnitMin: 24, units: 1, resource: "hob", mergeable: true, dependsOn: [0] }, // B2
      ],
    },
  ];
}

describe("schedule — Section 7 worked example, DEFAULT_CAPACITY", () => {
  const result = schedule(flattenDishes(twoDishFixture()));

  test("sequentialTotal === 46 (Section 7: 3 + 15 + 3 + 25)", () => {
    expect(result.sequentialTotal).toBe(46);
  });

  test("batchSaving === 1", () => {
    expect(result.batchSaving).toBe(1);
  });

  test("makespan === 30 (both simmers run concurrently; hob capacity is 4)", () => {
    expect(result.makespan).toBe(30);
  });

  test("parallelSaving === 15 (Section 7: 46 - 1 - 30)", () => {
    expect(result.parallelSaving).toBe(15);
  });

  test("per-step schedule matches Section 7: M1 hands 0->5, A2 hob 5->20, B2 hob 5->30", () => {
    const onion = result.scheduled.find((s) => s.action === "dice" && s.object === "onion");
    const sauce = result.scheduled.find((s) => s.object === "sauce");
    const dal = result.scheduled.find((s) => s.object === "dal");
    expect([onion.startMin, onion.endMin]).toEqual([0, 5]);
    expect([sauce.startMin, sauce.endMin]).toEqual([5, 20]);
    expect([dal.startMin, dal.endMin]).toEqual([5, 30]);
  });
});

// ---------------------------------------------------------------------------
// Capacity test — Section 7's "also required" reduced-capacity case
// ({ ...DEFAULT_CAPACITY, hob: 1 }).
//
// The aggregate numbers (makespan, batchSaving, parallelSaving) are copied
// verbatim from Section 7. The PER-STEP order deliberately departs from
// Section 7's literal text ("A2 hob 5->20, B2 hob 20->45") — per your
// decision, Section 5.5's descending-slack formula governs instead:
//   slack(A2) = 15 (terminal, own duration only)
//   slack(B2) = 25 (terminal, own duration only)
// B2's slack is larger, so B2 is scheduled first when both become ready at
// t=5 and only one can occupy the single hob slot. Section 7's own text is
// the stale value here; makespan/batchSaving/parallelSaving are unaffected
// either way since both orderings are back-to-back with no idle time.
// ---------------------------------------------------------------------------
describe("schedule — Section 7 capacity test, { ...DEFAULT_CAPACITY, hob: 1 }", () => {
  const capacity = { ...DEFAULT_CAPACITY, hob: 1 };
  const result = schedule(flattenDishes(twoDishFixture()), capacity);

  test("sequentialTotal === 46 (capacity-independent)", () => {
    expect(result.sequentialTotal).toBe(46);
  });

  test("batchSaving === 1 (Section 7: unchanged — batching is capacity-independent)", () => {
    expect(result.batchSaving).toBe(1);
  });

  test("makespan === 45 (Section 7)", () => {
    expect(result.makespan).toBe(45);
  });

  test("parallelSaving === 0 (Section 7: 46 - 1 - 45)", () => {
    expect(result.parallelSaving).toBe(0);
  });

  test("per-step schedule: M1 hands 0->5, B2 hob 5->30, A2 hob 30->45 (Section 5.5 descending slack)", () => {
    const onion = result.scheduled.find((s) => s.action === "dice" && s.object === "onion");
    const sauce = result.scheduled.find((s) => s.object === "sauce");
    const dal = result.scheduled.find((s) => s.object === "dal");
    expect([onion.startMin, onion.endMin]).toEqual([0, 5]);
    expect([dal.startMin, dal.endMin]).toEqual([5, 30]);
    expect([sauce.startMin, sauce.endMin]).toEqual([30, 45]);
  });
});

// ---------------------------------------------------------------------------
// Section 5.3 — resource capacity must be checked across the ENTIRE interval,
// not just at the candidate's start instant.
//
// This fixture is constructed by hand (Section 5.3's own example is
// abstract — "Existing A: 0->10, Existing B: 5->20, Candidate C: duration 15"
// — and doesn't give a runnable dependency graph), then every timestamp
// below is derived by mechanically applying Sections 5.3/5.4/5.5 to it, not
// copied from an implementation run. Trace:
//
//   Steps (one dish, custom capacity hob: 2):
//     H  = hands, duration 5,  no deps
//     S1 = hob,   duration 15, no deps
//     S2 = hob,   duration 15, dependsOn H
//     S3 = hob,   duration 10, no deps
//
//   Slack (terminal steps: slack = own duration):
//     slack(S1) = 15, slack(S2) = 15, slack(S3) = 10
//     slack(H)  = 5 + slack(S2) = 20   (H's only dependent is S2)
//
//   Priority-topological order: H (20) is picked first; this makes S2
//   eligible, and S2 (slack 15) ties S1 (slack 15) — S1 wins the tie by
//   appearing earlier in the flattened input (Section 5.5's tie-break).
//   Final order: H, S1, S2, S3.
//
//   Placement walk:
//     H:  0->5   (hands, free)
//     S1: 0->15  (hob, free)
//     S2: earliest candidate is 5 (dep H ends at 5); hob has only S1 (1
//         concurrent) throughout [5,15) and is empty after -> valid at 5.
//         S2: 5->20
//     S3: no deps, so a start-time-only check at t=0 would see just S1 (1
//         concurrent, < capacity 2) and wrongly accept it. But S3's own
//         10-minute interval [0,10) overlaps [5,10), where S1 AND S2 are
//         BOTH already active (2 concurrent == capacity), so t=0 is
//         actually invalid. The next point where S3's whole interval clears
//         both is t=15 (after S1 ends at 15; S2 is still running until 20,
//         but only 1 concurrent then). S3: 15->25
//
//   makespan = max(5, 15, 20, 25) = 25
// ---------------------------------------------------------------------------
describe("schedule — Section 5.3 interval-wide capacity checking", () => {
  const dishes = [
    {
      name: "capacity-probe",
      steps: [
        { action: "wash", object: "widget", setupMin: 5, perUnitMin: 0, units: 1, resource: "hands", mergeable: false, dependsOn: [] }, // H  (index 0)
        { action: "simmer", object: "pot1", setupMin: 15, perUnitMin: 0, units: 1, resource: "hob", mergeable: false, dependsOn: [] }, // S1 (index 1)
        { action: "simmer", object: "pot2", setupMin: 15, perUnitMin: 0, units: 1, resource: "hob", mergeable: false, dependsOn: [0] }, // S2 (index 2), dependsOn H
        { action: "simmer", object: "pot3", setupMin: 10, perUnitMin: 0, units: 1, resource: "hob", mergeable: false, dependsOn: [] }, // S3 (index 3)
      ],
    },
  ];
  const capacity = { hands: 1, hob: 2, oven: 1, blender: 1, passive: Infinity };
  const result = schedule(flattenDishes(dishes), capacity);

  test("H: 0->5, S1: 0->15, S2: 5->20, S3: 15->25", () => {
    const h = result.scheduled.find((s) => s.object === "widget");
    const s1 = result.scheduled.find((s) => s.object === "pot1");
    const s2 = result.scheduled.find((s) => s.object === "pot2");
    const s3 = result.scheduled.find((s) => s.object === "pot3");
    expect([h.startMin, h.endMin]).toEqual([0, 5]);
    expect([s1.startMin, s1.endMin]).toEqual([0, 15]);
    expect([s2.startMin, s2.endMin]).toEqual([5, 20]);
    expect([s3.startMin, s3.endMin]).toEqual([15, 25]);
  });

  test("makespan === 25", () => {
    expect(result.makespan).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// Section 7, algorithm step 2: a dependency cycle must throw.
// ---------------------------------------------------------------------------
describe("schedule — cycle detection", () => {
  test("throws when two steps depend on each other", () => {
    const dishes = [
      {
        name: "impossible dish",
        steps: [
          { action: "mix", object: "batter", setupMin: 1, perUnitMin: 1, units: 1, resource: "hands", mergeable: false, dependsOn: [1] },
          { action: "bake", object: "batter", setupMin: 1, perUnitMin: 1, units: 1, resource: "oven", mergeable: false, dependsOn: [0] },
        ],
      },
    ];
    expect(() => schedule(flattenDishes(dishes))).toThrow();
  });
});
