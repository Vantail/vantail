/**
 * Just enough DOM to keep the panels about the API rather than about markup.
 *
 * Every panel gets the same shape: a title, a sentence saying what the API is
 * for, some controls, and one output area. Nothing here is Vantail-specific.
 */

import { VantailError } from "@vantail/api";

export interface Panel {
  id: string;
  title: string;
  root: HTMLElement;
  /** A line of controls. */
  row(...nodes: (Node | string)[]): HTMLElement;
  button(label: string, run: () => unknown): HTMLButtonElement;
  input(placeholder: string, value?: string): HTMLInputElement;
  /** Replace the output with a value, formatted if it is not a string. */
  out(value: unknown): void;
  /** Add a line to the output, keeping what is already there. */
  log(line: string): void;
  /** A quiet aside, for a caveat that belongs next to the control. */
  note(text: string): void;
}

function format(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "(nothing returned)";
  if (value instanceof Uint8Array) {
    return `${value.length} bytes: ${[...value.slice(0, 12)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ")}${value.length > 12 ? " ..." : ""}`;
  }
  return JSON.stringify(value, null, 2);
}

/**
 * What a failure looks like.
 *
 * Every rejection carries a stable `code`, and printing it is the point: an
 * application branches on the code, never on the message.
 */
function describe(cause: unknown): string {
  if (cause instanceof VantailError) return `${cause.code}: ${cause.message}`;
  return cause instanceof Error ? cause.message : String(cause);
}

export function panel(id: string, title: string, blurb: string): Panel {
  const root = document.createElement("section");
  root.className = "panel";
  root.id = `panel-${id}`;

  const heading = document.createElement("h2");
  heading.textContent = title;
  root.append(heading);

  const description = document.createElement("p");
  description.className = "blurb";
  description.textContent = blurb;
  root.append(description);

  const output = document.createElement("pre");
  output.className = "out";
  output.textContent = "";

  const api: Panel = {
    id,
    title,
    root,
    row(...nodes) {
      const line = document.createElement("div");
      line.className = "row";
      line.append(...nodes);
      root.insertBefore(line, output);
      return line;
    },
    button(label, run) {
      const element = document.createElement("button");
      element.textContent = label;
      element.addEventListener("click", async () => {
        element.disabled = true;
        try {
          const result = await run();
          if (result !== undefined) api.out(result);
        } catch (cause) {
          output.classList.add("failed");
          output.textContent = describe(cause);
        } finally {
          element.disabled = false;
        }
      });
      return element;
    },
    input(placeholder, value = "") {
      const element = document.createElement("input");
      element.placeholder = placeholder;
      element.value = value;
      return element;
    },
    out(value) {
      output.classList.remove("failed");
      output.textContent = format(value);
    },
    log(line) {
      output.classList.remove("failed");
      const stamp = new Date().toLocaleTimeString();
      output.textContent = `${stamp}  ${line}\n${output.textContent}`.slice(0, 4000);
    },
    note(text) {
      const aside = document.createElement("p");
      aside.className = "note";
      aside.textContent = text;
      root.insertBefore(aside, output);
    },
  };

  root.append(output);
  return api;
}
