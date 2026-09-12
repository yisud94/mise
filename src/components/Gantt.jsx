import { Badge, Text, Tooltip } from "@mantine/core";
import { duration } from "../lib/merge.js";

const PX_PER_MIN = 8;
const ROW_ORDER = ["hands", "hob", "oven", "blender", "passive"];
const LABEL_WIDTH = 70;
const LANE_HEIGHT = 32;
const LANE_GAP = 4;
const AXIS_HEIGHT = 20;
const MIN_LABEL_WIDTH = 40; // Section 8.6: bars shorter than ~40px can't hold a label
const BADGE_ALLOWANCE = 28; // extra width a merged step's ×N badge + gap needs alongside the label

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function stepLabel(step) {
  return `${capitalize(step.action)} ${step.object}`;
}

// Section 5.11: overlapping steps within a resource row are stacked into
// sub-lanes so their labels stay readable — this is purely visual and never
// changes scheduling or resource capacity (which schedule.js already
// enforced). Greedy interval coloring: sort by start, reuse the first lane
// whose previous occupant has already ended.
function assignLanes(steps) {
  const sorted = [...steps].sort((a, b) => a.startMin - b.startMin);
  const laneEnds = [];
  const withLanes = sorted.map((step) => {
    let lane = laneEnds.findIndex((end) => end <= step.startMin);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(step.endMin);
    } else {
      laneEnds[lane] = step.endMin;
    }
    return { ...step, lane };
  });
  return { steps: withLanes, laneCount: laneEnds.length || 1 };
}

function Bar({ step, dishColorByName }) {
  // Section 5.2/6: a merged step carries `dishes` (plural, array); a normal
  // step carries `dish` (singular). That distinction is how we tell them
  // apart for Section 5.12's styling override.
  const isMerged = Array.isArray(step.dishes);
  const width = (step.endMin - step.startMin) * PX_PER_MIN;
  const label = stepLabel(step);
  // A merged step's badge needs room alongside the label, or the label gets
  // squeezed to 0 width while the (flexShrink: 0) badge takes all the space.
  const canShowInlineLabel = width >= MIN_LABEL_WIDTH + (isMerged ? BADGE_ALLOWANCE : 0);

  const dishColor = !isMerged ? (dishColorByName.get(step.dish) ?? "gray") : null;

  // duration(step), not endMin - startMin: on a resource with several
  // non-integer-minute steps queued back to back, the scheduled timestamps
  // accumulate floating-point drift that subtracting them back apart
  // doesn't cancel out (e.g. 35.39999999999999), even though duration()
  // itself is clean.
  const tooltipLabel = isMerged
    ? `${label} ×${step.dishes.length} · ${duration(step)} min (${step.dishes.join(", ")})`
    : `${label} · ${duration(step)} min`;

  return (
    <Tooltip label={tooltipLabel} events={{ hover: true, focus: true, touch: true }} withinPortal>
      <div
        style={{
          position: "absolute",
          left: step.startMin * PX_PER_MIN,
          top: step.lane * (LANE_HEIGHT + LANE_GAP) + 4,
          width: Math.max(width, 3),
          height: LANE_HEIGHT,
          background: isMerged ? "var(--mantine-color-gray-3)" : `var(--mantine-color-${dishColor}-5)`,
          border: isMerged ? "2px dashed var(--mantine-color-gray-6)" : "1px solid rgba(0, 0, 0, 0.15)",
          borderRadius: 6,
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "0 6px",
          overflow: "hidden",
          whiteSpace: "nowrap",
          cursor: "default",
        }}
      >
        {canShowInlineLabel && (
          <>
            <Text
              size="xs"
              fw={500}
              c={isMerged ? "dark" : "white"}
              style={{ overflow: "hidden", textOverflow: "ellipsis" }}
            >
              {label}
            </Text>
            {isMerged && (
              <Badge size="xs" variant="filled" color="dark" style={{ flexShrink: 0 }}>
                ×{step.dishes.length}
              </Badge>
            )}
          </>
        )}
      </div>
    </Tooltip>
  );
}

// Section 8.6: absolute-positioned divs inside a relatively-positioned
// container, no chart library. One row per resource in the fixed order
// hands/hob/oven/blender/passive, omitting empty rows.
export default function Gantt({ scheduled, dishColorByName }) {
  const makespan = Math.max(0, ...scheduled.map((s) => s.endMin));
  const totalWidth = makespan * PX_PER_MIN;

  const rows = ROW_ORDER.map((resource) => ({
    resource,
    ...assignLanes(scheduled.filter((s) => s.resource === resource)),
  })).filter((row) => row.steps.length > 0);

  const axisMarks = [];
  for (let m = 0; m <= makespan; m += 10) axisMarks.push(m);

  return (
    <div style={{ overflowX: "auto", border: "1px solid var(--mantine-color-gray-3)", borderRadius: 8 }}>
      <div style={{ width: LABEL_WIDTH + totalWidth, minWidth: "100%" }}>
        <div style={{ display: "flex", height: AXIS_HEIGHT }}>
          <div
            style={{
              width: LABEL_WIDTH,
              flexShrink: 0,
              position: "sticky",
              left: 0,
              background: "var(--mantine-color-body)",
              zIndex: 2,
            }}
          />
          <div style={{ position: "relative", width: totalWidth }}>
            {axisMarks.map((m) => (
              <Text key={m} size="xs" c="dimmed" style={{ position: "absolute", left: m * PX_PER_MIN, top: 0 }}>
                {m}m
              </Text>
            ))}
          </div>
        </div>

        {rows.map(({ resource, steps, laneCount }) => (
          <div key={resource} style={{ display: "flex", borderTop: "1px solid var(--mantine-color-gray-2)" }}>
            <div
              style={{
                width: LABEL_WIDTH,
                flexShrink: 0,
                position: "sticky",
                left: 0,
                background: "var(--mantine-color-body)",
                zIndex: 2,
                display: "flex",
                alignItems: "center",
                fontSize: 13,
                fontWeight: 600,
                textTransform: "capitalize",
                paddingLeft: 4,
              }}
            >
              {resource}
            </div>
            <div
              style={{
                position: "relative",
                width: totalWidth,
                height: laneCount * LANE_HEIGHT + (laneCount - 1) * LANE_GAP + 8,
              }}
            >
              {steps.map((step) => (
                <Bar key={step.id} step={step} dishColorByName={dishColorByName} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
