import { useEffect, useState } from "react";
import PickDishes from "./screens/PickDishes.jsx";
import Timeline from "./screens/Timeline.jsx";
import { DEFAULT_CAPACITY } from "./lib/resources.js";

const CAPACITY_STORAGE_KEY = "mise:capacity";

function twoHoursFromNow() {
  return new Date(Date.now() + 2 * 60 * 60 * 1000);
}

// Section 8.9: read once on mount, falling back to DEFAULT_CAPACITY. This is
// the only permitted use of localStorage in the project.
function loadStoredCapacity() {
  try {
    const raw = localStorage.getItem(CAPACITY_STORAGE_KEY);
    // Oven is capped at 1 in the UI (multi-oven scheduling isn't reliable
    // yet) — clamp here too, in case a value >1 was saved before that cap.
    if (raw) return { ...DEFAULT_CAPACITY, ...JSON.parse(raw), oven: 1 };
  } catch {
    // localStorage can be unavailable (private browsing, quota) — fall back.
  }
  return DEFAULT_CAPACITY;
}

function App() {
  const [screen, setScreen] = useState("pick"); // "pick" | "timeline"
  const [dishes, setDishes] = useState([]);
  const [serveTime, setServeTime] = useState(twoHoursFromNow);
  const [capacity, setCapacity] = useState(loadStoredCapacity);

  useEffect(() => {
    try {
      localStorage.setItem(CAPACITY_STORAGE_KEY, JSON.stringify(capacity));
    } catch {
      // ignore write failures — the in-memory value still works this session
    }
  }, [capacity]);

  if (screen === "pick") {
    return (
      <PickDishes
        dishes={dishes}
        setDishes={setDishes}
        serveTime={serveTime}
        setServeTime={setServeTime}
        capacity={capacity}
        setCapacity={setCapacity}
        onBuild={() => setScreen("timeline")}
      />
    );
  }

  return (
    <Timeline
      dishes={dishes}
      serveTime={serveTime}
      capacity={capacity}
      setCapacity={setCapacity}
      onBack={() => setScreen("pick")}
    />
  );
}

export default App;
