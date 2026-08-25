/** Terminal output. Small on purpose - the CLI should be quiet. */

const ESC = String.fromCharCode(27);
const enabled = process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;

const wrap = (code: string) => (text: string) =>
  enabled ? `${ESC}[${code}m${text}${ESC}[0m` : text;

export const style = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
};

const tag = style.magenta("vantail");

export const log = {
  info(message: string): void {
    console.log(`${tag} ${message}`);
  },
  step(message: string): void {
    console.log(`${tag} ${style.dim(message)}`);
  },
  warn(message: string): void {
    console.warn(`${tag} ${style.yellow("warning")} ${message}`);
  },
  error(message: string): void {
    console.error(`${tag} ${style.red("error")} ${message}`);
  },
  ok(message: string): void {
    console.log(`${tag} ${style.green("ok")} ${message}`);
  },
  blank(): void {
    console.log("");
  },
};

/** Format a byte count the way a build tool should. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
