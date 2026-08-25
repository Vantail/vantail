import { os } from "@vantail/api";
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

  return p;
}
