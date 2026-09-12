import { Paper, Stack, Text, Title } from "@mantine/core";

// sequentialTotal/makespan/parallelSaving are sums (or a difference of
// sums) over many steps; with non-integer setupMin/perUnitMin values from
// live Claude dishes, that accumulates the same floating-point drift as
// Timeline.jsx's step list (e.g. 35.39999999999999). Round for display only
// — schedule.js's own numbers are untouched.
const round1 = (n) => Math.round(n * 10) / 10;

// Section 8.5: the most prominent element on the page — larger than
// everything else. The two saving lines are always attributed separately.
export default function SavingsBanner({ sequentialTotal, makespan, batchSaving, parallelSaving, mergedStepCount }) {
  // Section 8.5 / 8.7: a zero reads as a bug, so batchSaving === 0 (the
  // one-dish case, or dishes with no shared prep) gets different copy
  // instead of "0 min saved by batching 0 shared prep steps".
  const batchingLine =
    batchSaving === 0
      ? "No shared prep in these dishes"
      : `${round1(batchSaving)} min saved by batching ${mergedStepCount} shared prep step${mergedStepCount === 1 ? "" : "s"}`;

  return (
    <Paper withBorder radius="md" p="xl">
      <Stack gap="xs">
        <Title order={1} style={{ fontSize: "clamp(1.75rem, 4vw, 2.75rem)", lineHeight: 1.15 }}>
          Sequential: {round1(sequentialTotal)} min → Optimized: {round1(makespan)} min
        </Title>
        <Text size="lg">{batchingLine}</Text>
        <Text size="lg">{round1(parallelSaving)} min saved by overlapping</Text>
      </Stack>
    </Paper>
  );
}
