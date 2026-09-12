import { useMemo, useRef, useState } from "react";
import {
  Alert,
  Anchor,
  Autocomplete,
  Badge,
  Button,
  CloseButton,
  Container,
  Loader,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { TimeInput } from "@mantine/dates";
import KitchenPanel from "../components/KitchenPanel.jsx";
import seed from "../data/seed.json";

const DISH_COLORS = ["blue", "grape", "teal", "orange", "pink", "lime"];
const MAX_DISHES = 6;
const EXAMPLE_DISHES = ["tomato pasta", "roast chicken", "dal"];

// Section 5.6: trim, lowercase, collapse internal whitespace. Never rewrite
// spelling or strip punctuation — that's the Claude API's job (Section 9).
function normalizeDishName(raw) {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

function formatTimeOfDay(date) {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function withTimeOfDay(date, hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return date;
  const next = new Date(date);
  next.setHours(h, m, 0, 0);
  return next;
}

const REQUEST_TIMEOUT_MS = 12000;

// Section 8.3 (network path) + Section 5.7 (status-code contract). `errorKind`
// is internal-only (not part of the Section 8.1 Dish entry shape) — it's how
// the render logic below picks the right Section 8.4 affordance (retry vs.
// "try one of these" vs. nothing) without re-parsing the message text.
async function lookupDish(dishName) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch("/api/dish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dishName }),
      signal: controller.signal,
    });

    if (response.status === 200) {
      const data = await response.json();
      return { ok: true, canonicalName: normalizeDishName(data.dish), steps: data.steps };
    }
    if (response.status === 422) {
      return { ok: false, errorKind: "invalid", error: "Not sure that's a dish" };
    }
    if (response.status === 503) {
      // Section 8.4: the specific "Live lookup is off" copy belongs to the
      // one-time banner, not this chip — this chip just needs its own
      // terminal, removable state.
      return { ok: false, errorKind: "keyMissing", error: "Couldn't look this up right now" };
    }
    return { ok: false, errorKind: "network", error: "Couldn't reach the server" };
  } catch (err) {
    if (err.name === "AbortError") {
      return { ok: false, errorKind: "timeout", error: "That took too long" };
    }
    return { ok: false, errorKind: "network", error: "Couldn't reach the server" };
  } finally {
    clearTimeout(timeoutId);
  }
}

export default function PickDishes({ dishes, setDishes, serveTime, setServeTime, capacity, setCapacity, onBuild }) {
  const [inputValue, setInputValue] = useState("");
  const [highlighted, setHighlighted] = useState(null);
  const [showApiKeyBanner, setShowApiKeyBanner] = useState(false);
  const inputRef = useRef(null);

  const seedByName = useMemo(() => new Map(seed.map((d) => [d._id, d.steps])), []);
  const seedNames = useMemo(() => seed.map((d) => d._id), []);

  const atLimit = dishes.length >= MAX_DISHES;
  const hasReadyDish = dishes.some((d) => d.status === "ready");
  const isLoadingAny = dishes.some((d) => d.status === "loading");

  function flashHighlight(name) {
    setHighlighted(name);
    setTimeout(() => setHighlighted((current) => (current === name ? null : current)), 600);
  }

  // Section 8.3 steps 2-5, shared by both a fresh add and a retry of an
  // existing errored chip. Every path here ends by writing "ready" or
  // "error" — none can leave the chip in "loading" indefinitely.
  function resolveDish(normalized) {
    Promise.resolve().then(async () => {
      const seedSteps = seedByName.get(normalized);
      if (seedSteps) {
        setDishes((prev) => prev.map((d) => (d.name === normalized ? { ...d, steps: seedSteps, status: "ready" } : d)));
        return;
      }

      const result = await lookupDish(normalized);
      if (result.ok) {
        setDishes((prev) =>
          prev.map((d) =>
            d.name === normalized ? { ...d, name: result.canonicalName, steps: result.steps, status: "ready" } : d,
          ),
        );
        return;
      }

      if (result.errorKind === "keyMissing") setShowApiKeyBanner(true);
      setDishes((prev) =>
        prev.map((d) =>
          d.name === normalized ? { ...d, status: "error", error: result.error, errorKind: result.errorKind } : d,
        ),
      );
    });
  }

  function addDish(rawName) {
    const normalized = normalizeDishName(rawName);
    if (!normalized) return;

    const existing = dishes.find((d) => d.name === normalized);
    if (existing) {
      flashHighlight(normalized);
      setInputValue("");
      return;
    }

    if (atLimit) return;

    // Section 5.15: the freed color from a deleted dish must be reusable —
    // indexing by length alone can collide with a color still in use by a
    // dish that wasn't at the end of the list when it was removed.
    const color = DISH_COLORS.find((c) => !dishes.some((d) => d.color === c));
    // Section 8.3, step 1: the loading chip must render before any lookup
    // resolves — a seed hit resolves on the next microtask, a seed miss
    // goes on to the live API (step 3).
    setDishes((prev) => [...prev, { name: normalized, steps: [], status: "loading", error: null, errorKind: null, color }]);
    setInputValue("");
    resolveDish(normalized);
  }

  function retryDish(name) {
    setDishes((prev) => prev.map((d) => (d.name === name ? { ...d, status: "loading", error: null, errorKind: null } : d)));
    resolveDish(name);
  }

  function removeDish(name) {
    setDishes((prev) => prev.filter((d) => d.name !== name));
  }

  function handleKeyDown(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      addDish(inputValue);
      inputRef.current?.focus();
    }
  }

  return (
    <Container size="sm" py="xl">
      <Stack gap="xs" mb="lg">
        <Title order={1}>Mise</Title>
        <Text c="dimmed">Tell me what you're cooking. I'll work out the order.</Text>
      </Stack>

      <Stack gap="lg">
        {showApiKeyBanner && (
          <Alert color="yellow" variant="light" title="Live lookup is off">
            Seeded dishes still work — typed dishes not already in the list can't be looked up right now.
          </Alert>
        )}

        <TimeInput
          label="I want to eat at"
          value={formatTimeOfDay(serveTime)}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value) setServeTime((prev) => withTimeOfDay(prev, value));
          }}
        />

        <div>
          <Autocomplete
            ref={inputRef}
            label="What are you making?"
            placeholder="Start typing a dish…"
            data={seedNames}
            value={inputValue}
            onChange={setInputValue}
            onKeyDown={handleKeyDown}
            disabled={atLimit}
          />
          {atLimit && (
            <Text size="sm" c="dimmed" mt={4}>
              That's plenty — six is the limit.
            </Text>
          )}
        </div>

        {dishes.length === 0 && (
          <Stack gap="xs">
            <Text size="sm" c="dimmed">
              Or try one of these:
            </Text>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {EXAMPLE_DISHES.map((name) => (
                <Badge key={name} variant="light" style={{ cursor: "pointer" }} onClick={() => addDish(name)}>
                  {name}
                </Badge>
              ))}
            </div>
          </Stack>
        )}

        {dishes.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {dishes.map((dish) => (
              <div key={dish.name} style={{ display: "flex", flexDirection: "column", gap: 2, maxWidth: 220 }}>
                <Badge
                  color={dish.status === "error" ? "gray" : dish.color}
                  variant={highlighted === dish.name ? "filled" : "light"}
                  size="lg"
                  rightSection={
                    <CloseButton
                      size="xs"
                      variant="transparent"
                      onClick={() => removeDish(dish.name)}
                      aria-label={`Remove ${dish.name}`}
                    />
                  }
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {dish.status === "loading" && <Loader size="xs" color="gray" />}
                    {dish.status === "loading" ? "Looking up…" : dish.name}
                  </span>
                </Badge>

                {dish.status === "error" && (
                  <Stack gap={2}>
                    <Text size="xs" c="red">
                      {dish.error}
                    </Text>

                    {dish.errorKind === "invalid" && (
                      <Stack gap={2}>
                        <Text size="xs" c="dimmed">
                          Try one of these:
                        </Text>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {EXAMPLE_DISHES.map((name) => (
                            <Badge
                              key={name}
                              size="xs"
                              variant="light"
                              style={{ cursor: "pointer" }}
                              onClick={() => addDish(name)}
                            >
                              {name}
                            </Badge>
                          ))}
                        </div>
                      </Stack>
                    )}

                    {(dish.errorKind === "network" || dish.errorKind === "timeout") && (
                      <Anchor component="button" type="button" size="xs" onClick={() => retryDish(dish.name)}>
                        Retry
                      </Anchor>
                    )}
                  </Stack>
                )}
              </div>
            ))}
          </div>
        )}

        <KitchenPanel capacity={capacity} setCapacity={setCapacity} />

        <Button size="md" disabled={!hasReadyDish || isLoadingAny} onClick={onBuild}>
          Build my timeline
        </Button>
      </Stack>
    </Container>
  );
}
