// Internal-only fields on flattened/merged steps (id, dish, dishes, order) are
// implementation metadata per Section 5.2 — never part of the frozen Step
// schema, never persisted to seed.json/MongoDB/the Claude schema.

export function duration(step) {
  return step.setupMin + step.perUnitMin * step.units;
}

// Converts each dish's own `steps` array (dependsOn indices local to that
// dish) into one flat array, assigning every step a globally-unique id and
// rewriting dependsOn to reference those ids (Section 5.1: "assign every
// step an internal identity... before flattening or merging").
export function flattenDishes(dishes) {
  const flat = [];
  let order = 0;
  dishes.forEach((dish, dishIndex) => {
    dish.steps.forEach((step, stepIndex) => {
      flat.push({
        id: `${dishIndex}:${stepIndex}`,
        dish: dish.name,
        order: order++,
        action: step.action,
        object: step.object,
        setupMin: step.setupMin,
        perUnitMin: step.perUnitMin,
        units: step.units,
        resource: step.resource,
        mergeable: step.mergeable,
        dependsOn: step.dependsOn.map((localIndex) => `${dishIndex}:${localIndex}`),
      });
    });
  });
  return flat;
}

function dedupe(ids) {
  return [...new Set(ids)];
}

// The merge pass (Section 6). Input: flattened, dish-tagged steps (as
// produced by flattenDishes). Output: { merged, batchSaving }.
export function merge(flatSteps) {
  const groups = new Map();
  const passthrough = [];

  for (const step of flatSteps) {
    if (step.resource === "hands" && step.mergeable) {
      const key = `${step.action.toLowerCase()}::${step.object.toLowerCase()}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(step);
    } else {
      passthrough.push(step);
    }
  }

  const idMap = new Map();
  const mergedSteps = [];
  let batchSaving = 0;
  let mergedCounter = 0;

  for (const members of groups.values()) {
    if (members.length < 2) {
      // Nothing to batch — treat as a normal passthrough step.
      passthrough.push(...members);
      continue;
    }

    const newId = `merged:${mergedCounter++}`;
    const totalUnits = members.reduce((sum, m) => sum + m.units, 0);
    const setupMin = members[0].setupMin;
    const perUnitMin = members[0].perUnitMin;

    mergedSteps.push({
      id: newId,
      dish: undefined,
      dishes: members.map((m) => m.dish),
      order: Math.min(...members.map((m) => m.order)),
      action: members[0].action.toLowerCase(),
      object: members[0].object.toLowerCase(),
      setupMin,
      perUnitMin,
      units: totalUnits,
      resource: "hands",
      mergeable: true,
      dependsOn: dedupe(members.flatMap((m) => m.dependsOn)),
    });

    for (const m of members) idMap.set(m.id, newId);
    batchSaving += (members.length - 1) * setupMin;
  }

  // Steps that didn't merge still map to themselves, so the remap pass below
  // is uniform for merged and passthrough steps alike.
  for (const step of passthrough) {
    if (!idMap.has(step.id)) idMap.set(step.id, step.id);
  }

  const finalSteps = [...mergedSteps, ...passthrough].map((step) => {
    const remapped = dedupe(step.dependsOn.map((depId) => idMap.get(depId) ?? depId)).filter(
      (depId) => depId !== step.id,
    );
    return { ...step, dependsOn: remapped };
  });

  return { merged: finalSteps, batchSaving };
}
