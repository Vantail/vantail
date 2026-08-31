/** The splash window's entry point: the window the config opens. */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { SplashScreen } from "@/SplashScreen";

import "@/index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SplashScreen />
  </StrictMode>,
);
