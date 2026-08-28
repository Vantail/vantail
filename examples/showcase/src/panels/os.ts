import { os, path } from "@vantail/api";
import { panel, type Panel } from "../ui.js";

/** Read-only machine facts, and the directories an app is allowed to use. */
export function osPanel(): Panel {
  const p = panel("os", "os", "Machine facts, and the per-application directories.");

  p.row(
    p.button("platform()", () => os.platform()),
    p.button("arch()", () => os.arch()),
    p.button("info()", () => os.info()),
    p.button("infoSync()", () => os.infoSync()),
  );

  p.row(
    p.button("homeDir()", () => os.homeDir()),
    p.button("tempDir()", () => os.tempDir()),
    p.button("resourceDir()", () => os.resourceDir()),
  );

  p.row(
    p.button("appDataDir()", () => os.appDataDir()),
    p.button("appConfigDir()", () => os.appConfigDir()),
  );
  p.note("These are the paths behind $APPDATA and $APPCONFIG in the permission globs.");

  p.row(
    p.button("path.join()", async () =>
      path.join(await os.appDataDir(), "projects", "notes.md"),
    ),
    p.button("path.basename()", async () =>
      path.basename(await os.appDataDir()),
    ),
    p.button("path.extname()", () => path.extname("notes.md")),
    p.button("path.sep", () => path.sep),
  );
  p.note(
    "String work, no round trip and no permission: a webview has no path module, " +
      "and asking the runtime per join would put IPC inside every directory walk.",
  );

  return p;
}
