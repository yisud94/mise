import { useState } from "react";
import PickDishes from "./screens/PickDishes.jsx";
import Timeline from "./screens/Timeline.jsx";
import { flattenDishes } from "./lib/merge.js";
import { schedule } from "./lib/schedule.js";

function twoHoursFromNow() {
  return new Date(Date.now() + 2 * 60 * 60 * 1000);
}

function App() {
  const [screen, setScreen] = useState("pick"); // "pick" | "timeline"
  const [dishes, setDishes] = useState([]);
  const [serveTime, setServeTime] = useState(twoHoursFromNow);
  const [result, setResult] = useState(null);

  function handleBuild() {
    // Section 5.10: only ready dishes feed the timeline.
    const readyDishes = dishes.filter((d) => d.status === "ready");
    const flatSteps = flattenDishes(readyDishes.map((d) => ({ name: d.name, steps: d.steps })));
    const scheduled = schedule(flatSteps);
    console.log(scheduled);
    setResult(scheduled);
    setScreen("timeline");
  }

  if (screen === "pick") {
    return (
      <PickDishes
        dishes={dishes}
        setDishes={setDishes}
        serveTime={serveTime}
        setServeTime={setServeTime}
        onBuild={handleBuild}
      />
    );
  }

  return <Timeline dishes={dishes} result={result} serveTime={serveTime} onBack={() => setScreen("pick")} />;
}

export default App;
