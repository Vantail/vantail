import { decode, encode, type BinaryInput } from "./binary.js";
import { invoke, listen } from "./transport.js";

export interface FileChange {
  /** The watch that reported it, as returned by {@link filesystem.watch}. */
  id: string;
  kind: "created" | "modified" | "removed" | "renamed";
  /** What changed. For a recursive watch this is below the watched path. */
  path: string;
  /** The path the watch was placed on. */
  watching: string;
}

export interface Watch {
  id: string;
  path: string;
  recursive: boolean;
}

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

export interface FileInfo {
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  readonly: boolean;
  /** Milliseconds since the epoch, or `null` where the platform has none. */
  modifiedAt: number | null;
  createdAt: number | null;
}

/**
 * Scoped file access.
 *
 * Every call is checked against the `permissions.filesystem` scopes in
 * `vantail.config.ts`, plus anything the user has picked in a native dialog
 * during this session. A refusal throws a `VantailError` with code
 * `PERMISSION_DENIED`.
 */
export const filesystem = {
  readText: (path: string) => invoke<string>("filesystem.readText", { path }),

  writeText: (
    path: string,
    contents: string,
    options?: { createDirs?: boolean },
  ) =>
    invoke<null>("filesystem.writeText", {
      path,
      contents,
      createDirs: options?.createDirs ?? false,
    }),

  appendText: (path: string, contents: string) =>
    invoke<null>("filesystem.appendText", { path, contents }),

  /**
   * Read a file as bytes.
   *
   * Limited to 64 MB: the data crosses the IPC boundary as base64 inside a
   * JSON string, which is fine for icons and documents and wrong for video.
   */
  readBinary: async (path: string): Promise<Uint8Array> =>
    decode(await invoke<string>("filesystem.readBinary", { path })),

  writeBinary: (
    path: string,
    data: BinaryInput,
    options?: { createDirs?: boolean },
  ) =>
    invoke<null>("filesystem.writeBinary", {
      path,
      data: encode(data),
      createDirs: options?.createDirs ?? false,
    }),

  /** Directories first, then files, both case-insensitively by name. */
  readDir: (path: string) => invoke<DirEntry[]>("filesystem.readDir", { path }),

  exists: (path: string) => invoke<boolean>("filesystem.exists", { path }),

  stat: (path: string) => invoke<FileInfo>("filesystem.stat", { path }),

  mkdir: (path: string, options?: { recursive?: boolean }) =>
    invoke<null>("filesystem.mkdir", {
      path,
      recursive: options?.recursive ?? false,
    }),

  /** Removing a non-empty directory needs `{ recursive: true }`. */
  remove: (path: string, options?: { recursive?: boolean }) =>
    invoke<null>("filesystem.remove", {
      path,
      recursive: options?.recursive ?? false,
    }),

  copy: (from: string, to: string) =>
    invoke<null>("filesystem.copy", { from, to }),

  rename: (from: string, to: string) =>
    invoke<null>("filesystem.rename", { from, to }),

  /**
   * Be told when a path changes, instead of polling it.
   *
   * Scoped exactly like a read: watching a path you cannot read is denied.
   * A directory reports its own children; pass `{ recursive: true }` for
   * everything below it.
   *
   * ```ts
   * const { id } = await filesystem.watch(dir, { recursive: true });
   * filesystem.onChange((change) => console.log(change.kind, change.path));
   * // later
   * await filesystem.unwatch(id);
   * ```
   */
  watch: (path: string, options?: { recursive?: boolean }) =>
    invoke<Watch>("filesystem.watch", {
      path,
      recursive: options?.recursive ?? false,
    }),

  /** Stop a watch. Throws `NOT_FOUND` if it is not running. */
  unwatch: (id: string) => invoke<null>("filesystem.unwatch", { id }),

  /** The ids of every watch this application has running. */
  watches: () => invoke<string[]>("filesystem.watches"),

  /**
   * Every watch reports here. Filter on `id` if you have more than one.
   *
   * Returns an unsubscribe function.
   */
  onChange: (handler: (change: FileChange) => void) =>
    listen<FileChange>("filesystem.changed", handler),
};
