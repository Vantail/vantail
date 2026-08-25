import { autostart, notification, power, shell, shortcut } from "@vantail/api";
import { panel, type Panel } from "../ui.js";

/** A global hotkey, claimed system-wide. */
export function shortcutPanel(): Panel {
  const p = panel("shortcut", "shortcut", "A key combination that fires even when another app is in front.");

  const accelerator = p.input("accelerator", "CmdOrCtrl+Shift+K");
  p.row(
    accelerator,
    p.button("register()", () => shortcut.register(accelerator.value)),
    p.button("unregister()", () => shortcut.unregister(accelerator.value)),
  );

  p.row(
    p.button("isRegistered()", () => shortcut.isRegistered(accelerator.value)),
    p.button("list()", () => shortcut.list()),
    p.button("unregisterAll()", () => shortcut.unregisterAll()),
  );

  p.note("Register, then switch to another application and press it. Another app may already own the combination, which fails with ALREADY_EXISTS.");
  shortcut.onPressed((fired) => p.log(`pressed ${fired.accelerator}`));

  return p;
}

/** Starting with the machine. */
export function autostartPanel(): Panel {
  const p = panel("autostart", "autostart", "Whether the application starts when the user logs in.");

  p.row(
    p.button("isEnabled()", () => autostart.isEnabled()),
    p.button("enable()", () => autostart.enable()),
    p.button("disable()", () => autostart.disable()),
  );
  p.note("This writes a real login item. Remember to disable it again, or the showcase starts with your machine.");

  return p;
}

/** Sleep and wake. */
export function powerPanel(): Panel {
  const p = panel("power", "power", "Notices when the machine suspends and resumes.");

  p.row(p.button("supported()", () => power.supported()));
  p.note("Close the lid or sleep the machine, wait a few seconds, then wake it. The events appear below.");

  power.onSuspend(() => p.log("suspending (going to sleep)"));
  power.onResume(() => p.log("resumed (woke up)"));

  return p;
}

/** Desktop notifications. */
export function notificationPanel(): Panel {
  const p = panel("notification", "notification", "A notification from the operating system.");

  const title = p.input("title", "Vantail");
  const body = p.input("body", "Drawn by the OS, not by the page.");
  p.row(
    title,
    body,
    p.button("show()", () => notification.show({ title: title.value, body: body.value })),
  );
  p.row(p.button("show() with just a string", () => notification.show("The short form")));
  p.note("The OS decides whether to show it. If nothing appears, check the notification settings for this app.");

  return p;
}

/** Handing a URL to whatever the system uses for it. */
export function shellPanel(): Panel {
  const p = panel("shell", "shell", "Opening a link or a file in whatever application owns it.");

  const target = p.input("url", "https://example.com");
  p.row(target, p.button("open()", () => shell.open(target.value)));

  p.row(p.button("open something not allowed", () => shell.open("http://example.com")));
  p.note("The config allows https://* only, so the http one is refused. `open: true` would allow anything, which on every platform includes running a program.");

  return p;
}
