import { invoke, listen } from "./transport.js";

/** A menu entry. `type` defaults to `normal`. */
export type MenuItem =
  | {
      type?: "normal";
      id: string;
      label: string;
      enabled?: boolean;
      /** e.g. `CmdOrCtrl+S`, `Alt+Shift+F4`. */
      accelerator?: string;
    }
  | {
      type: "checkbox";
      id: string;
      label: string;
      checked?: boolean;
      enabled?: boolean;
      accelerator?: string;
    }
  | { type: "submenu"; label: string; items: MenuItem[]; enabled?: boolean }
  | { type: "separator" }
  | { type: "predefined"; item: PredefinedMenuItem; label?: string };

export type PredefinedMenuItem =
  | "separator"
  | "copy"
  | "cut"
  | "paste"
  | "selectAll"
  | "undo"
  | "redo"
  | "minimize"
  | "maximize"
  | "fullscreen"
  | "hide"
  | "hideOthers"
  | "showAll"
  | "closeWindow"
  | "quit"
  | "about"
  | "services"
  | "bringAllToFront";

/**
 * The application menu.
 *
 * On macOS this is the menu bar, and it is not optional decoration: the
 * predefined `copy`, `paste`, `undo` and `selectAll` items are what make
 * those keyboard shortcuts work at all. An app that sets no menu has no
 * working Cmd-C.
 *
 * ```ts
 * await menu.set([
 *   { type: "submenu", label: "File", items: [
 *     { id: "new", label: "New", accelerator: "CmdOrCtrl+N" },
 *     { type: "separator" },
 *     { type: "predefined", item: "quit" },
 *   ]},
 *   { type: "submenu", label: "Edit", items: [
 *     { type: "predefined", item: "undo" },
 *     { type: "predefined", item: "copy" },
 *     { type: "predefined", item: "paste" },
 *   ]},
 * ]);
 *
 * menu.onClick(({ id }) => { if (id === "new") newDocument(); });
 * ```
 */
export const menu = {
  set: (items: MenuItem[]) =>
    invoke<null>("menu.set", { items: normalize(items) }),
  remove: () => invoke<null>("menu.remove"),

  setEnabled: (id: string, enabled: boolean) =>
    invoke<null>("menu.setEnabled", { id, enabled }),
  setLabel: (id: string, label: string) =>
    invoke<null>("menu.setLabel", { id, label }),
  setChecked: (id: string, checked: boolean) =>
    invoke<null>("menu.setChecked", { id, checked }),
  isChecked: (id: string) => invoke<boolean>("menu.isChecked", { id }),

  /**
   * Show a context menu. Position is in logical pixels relative to the
   * window; the cursor is used when it is omitted.
   */
  popup: (
    items: MenuItem[],
    options: { x?: number; y?: number; label?: string } = {},
  ) => invoke<null>("menu.popup", { ...options, items: normalize(items) }),

  /** Fires for any item with an `id`, in the app menu, a tray menu or a popup. */
  onClick: (handler: (event: { id: string }) => void) =>
    listen<{ id: string }>("menu.click", handler),
};

/**
 * Fill in the `type` the runtime insists on.
 *
 * `{ id, label }` is the item people write nine times out of ten, and the
 * runtime's parser is a tagged union with no default - which is exactly what
 * makes a misspelled `type` an error instead of a silent normal item.
 */
export function normalize(items: MenuItem[]): MenuItem[] {
  return items.map((item) => {
    const entry = { type: "normal", ...item } as MenuItem & {
      items?: MenuItem[];
    };
    return entry.items ? { ...entry, items: normalize(entry.items) } : entry;
  });
}
