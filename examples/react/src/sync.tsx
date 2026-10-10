import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { appWindow, currentWindow, sharedState, VantailError } from "@vantail/api";

import "./style.css";

const SYNC_KEY = "demo.counter";

/**
 * The sync window.
 *
 * A separate HTML entry point and a separate React root - two windows are two
 * webviews with nothing shared between them, so both read the same key via
 * `sharedState.get` and stay in step via `sharedState.subscribe`. Either
 * window writes with `sharedState.set`; the other reflects it without a
 * reload.
 */
function Sync() {
  const [count, setCount] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  function report(cause: unknown) {
    setNote(
      VantailError.is(cause) ? `${cause.code}: ${cause.message}` : String(cause),
    );
  }

  useEffect(() => {
    void sharedState
      .get<number>(SYNC_KEY, 0)
      .then((value) => setCount(value))
      .catch((cause) => report(cause));
    const stop = sharedState.subscribe<number>(SYNC_KEY, (value) =>
      setCount(value),
    );
    return () => stop();
  }, []);

  async function bump(delta: number) {
    setNote(null);
    try {
      const current = await sharedState.get<number>(SYNC_KEY, 0);
      await sharedState.set(SYNC_KEY, current + delta);
    } catch (cause) {
      report(cause);
    }
  }

  return (
    <main>
      <h1>Sync</h1>
      <p className="meta">
        This is the window labelled <code>{currentWindow()}</code>. Key{" "}
        <code>{SYNC_KEY}</code> is shared with the main window.
      </p>
      <p className="meta">{count === null ? "loading..." : `count: ${count}`}</p>
      {note ? <p className="note">{note}</p> : null}
      <div className="actions">
        <button onClick={() => void bump(1)}>+1</button>
        <button onClick={() => void bump(-1)}>-1</button>
        <button onClick={() => void appWindow.close()}>Close</button>
      </div>
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
