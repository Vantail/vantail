/** The application proper. An ordinary window, framed like any other. */

import { app, appWindow, currentWindow, listWindows } from "@vantail/api";

const facts = document.getElementById("facts")!;

const row = (term: string, value: string) => {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = value;
  facts.append(dt, dd);
};

const info = await app.info();
row("Application", `${info.name} ${info.version}`);
row("This window", currentWindow() ?? "unknown");
row("Window title", await appWindow.title());

// The splash has closed by now, so this is the only one left.
row("Windows open", (await listWindows()).join(", "));
