/**
 * Argument parsing.
 *
 * Small enough to own: three commands, a handful of flags, and no need for a
 * dependency that has to be kept up to date.
 */

export interface ParsedArgs {
  command: string | undefined;
  flags: Map<string, string | boolean>;
  positional: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  let command: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;

    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const equals = body.indexOf("=");

      if (equals !== -1) {
        flags.set(body.slice(0, equals), body.slice(equals + 1));
        continue;
      }
      if (body.startsWith("no-")) {
        flags.set(body.slice(3), false);
        continue;
      }

      // A following value that is not itself a flag belongs to this one.
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags.set(body, next);
        index += 1;
      } else {
        flags.set(body, true);
      }
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      const short = arg.slice(1);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags.set(short, next);
        index += 1;
      } else {
        flags.set(short, true);
      }
      continue;
    }

    if (command === undefined) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }

  return { command, flags, positional };
}

export function stringFlag(
  args: ParsedArgs,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = args.flags.get(name);
    if (typeof value === "string") return value;
  }
  return undefined;
}

export function boolFlag(args: ParsedArgs, ...names: string[]): boolean | undefined {
  for (const name of names) {
    const value = args.flags.get(name);
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return undefined;
}

export function numberFlag(args: ParsedArgs, ...names: string[]): number | undefined {
  const value = stringFlag(args, ...names);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${names[0]} expects a number, got "${value}"`);
  }
  return parsed;
}
