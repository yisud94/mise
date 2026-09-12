import { useMemo, useRef, useState } from "react";
import {
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
import seed from "../data/seed.json";

const DISH_COLORS = ["blue", "grape", "teal", "orange", "pink", "lime"];
const MAX_DISHES = 6;
const EXAMPLE_DISHES = ["tomato pasta", "roast chicken", "dal"];

// Section 5.6: trim, lowercase, collapse internal whitespace. Never rewrite
// spelling or strip punctuation — that's the Claude API's job (Section 9),
// not implemented yet (Phase 5).
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

// Section 8.3 (network path) + Section 5.7 (status-code contract). Message
// text for each case is Section 8.4's — full retry-button / one-time-banner
// treatment for 503 is Phase 6's job; this just gets the right chip state.
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
      return { ok: false, error: "Not sure that's a dish" };
    }
    if (response.status === 503) {
      return { ok: false, error: "Live lookup is off — seeded dishes still work" };
    }
    return { ok: false, error: "Couldn't reach the server" };
  } catch (err) {
    return { ok: false, error: err.name === "AbortError" ? "That took too long" : "Couldn't reach the server" };
  } finally {
    clearTimeout(timeoutId);
  }
}

export default function PickDishes({ dishes, setDishes, serveTime, setServeTime, onBuild }) {
  const [inputValue, setInputValue] = useState("");
  const [highlighted, setHighlighted] = useState(null);
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

    const color = DISH_COLORS[dishes.length % DISH_COLORS.length];
    // Section 8.3, step 1: the loading chip must render before any lookup
    // resolves — a seed hit resolves on the next microtask, a seed miss
    // goes on to the live API (step 3).
    setDishes((prev) => [...prev, { name: normalized, steps: [], status: "loading", error: null, color }]);
    setInputValue("");

    Promise.resolve().then(async () => {
      const seedSteps = seedByName.get(normalized);
      if (seedSteps) {
        setDishes((prev) => prev.map((d) => (d.name === normalized ? { ...d, steps: seedSteps, status: "ready" } : d)));
        return;
      }

      const result = await lookupDish(normalized);
      setDishes((prev) =>
        prev.map((d) => {
          if (d.name !== normalized) return d;
          if (result.ok) {
            return { ...d, name: result.canonicalName, steps: result.steps, status: "ready" };
          }
          return { ...d, status: "error", error: result.error };
        }),
      );
    });
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
              <div key={dish.name} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
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
                  <Text size="xs" c="red">
                    {dish.error}
                  </Text>
                )}
              </div>
            ))}
          </div>
        )}

        <Button size="md" disabled={!hasReadyDish || isLoadingAny} onClick={onBuild}>
          Build my timeline
        </Button>
      </Stack>
    </Container>
  );
}
