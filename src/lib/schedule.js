import { DEFAULT_CAPACITY } from "./resources.js";
import { duration, merge } from "./merge.js";

function buildDependents(steps) {
  const dependents = new Map(steps.map((s) => [s.id, []]));
  for (const step of steps) {
    for (const depId of step.dependsOn) {
      if (dependents.has(depId)) dependents.get(depId).push(step.id);
    }
  }
  return dependents;
}

// Kahn's algorithm. Returns a topological order, or throws (Section 7,
// algorithm step 2) if a cycle leaves some steps permanently blocked.
function topologicalOrder(steps, dependents) {
  const inDegree = new Map(steps.map((s) => [s.id, s.dependsOn.length]));
  const byId = new Map(steps.map((s) => [s.id, s]));
  const queue = steps.filter((s) => s.dependsOn.length === 0).map((s) => s.id);
  const order = [];

  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const depId of dependents.get(id)) {
      inDegree.set(depId, inDegree.get(depId) - 1);
      if (inDegree.get(depId) === 0) queue.push(depId);
    }
  }

  if (order.length !== steps.length) {
    const stuck = steps
      .filter((s) => !order.includes(s.id))
      .map((s) => s.object);
    throw new Error(`Cycle detected among steps: ${stuck.join(", ")}`);
  }

  return order;
}

// Section 5.5: slack(step) = duration(step) if it has no dependents, else
// duration(step) + max(slack(d) for d in dependents(step)). Computed in
// reverse topological order so every dependent's slack is already known.
function computeSlack(steps, dependents, topoOrder) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const slack = new Map();
  for (let i = topoOrder.length - 1; i >= 0; i--) {
    const id = topoOrder[i];
    const step = byId.get(id);
    const deps = dependents.get(id);
    const own = duration(step);
    slack.set(
      id,
      deps.length === 0
        ? own
        : own + Math.max(...deps.map((depId) => slack.get(depId))),
    );
  }
  return slack;
}

// Priority-topological order: repeatedly pick, from the currently-eligible
// pool, the step with the largest slack (Section 5.5: descending slack,
// ties broken by original flattened order). A step becomes eligible the
// moment all of its dependencies have been picked — not when their actual
// placed time elapses; ordering and time-placement are separate phases.
function priorityOrder(steps, dependents, slack) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const picked = new Set();
  const pool = steps.filter((s) => s.dependsOn.length === 0);
  const result = [];

  while (pool.length) {
    pool.sort((a, b) => {
      const diff = slack.get(b.id) - slack.get(a.id);
      return diff !== 0 ? diff : a.order - b.order;
    });
    const next = pool.shift();
    result.push(next);
    picked.add(next.id);

    for (const depId of dependents.get(next.id)) {
      const depStep = byId.get(depId);
      const ready = depStep.dependsOn.every((d) => picked.has(d));
      if (ready && !picked.has(depId) && !pool.includes(depStep)) {
        pool.push(depStep);
      }
    }
  }

  return result;
}

// Section 5.3/5.4: a candidate fits at `start` only if, at every point
// during [start, start+dur), the number of ALREADY-PLACED steps on the
// resource is strictly less than capacity. Only interval boundaries
// (existing starts/ends, plus the candidate's own start) can change that
// count, so only those points need checking.
function fits(intervals, cap, start, dur) {
  if (cap === Infinity) return true;
  const end = start + dur;
  const points = new Set([start]);
  for (const iv of intervals) {
    if (iv.start > start && iv.start < end) points.add(iv.start);
    if (iv.end > start && iv.end < end) points.add(iv.end);
  }
  for (const p of points) {
    const count = intervals.filter((iv) => iv.start <= p && p < iv.end).length;
    if (count >= cap) return false;
  }
  return true;
}

// Section 5.4: begin at max(endMin of dependencies); if that doesn't fit,
// advance to the next resource-availability boundary rather than scanning
// minute by minute.
function earliestStart(intervals, cap, minStart, dur) {
  if (cap === Infinity) return minStart;
  const candidates = new Set([minStart]);
  for (const iv of intervals) {
    if (iv.start >= minStart) candidates.add(iv.start);
    if (iv.end >= minStart) candidates.add(iv.end);
  }
  const sorted = [...candidates].sort((a, b) => a - b);
  for (const t of sorted) {
    if (fits(intervals, cap, t, dur)) return t;
  }
  const maxEnd = intervals.reduce((m, iv) => Math.max(m, iv.end), 0);
  return Math.max(minStart, maxEnd);
}

// Signature is FROZEN (Section 7): capacity is an argument, never read from
// the resources.js constant inside this function.
export function schedule(steps, capacity = DEFAULT_CAPACITY) {
  const sequentialTotal = steps.reduce((sum, s) => sum + duration(s), 0);
  const { merged, batchSaving } = merge(steps);

  const byId = new Map(merged.map((s) => [s.id, s]));
  const dependents = buildDependents(merged);
  const topoOrder = topologicalOrder(merged, dependents);
  const slack = computeSlack(merged, dependents, topoOrder);
  const order = priorityOrder(merged, dependents, slack);

  const placed = new Map();
  const resourceIntervals = new Map();

  for (const step of order) {
    const depEnds = step.dependsOn.map((depId) => placed.get(depId).endMin);
    const minStart = depEnds.length ? Math.max(...depEnds) : 0;
    const dur = duration(step);
    const intervals = resourceIntervals.get(step.resource) ?? [];
    const cap = capacity[step.resource];
    const start = earliestStart(intervals, cap, minStart, dur);
    const end = start + dur;

    placed.set(step.id, { startMin: start, endMin: end });
    intervals.push({ start, end });
    resourceIntervals.set(step.resource, intervals);
  }

  const scheduled = merged.map((step) => ({
    ...step,
    startMin: placed.get(step.id).startMin,
    endMin: placed.get(step.id).endMin,
  }));

  const makespan = Math.max(...scheduled.map((s) => s.endMin));
  const parallelSaving = sequentialTotal - batchSaving - makespan;

  return { scheduled, makespan, sequentialTotal, batchSaving, parallelSaving };
}
