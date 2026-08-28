import { os } from "./os.js";

/**
 * The path operations, for one platform's idea of a path.
 *
 * `path` is this for the platform the application is running on. `path.posix`
 * and `path.win32` are the other two, for the times you are handling a path
 * that came from somewhere else - a config file written on a colleague's
 * machine, a path inside an archive.
 */
export interface PathApi {
  /** `/` everywhere but Windows. */
  readonly sep: "/" | "\\";

  /**
   * Join segments with a single separator and tidy the result.
   *
   * ```ts
   * path.join(await os.appDataDir(), "projects", name + ".json");
   * ```
   */
  join(...parts: string[]): string;

  /** Collapse `.`, `..` and repeated separators. */
  normalize(path: string): string;

  /** Everything before the last segment. `.` when there is nothing. */
  dirname(path: string): string;

  /** The last segment, optionally without a trailing `suffix`. */
  basename(path: string, suffix?: string): string;

  /** The extension including its dot, or `""`. A dotfile has none. */
  extname(path: string): string;

  /** Whether the path names a location without needing a starting point. */
  isAbsolute(path: string): boolean;

  /** The same operations for POSIX paths, whatever platform this is. */
  readonly posix: PathApi;
  /** The same operations for Windows paths, whatever platform this is. */
  readonly win32: PathApi;
}

interface Root {
  /** The prefix exactly as it appeared in the input. */
  raw: string;
  /** The prefix rewritten with this platform's separator. */
  prefix: string;
  absolute: boolean;
}

const NONE: Root = { raw: "", prefix: "", absolute: false };

function flavour(sep: "/" | "\\"): PathApi {
  const win = sep === "\\";
  const splitter = win ? /[\\/]+/ : /\/+/;
  const trailing = win ? /[\\/]+$/ : /\/+$/;

  const isSep = (char: string): boolean =>
    char === "/" || (win && char === "\\");

  const lastSep = (text: string): number =>
    win
      ? Math.max(text.lastIndexOf("\\"), text.lastIndexOf("/"))
      : text.lastIndexOf("/");

  function rootOf(path: string): Root {
    if (!win) {
      return path.startsWith("/")
        ? { raw: "/", prefix: "/", absolute: true }
        : NONE;
    }

    // `\\server\share`, which is a root in its own right - the server and the
    // share are not segments you can `..` your way out of.
    const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)[\\/]?/.exec(path);
    if (unc) {
      return {
        raw: unc[0],
        prefix: `\\\\${unc[1]}\\${unc[2]}\\`,
        absolute: true,
      };
    }

    const drive = /^[a-zA-Z]:[\\/]/.exec(path);
    if (drive) {
      return { raw: drive[0], prefix: `${path.slice(0, 2)}\\`, absolute: true };
    }
    // `C:file` is relative to whatever the current directory on C: is, which
    // makes it a prefix but not an absolute path.
    if (/^[a-zA-Z]:/.test(path)) {
      return { raw: path.slice(0, 2), prefix: path.slice(0, 2), absolute: false };
    }
    // `\file` is absolute on the current drive.
    if (/^[\\/]/.test(path)) {
      return { raw: path.slice(0, 1), prefix: "\\", absolute: true };
    }
    return NONE;
  }

  function isAbsolute(path: string): boolean {
    return rootOf(path).absolute;
  }

  function normalize(path: string): string {
    if (path === "") return ".";

    const root = rootOf(path);
    const parts: string[] = [];

    for (const segment of path.slice(root.raw.length).split(splitter)) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") {
        // Climbing out of an absolute root goes nowhere, the way the
        // filesystem itself treats `/..`.
        if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
        else if (!root.absolute) parts.push("..");
        continue;
      }
      parts.push(segment);
    }

    let out = parts.join(sep);
    // A trailing separator is how a path says "this is a directory", so it
    // survives.
    if (out !== "" && trailing.test(path)) out += sep;
    if (out === "") return root.prefix === "" ? "." : root.prefix;
    return root.prefix + out;
  }

  function join(...parts: string[]): string {
    const joined = parts.filter((part) => part !== "").join(sep);
    return joined === "" ? "." : normalize(joined);
  }

  function dirname(path: string): string {
    if (path === "") return ".";

    // A slice rather than a rebuild, so the separators the caller wrote come
    // back unchanged - `dirname("C:/foo/bar")` is `"C:/foo"`, not
    // `"C:\\foo"`. Only `normalize` is in the business of tidying.
    const rootEnd = rootOf(path).raw.length;

    // Trailing separators are not the cut: `dirname("foo/bar/")` is `"foo"`.
    let end = path.length;
    while (end > rootEnd && isSep(path[end - 1]!)) end -= 1;

    let at = -1;
    for (let i = end - 1; i >= rootEnd; i -= 1) {
      if (isSep(path[i]!)) {
        at = i;
        break;
      }
    }

    // Nothing but a single name after the root: the answer is the root, or
    // "here" when there was no root at all.
    if (at < 0) return rootEnd === 0 ? "." : path.slice(0, rootEnd);
    return path.slice(0, at);
  }

  function basename(path: string, suffix?: string): string {
    // Asking for the name of a path that is nothing but the suffix leaves
    // nothing, which is what Node answers too.
    if (suffix !== undefined && suffix !== "" && suffix === path) return "";

    const rest = path.replace(trailing, "");
    const at = lastSep(rest);
    let name = at < 0 ? rest : rest.slice(at + 1);

    // A bare drive is a root, not a name.
    if (win && /^[a-zA-Z]:$/.test(name)) name = "";

    if (
      suffix !== undefined &&
      suffix !== "" &&
      name !== suffix &&
      name.endsWith(suffix)
    ) {
      name = name.slice(0, -suffix.length);
    }
    return name;
  }

  function extname(path: string): string {
    const name = basename(path);
    const at = name.lastIndexOf(".");
    // `0` is a dotfile - `.gitignore` is a name, not an extension.
    if (at <= 0) return "";
    return name.slice(at);
  }

  const api = {
    sep,
    join,
    normalize,
    dirname,
    basename,
    extname,
    isAbsolute,
  } as PathApi;

  return api;
}

const posix = flavour("/");
const win32 = flavour("\\");

// Each flavour can reach the other two, so `path.posix.join` works whichever
// one `path` turned out to be.
for (const api of [posix, win32]) {
  Object.defineProperties(api, {
    posix: { value: posix, enumerable: true },
    win32: { value: win32, enumerable: true },
  });
}

/**
 * Joining and taking apart file paths, without a round trip.
 *
 * A webview has no `path` module, and asking the runtime per join would put
 * an IPC call inside every directory walk - so every application that touches
 * more than one file ends up rewriting `join`, `dirname` and `basename`, and
 * getting the Windows separator subtly wrong. This is that code, once.
 *
 * These are string operations. Nothing here touches the filesystem, so
 * nothing here needs a permission: `path.join` will happily build a path the
 * application is not allowed to read, and `filesystem` will then refuse it.
 *
 * ```ts
 * import { os, path, filesystem } from "@vantail/api";
 *
 * const file = path.join(await os.appDataDir(), "projects", "notes.md");
 * path.basename(file);          // "notes.md"
 * path.basename(file, ".md");   // "notes"
 * path.extname(file);           // ".md"
 * path.dirname(file);           // ".../projects"
 * ```
 *
 * There is deliberately no `resolve`: a webview has no current working
 * directory to resolve against. Start from `os.appDataDir()`,
 * `os.homeDir()` or a path the user picked in a dialog, which is also the
 * only kind of path `filesystem` will accept.
 */
export const path: PathApi =
  os.infoSync()?.platform === "windows" ? win32 : posix;
