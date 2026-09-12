import { useState } from "react";
import { Group, NumberInput, Stack, Text, UnstyledButton } from "@mantine/core";

// Section 8.9: label/key pairs for the four visible steppers. `passive` is
// never shown and is always Infinity. Oven is capped at 1 — multi-oven
// scheduling (concurrent preheats at different temperatures) has known
// inconsistent behavior; locking it out here is the fix for the hackathon.
const STEPPERS = [
  { key: "hands", label: "Cooks", max: 6 },
  { key: "hob", label: "Burners", max: 6 },
  { key: "oven", label: "Ovens", max: 1 },
  { key: "blender", label: "Blenders", max: 6 },
];

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function summaryLine(capacity) {
  return `🍳 My kitchen: ${plural(capacity.hands, "cook")} · ${plural(capacity.hob, "burner")} · ${plural(
    capacity.oven,
    "oven",
  )} · ${plural(capacity.blender, "blender")} — adjust`;
}

// Collapsed by default and never blocks anything (Section 8.9). The value
// itself lives in App.jsx as `capacity` — this component only reads/writes
// it via props, so schedule(steps, capacity) sees the change wherever it's
// called from (Timeline.jsx re-solves live; nothing else reads it).
export default function KitchenPanel({ capacity, setCapacity }) {
  const [expanded, setExpanded] = useState(false);

  function updateCapacity(key, value) {
    if (!Number.isFinite(value)) return;
    setCapacity((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <Stack gap="xs">
      <UnstyledButton onClick={() => setExpanded((e) => !e)}>
        <Text size="sm" c="dimmed">
          {summaryLine(capacity)}
        </Text>
      </UnstyledButton>

      {expanded && (
        <Group gap="sm">
          {STEPPERS.map(({ key, label, max }) => (
            <NumberInput
              key={key}
              label={label}
              value={capacity[key]}
              onChange={(value) => updateCapacity(key, Number(value))}
              min={1}
              max={max}
              w={100}
            />
          ))}
        </Group>
      )}
    </Stack>
  );
}
