/** The application window's entry point, loaded from `app.html`. */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppWindow } from "@/AppWindow";
import { followSystemTheme } from "@/theme";

import "@/index.css";

// Before React mounts, so the first frame is already the right colour rather
// than a white one that turns dark a tick later.
followSystemTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppWindow />
  </StrictMode>,
);
