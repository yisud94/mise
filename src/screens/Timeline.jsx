import { useMemo, useState } from "react";
import { Alert, Anchor, Container, Stack, Text } from "@mantine/core";
import SavingsBanner from "../components/SavingsBanner.jsx";
import Gantt from "../components/Gantt.jsx";
import KitchenPanel from "../components/KitchenPanel.jsx";
import { duration, flattenDishes } from "../lib/merge.js";
import { schedule } from "../lib/schedule.js";

function formatClock(date) {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// Section 5.13: an oven conflict exists when scheduled oven preheats carry
// more than one distinct oven_<temp>c object value. The prose is built
// dynamically from the actual dishes/order (Section 8.6's style) while
// still covering 5.13's two minimum requirements: name the distinct
// temperatures, and say the oven work was sequenced rather than parallel.
function buildOvenConflictMessage(scheduled) {
  const preheats = scheduled.filter((s) => s.action === "preheat" && s.resource === "oven");
  const byObject = new Map();
  for (const step of preheats) {
    if (!byObject.has(step.object)) byObject.set(step.object, []);
    byObject.get(step.object).push(step);
  }
  if (byObject.size < 2) return null;

  const groups = [...byObject.entries()]
    .map(([object, steps]) => ({
      temp: object.match(/^oven_(.+)c$/)?.[1] ?? object,
      // A same-temperature preheat is now itself merged (Section 4) into
      // one step carrying `dishes` (plural); an unmerged one still carries
      // `dish` (singular) — collect names from whichever is present.
      dishes: [...new Set(steps.flatMap((s) => (Array.isArray(s.dishes) ? s.dishes : [s.dish])))],
      earliestStart: Math.min(...steps.map((s) => s.startMin)),
    }))
    .sort((a, b) => a.earliestStart - b.earliestStart);

  const tempList = groups.map((g) => `${g.temp}°C`).join(" and ");
  const [first, ...rest] = groups;
  const restDishes = rest.flatMap((g) => g.dishes).join(", ");

  return `Your dishes want different oven temperatures (${tempList}). I've sequenced them — ${restDishes} go in after ${first.dishes.join(", ")} comes out.`;
}

export default function Timeline({ dishes, serveTime, capacity, setCapacity, onBack }) {
  // Section 8.9 "live re-solve": deriving this from dishes/capacity, rather
  // than holding it as separately-synced state, means a KitchenPanel change
  // re-solves and re-renders the Gantt on its own — no extra wiring needed.
  const result = useMemo(() => {
    const readyDishes = dishes.filter((d) => d.status === "ready");
    const flatSteps = flattenDishes(readyDishes.map((d) => ({ name: d.name, steps: d.steps })));
    return schedule(flatSteps, capacity);
  }, [dishes, capacity]);
  const { scheduled, sequentialTotal, makespan, batchSaving, parallelSaving } = result;

  const dishColorByName = new Map(dishes.map((d) => [d.name, d.color]));
  const mergedStepCount = scheduled.filter((s) => Array.isArray(s.dishes)).length;

  // Section 5.14 / 7: schedule forward from t=0, then startTime = serveTime
  // - makespan. If that lands in the past, still show it (flagged) rather
  // than blocking (Section 8.7). `now` is captured once (lazy initializer)
  // rather than read directly during render, which React treats as impure.
  const [now] = useState(() => Date.now());
  const startTime = new Date(serveTime.getTime() - makespan * 60000);
  const isPastStart = startTime.getTime() < now;
  const minutesLate = Math.round((now - startTime.getTime()) / 60000);

  const ovenConflictMessage = buildOvenConflictMessage(scheduled);
  const sortedSteps = [...scheduled].sort((a, b) => a.startMin - b.startMin);

  return (
    <Container size="md" py="xl">
      <Anchor component="button" type="button" onClick={onBack} mb="md" underline="hover">
        ← Change dishes
      </Anchor>

      <Stack gap="lg">
        <KitchenPanel capacity={capacity} setCapacity={setCapacity} />

        <SavingsBanner
          sequentialTotal={sequentialTotal}
          makespan={makespan}
          batchSaving={batchSaving}
          parallelSaving={parallelSaving}
          mergedStepCount={mergedStepCount}
        />

        <div>
          <Text size="xl" fw={700} c={isPastStart ? "red" : undefined}>
            Start cooking at {formatClock(startTime)}
          </Text>
          {isPastStart && (
            <Text size="sm" c="red">
              You'd have needed to start {minutesLate} minute{minutesLate === 1 ? "" : "s"} ago.
            </Text>
          )}
        </div>

        {ovenConflictMessage && (
          <Alert color="orange" title="Oven conflict" variant="light">
            {ovenConflictMessage}
          </Alert>
        )}

        <Gantt scheduled={scheduled} dishColorByName={dishColorByName} />

        <Stack gap={4}>
          {sortedSteps.map((step) => {
            const label = `${capitalize(step.action)} ${step.object}`;
            const who = Array.isArray(step.dishes) ? `${step.dishes.length} dishes` : step.dish;
            // Use the step's own duration rather than endMin - startMin: on
            // a resource with several non-integer-minute steps queued back
            // to back, the scheduled timestamps accumulate floating-point
            // drift (e.g. 1.3000000000000007) that subtracting them back
            // apart doesn't cancel out, even though duration() is clean.
            const time = formatClock(new Date(startTime.getTime() + step.startMin * 60000));
            return (
              <Text key={step.id} size="sm">
                {time} — {label} ({who}) · {duration(step)} min
              </Text>
            );
          })}
        </Stack>
      </Stack>
    </Container>
  );
}
