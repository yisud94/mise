import { describe, expect, test } from "vitest";
import { flattenDishes, merge } from "./merge.js";

// ---------------------------------------------------------------------------
// Primary fixture — Section 7's worked example ("tomato pasta" + "dal").
// Every numeric expectation below is copied verbatim from Section 7's text:
//   merged dice onion = 1 + (2 * 2 units) = 5 min
//   batchSaving       = (2 - 1) * 1       = 1
// ---------------------------------------------------------------------------
function twoDishFixture() {
  return [
    {
      name: "tomato pasta",
      steps: [
        // A1: dice onion
        { action: "dice", object: "onion", setupMin: 1, perUnitMin: 2, units: 1, resource: "hands", mergeable: true, dependsOn: [] },
        // A2: simmer sauce, dependsOn A1
        { action: "simmer", object: "sauce", setupMin: 1, perUnitMin: 14, units: 1, resource: "hob", mergeable: true, dependsOn: [0] },
      ],
    },
    {
      name: "dal",
      steps: [
        // B1: dice onion
        { action: "dice", object: "onion", setupMin: 1, perUnitMin: 2, units: 1, resource: "hands", mergeable: true, dependsOn: [] },
        // B2: simmer dal, dependsOn B1
        { action: "simmer", object: "dal", setupMin: 1, perUnitMin: 24, units: 1, resource: "hob", mergeable: true, dependsOn: [0] },
      ],
    },
  ];
}

describe("flattenDishes", () => {
  test("remaps each dish's local dependsOn indices into globally unique ids (Section 5.1)", () => {
    const flat = flattenDishes(twoDishFixture());
    expect(flat).toHaveLength(4);

    const a1 = flat.find((s) => s.dish === "tomato pasta" && s.action === "dice");
    const a2 = flat.find((s) => s.dish === "tomato pasta" && s.action === "simmer");
    const b1 = flat.find((s) => s.dish === "dal" && s.action === "dice");
    const b2 = flat.find((s) => s.dish === "dal" && s.action === "simmer");

    // A2 must depend on A1's id, not on B1's — dependsOn indices are local to
    // each dish's own steps array (Section 4 / 5.1).
    expect(a2.dependsOn).toEqual([a1.id]);
    expect(b2.dependsOn).toEqual([b1.id]);
    expect(a1.id).not.toBe(b1.id);
  });
});

describe("merge — Section 7 worked example", () => {
  const { merged, batchSaving } = merge(flattenDishes(twoDishFixture()));

  test("batchSaving === 1 (Section 7: (2 - 1) * 1)", () => {
    expect(batchSaving).toBe(1);
  });

  test("produces exactly 3 output steps: 1 merged onion + A2 + B2", () => {
    expect(merged).toHaveLength(3);
  });

  test("merged onion step has units 2 and duration 5 (Section 7: 1 + (2 * 2))", () => {
    const onion = merged.find((s) => s.action === "dice" && s.object === "onion");
    expect(onion).toBeDefined();
    expect(onion.units).toBe(2);
    expect(onion.setupMin + onion.perUnitMin * onion.units).toBe(5);
    expect(onion.dishes.sort()).toEqual(["dal", "tomato pasta"]);
  });

  test("A2 and B2 now depend on the merged onion step, not on the original A1/B1 ids (Section 5.1)", () => {
    const onion = merged.find((s) => s.action === "dice" && s.object === "onion");
    const a2 = merged.find((s) => s.object === "sauce");
    const b2 = merged.find((s) => s.object === "dal");
    expect(a2.dependsOn).toEqual([onion.id]);
    expect(b2.dependsOn).toEqual([onion.id]);
  });
});

// ---------------------------------------------------------------------------
// Rule tests — Section 6's merge conditions. Expected values here are the
// trivial, structural consequences of the stated rules (0 merges when a rule
// excludes the group; the frozen batchSaving formula otherwise), not numbers
// derived by running an implementation.
// ---------------------------------------------------------------------------
describe("merge — rules from Section 6", () => {
  test("cooking steps on the hob never merge, even with matching action/object (oven preheats are the one exception — see below)", () => {
    const dishes = [
      { name: "dish a", steps: [{ action: "simmer", object: "sauce", setupMin: 1, perUnitMin: 10, units: 1, resource: "hob", mergeable: true, dependsOn: [] }] },
      { name: "dish b", steps: [{ action: "simmer", object: "sauce", setupMin: 1, perUnitMin: 10, units: 1, resource: "hob", mergeable: true, dependsOn: [] }] },
    ];
    const { merged, batchSaving } = merge(flattenDishes(dishes));
    expect(merged).toHaveLength(2);
    expect(batchSaving).toBe(0);
  });

  test("mergeable: false blocks merging even when action/object/resource match", () => {
    const dishes = [
      { name: "dish a", steps: [{ action: "whip", object: "cream", setupMin: 1, perUnitMin: 3, units: 1, resource: "hands", mergeable: false, dependsOn: [] }] },
      { name: "dish b", steps: [{ action: "whip", object: "cream", setupMin: 1, perUnitMin: 3, units: 1, resource: "hands", mergeable: false, dependsOn: [] }] },
    ];
    const { merged, batchSaving } = merge(flattenDishes(dishes));
    expect(merged).toHaveLength(2);
    expect(batchSaving).toBe(0);
  });

  test("action/object matching is case-insensitive (Section 6 + Section 9 gotcha #3)", () => {
    const dishes = [
      { name: "dish a", steps: [{ action: "Dice", object: "Onion", setupMin: 1, perUnitMin: 2, units: 1, resource: "hands", mergeable: true, dependsOn: [] }] },
      { name: "dish b", steps: [{ action: "dice", object: "onion", setupMin: 1, perUnitMin: 2, units: 1, resource: "hands", mergeable: true, dependsOn: [] }] },
    ];
    const { merged, batchSaving } = merge(flattenDishes(dishes));
    expect(merged).toHaveLength(1);
    expect(batchSaving).toBe((2 - 1) * 1); // frozen formula, Section 6
    expect(merged[0].action).toBe("dice");
    expect(merged[0].object).toBe("onion");
  });
});

// ---------------------------------------------------------------------------
// Section 4's oven-preheat exception: "Two dishes at 200°C merge
// automatically under the normal merge rule." A preheat step's resource is
// "oven", not "hands", so Section 6's rule taken alone would never merge
// it — this is the reconciliation of that contradiction (see merge.js's
// isMergeCandidate comment).
// ---------------------------------------------------------------------------
describe("merge — Section 4 oven-preheat exception", () => {
  test("two dishes preheating to the same temperature merge into one oven step", () => {
    const dishes = [
      { name: "roast chicken", steps: [{ action: "preheat", object: "oven_200c", setupMin: 10, perUnitMin: 0, units: 1, resource: "oven", mergeable: true, dependsOn: [] }] },
      { name: "roast potatoes", steps: [{ action: "preheat", object: "oven_200c", setupMin: 10, perUnitMin: 0, units: 1, resource: "oven", mergeable: true, dependsOn: [] }] },
    ];
    const { merged, batchSaving } = merge(flattenDishes(dishes));
    expect(merged).toHaveLength(1);
    const preheat = merged[0];
    expect(preheat.resource).toBe("oven"); // must not be forced to "hands"
    expect(preheat.dishes.sort()).toEqual(["roast chicken", "roast potatoes"]);
    expect(batchSaving).toBe((2 - 1) * 10); // frozen formula, Section 6
  });

  test("dishes preheating to different temperatures do not merge (Section 4: serialised instead)", () => {
    const dishes = [
      { name: "roast chicken", steps: [{ action: "preheat", object: "oven_200c", setupMin: 10, perUnitMin: 0, units: 1, resource: "oven", mergeable: true, dependsOn: [] }] },
      { name: "lamb biryani", steps: [{ action: "preheat", object: "oven_180c", setupMin: 10, perUnitMin: 0, units: 1, resource: "oven", mergeable: true, dependsOn: [] }] },
    ];
    const { merged, batchSaving } = merge(flattenDishes(dishes));
    expect(merged).toHaveLength(2);
    expect(batchSaving).toBe(0);
  });

  test("matching-object oven steps that aren't preheat (e.g. two roasts) still don't merge — 'two pans are two pans' still holds for the actual cooking", () => {
    const dishes = [
      { name: "dish a", steps: [{ action: "roast", object: "vegetable", setupMin: 1, perUnitMin: 20, units: 1, resource: "oven", mergeable: true, dependsOn: [] }] },
      { name: "dish b", steps: [{ action: "roast", object: "vegetable", setupMin: 1, perUnitMin: 20, units: 1, resource: "oven", mergeable: true, dependsOn: [] }] },
    ];
    const { merged, batchSaving } = merge(flattenDishes(dishes));
    expect(merged).toHaveLength(2);
    expect(batchSaving).toBe(0);
  });
});
