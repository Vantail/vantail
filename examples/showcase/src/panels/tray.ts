import { appWindow, tray } from "@vantail/api";
import { panel, type Panel } from "../ui.js";

/** The menu bar or system tray icon. */
export function trayPanel(): Panel {
  const p = panel("tray", "tray", "An icon in the menu bar or system tray, with its own menu.");

  p.row(
    p.button("set()", () =>
      tray.set({
        icon: "tray-icon.png",
        tooltip: "Vantail Showcase",
        menu: [
          { id: "tray-show", label: "Show the window" },
          { id: "tray-hide", label: "Hide the window" },
          { type: "separator" },
          { type: "predefined", item: "quit" },
        ],
      }),
    ),
    p.button("exists()", () => tray.exists()),
    p.button("remove()", () => tray.remove()),
  );

  const tooltip = p.input("tooltip", "Still here");
  p.row(
    tooltip,
    p.button("setTooltip()", () => tray.setTooltip(tooltip.value)),
    p.button("setTitle()", () => tray.setTitle("Showcase")),
    p.button("clear title", () => tray.setTitle(null)),
  );

  p.row(
    p.button("hide the icon", () => tray.setVisible(false)),
    p.button("show the icon", () => tray.setVisible(true)),
    p.button("showMenu()", () => tray.showMenu()),
  );

  p.note("The icon path is resolved inside the bundle, so `tray-icon.png` means the one in public/.");

  // A click is what brings a hidden window back, which is the whole point of
  // `closeBehavior: "hide"` over in the window panel.
  tray.onClick(async (event) => {
    p.log(`tray clicked with the ${event.button} button`);
    await appWindow.show();
    await appWindow.focus();
  });
  tray.onDoubleClick(() => p.log("tray double-clicked"));

  return p;
}
