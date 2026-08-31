import { defineConfig } from "@vantail/cli";

export default defineConfig({
  app: {
    name: "Splash Example",
    identifier: "dev.vantail.example.splash",
    version: "0.1.0",
    icon: "icon.png",
  },

  /**
   * The window the application opens with is the splash, not the application.
   * `src/splash.ts` opens the real one and then closes this - in that order,
   * because closing the last window quits.
   */
  window: {
    title: "Starting",
    width: 420,
    height: 240,
    center: true,

    // No frame, which is what takes the title bar and the window buttons with
    // it. A splash has nothing to close, minimise or drag.
    decorations: false,
    resizable: false,

    // Its own shape. Square at the top right, gently rounded on the other two,
    // and a deeper curve at the bottom left. The runtime clips the page to it,
    // so `src/splash.css` sets no `border-radius` of its own.
    borderRadius: {
      topLeft: 15,
      topRight: 0,
      bottomRight: 15,
      bottomLeft: 30,
    },

    // What shows before the page has painted. The same orange, so the window
    // never appears as a pale rectangle first.
    backgroundColor: "#ff6a13",
  },

  // Nothing to grant: the application opens a window and closes one, and both
  // are its own.
});
