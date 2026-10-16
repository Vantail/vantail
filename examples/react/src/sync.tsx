import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { appWindow, currentWindow, sharedState, VantailError } from "@vantail/api";

import "./style.css";

/**
 * The sync window.
 *
 * A separate HTML entry point and a separate React root - two windows are two
 * webviews with nothing shared between them. Both windows read the same
 * `demo.counter` key through `sharedState`: the current value arrives on
 * subscribe, and every `set` from either side re-renders the other without a
 * reload. The runtime owns the value, so there is no "which window wins?"
 * race - the last write wins.
 */
function Sync() {
  const [count, setCount] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const stop = sharedState.subscribe("demo.counter", (value: unknown) => {
      setCount(typeof value === "number" ? value : null);
    });
    // A missing read permission fails the subscribe above (reported to the
    // console there); this names it where the demo lives.
    void sharedState.get("demo.counter").then(
      () => {},
      (cause: unknown) => {
        setProblem(
          VantailError.is(cause)
            ? `${cause.code}: ${cause.message}`
            : String(cause),
        );
      },
    );
    return stop;
  }, []);

  function report(cause: unknown) {
    setProblem(
      VantailError.is(cause)
        ? `${cause.code}: ${cause.message}`
        : String(cause),
    );
  }

  async function bump(by: number) {
    setProblem(null);
    try {
      await sharedState.set("demo.counter", (count ?? 0) + by);
    } catch (cause) {
      report(cause);
    }
  }

  return (
    <main>
      <h1>Sync</h1>
      <p className="meta">
        This is the window labelled <code>{currentWindow()}</code>, sharing{" "}
        <code>demo.counter</code> with <code>main</code>.
      </p>
      <p className="meta">
        Counter: {count === null ? "unset - press +1 in either window" : count}
      </p>
      {problem ? <p className="note">{problem}</p> : null}
      <section className="actions">
        <button className="primary" onClick={() => void bump(1)}>
          +1
        </button>
        <button onClick={() => void bump(-1)}>-1</button>
        <button onClick={() => void appWindow.close()}>Close</button>
      </section>
    </main>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("sync.html is missing #root");

createRoot(container).render(
  <StrictMode>
    <Sync />
  </StrictMode>,
);
