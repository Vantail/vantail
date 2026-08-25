import { filesystem, os } from "@vantail/api";
import { panel, type Panel } from "../ui.js";

/**
 * Files, within the scope the config granted.
 *
 * Everything here works under `$APPDATA`, which this app may write to. Reading
 * something outside the scope is included on purpose, to show what a refusal
 * looks like.
 */
export function filesystemPanel(): Panel {
  const p = panel("filesystem", "filesystem", "Reading and writing files, inside a scope the config sets.");

  const scratch = async () => `${await os.appDataDir()}/showcase`;
  const note = async () => `${await scratch()}/note.txt`;

  p.row(
    p.button("mkdir()", async () => filesystem.mkdir(await scratch(), { recursive: true })),
    p.button("writeText()", async () => filesystem.writeText(await note(), "written by the showcase\n")),
    p.button("appendText()", async () => filesystem.appendText(await note(), "and appended to\n")),
    p.button("readText()", async () => filesystem.readText(await note())),
  );

  p.row(
    p.button("stat()", async () => filesystem.stat(await note())),
    p.button("exists()", async () => filesystem.exists(await note())),
    p.button("readDir()", async () => filesystem.readDir(await scratch())),
  );

  p.row(
    p.button("copy()", async () => filesystem.copy(await note(), `${await scratch()}/copy.txt`)),
    p.button("rename()", async () => filesystem.rename(`${await scratch()}/copy.txt`, `${await scratch()}/moved.txt`)),
    p.button("remove()", async () => filesystem.remove(`${await scratch()}/moved.txt`)),
  );

  // Bytes rather than text. The wire is JSON, so binary travels as base64 and
  // arrives as a Uint8Array; the cap is 64 MB, which suits documents and
  // icons rather than video.
  p.row(
    p.button("writeBinary()", async () =>
      filesystem.writeBinary(`${await scratch()}/bytes.bin`, new Uint8Array([0, 1, 2, 250, 251, 252])),
    ),
    p.button("readBinary()", async () => filesystem.readBinary(`${await scratch()}/bytes.bin`)),
  );

  let watching: string | null = null;
  p.row(
    p.button("watch()", async () => {
      if (watching) {
        await filesystem.unwatch(watching);
        watching = null;
        return "stopped watching";
      }
      const handle = await filesystem.watch(await scratch());
      watching = handle.id;
      return `watching ${handle.path} - now write a file into it`;
    }),
    p.button("watches()", () => filesystem.watches()),
  );
  filesystem.onChange((change) => p.log(`${change.kind}: ${change.path}`));

  p.row(
    p.button("read something forbidden", () => filesystem.readText("/etc/passwd")),
  );
  p.note("That last one is meant to fail: it is outside the granted scope, and the rejection carries PERMISSION_DENIED.");

  return p;
}
