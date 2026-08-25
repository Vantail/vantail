import { invoke, listen } from "./transport.js";

export interface RunOptions {
  /** Working directory. Must be inside the `cwd` scope of the matching rule. */
  cwd?: string;
  env?: Record<string, string>;
  /** Start from an empty environment instead of inheriting this process's. */
  clearEnv?: boolean;
}

export interface ExecuteOptions extends RunOptions {
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
  /** Kill the child after this long. */
  timeoutMs?: number;
}

export interface ExecuteResult {
  /** `null` when the process was killed by a signal. */
  code: number | null;
  /** Unix only. */
  signal: number | null;
  success: boolean;
  stdout: string;
  stderr: string;
}

export interface ExitEvent {
  code: number | null;
  signal: number | null;
  success: boolean;
}

/** A running process started with {@link process.spawn}. */
export interface Child {
  /** The handle used by every call below. Not the OS pid. */
  readonly id: number;
  /** The operating system's process id, for display and for `ps`. */
  readonly pid: number;

  write(data: string): Promise<null>;
  closeStdin(): Promise<null>;
  kill(): Promise<null>;

  /**
   * Output as it arrives, in chunks rather than lines - a program drawing a
   * progress bar with `\r` never emits a newline, and buffering for one would
   * make it look hung. Split on newlines yourself if that is what you want.
   */
  onStdout(handler: (data: string) => void): () => void;
  onStderr(handler: (data: string) => void): () => void;
  onExit(handler: (event: ExitEvent) => void): () => void;
}

/**
 * Running other programs.
 *
 * Every program must be named in `permissions.shell.allow`, and arguments are
 * passed as a vector rather than a command line - there is no shell anywhere
 * in this path, so there is nothing for an argument to inject into.
 *
 * ```ts
 * const { stdout } = await process.execute("git", ["status", "--porcelain"]);
 * ```
 */
export const process = {
  /** Run a program to completion and collect its output. */
  execute: (
    program: string,
    args: string[] = [],
    options: ExecuteOptions = {},
  ) => invoke<ExecuteResult>("process.execute", { program, args, ...options }),

  /** Start a program and stream its output. */
  spawn: async (
    program: string,
    args: string[] = [],
    options: RunOptions = {},
  ): Promise<Child> => {
    const { id, pid } = await invoke<{ id: number; pid: number }>(
      "process.spawn",
      {
        program,
        args,
        ...options,
      },
    );
    return child(id, pid);
  },

  /** Everything this application has started and not yet seen exit. */
  list: () =>
    invoke<{ id: number; pid: number; program: string }[]>("process.list"),
};

function child(id: number, pid: number): Child {
  const forId = <T extends { id: number }>(
    event: string,
    handler: (payload: T) => void,
  ) =>
    listen<T>(event, (payload) => {
      if (payload.id === id) handler(payload);
    });

  return {
    id,
    pid,

    write: (data) => invoke<null>("process.write", { id, data }),
    closeStdin: () => invoke<null>("process.closeStdin", { id }),
    kill: () => invoke<null>("process.kill", { id }),

    onStdout: (handler) =>
      forId<{ id: number; data: string }>("process.stdout", ({ data }) =>
        handler(data),
      ),
    onStderr: (handler) =>
      forId<{ id: number; data: string }>("process.stderr", ({ data }) =>
        handler(data),
      ),
    onExit: (handler) =>
      forId<ExitEvent & { id: number }>("process.exit", handler),
  };
}
