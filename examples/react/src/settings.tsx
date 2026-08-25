import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { app, appWindow, currentWindow } from "@vantail/api";

import "./style.css";

/**
 * The second window.
 *
 * A separate HTML entry point and a separate React root - two windows are two
 * webviews with nothing shared between them, so anything they need to tell
 * each other goes through `app.emit`.
 */
function Settings() {
  const [greeting, setGreeting] = useState<string | null>(null);

  useEffect(() => app.listen<{ from: string }>("hello", ({ from }) => setGreeting(from)), []);

  return (
    <main>
      <h1>Settings</h1>
      <p className="meta">
        This is the window labelled <code>{currentWindow()}</code>.
      </p>
      <p className="meta">
        {greeting ? `The main window said hello, and called itself ${greeting}.` : "Waiting..."}
      </p>
      <button onClick={() => void app.emit("hello", { from: "settings" }, { to: "main" })}>
        Say hello back
      </button>
      <button onClick={() => void appWindow.close()}>Close</button>
    </main>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("settings.html is missing #root");

createRoot(container).render(
  <StrictMode>
    <Settings />
  </StrictMode>,
);
