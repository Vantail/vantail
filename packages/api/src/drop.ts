import { listen } from "./transport.js";

export interface DropEvent {
  /** Absolute paths of what was dropped. */
  paths: string[];
  /** Where, relative to the window's top-left corner. */
  position: { x: number; y: number };
}

/**
 * Files dragged onto the window.
 *
 * HTML5 drag events give a page the *contents* of a dropped file but never its
 * path, so a dropped file cannot be handed to {@link filesystem}. These events
 * carry the paths, and a dropped path becomes readable for the rest of the
 * session - dropping a file is the user choosing it, exactly as a dialog is.
 * (`filesystem.grantFromDrop`, on by default, controls that.)
 *
 * Needs `permissions.dragDrop`. **Turning it on changes what the page sees:**
 * the runtime handles the drop, so HTML5 `drop` events stop firing for files
 * and these arrive instead. With the permission off, nothing changes.
 *
 * ```ts
 * fileDrop.onDrop(async ({ paths }) => {
 *   for (const path of paths) console.log(await filesystem.readText(path));
 * });
 * ```
 */
export const fileDrop = {
  /** A drag arrived over the window, carrying these paths. */
  onEnter: (handler: (event: DropEvent) => void) =>
    listen<DropEvent>("drop.entered", handler),

  /** They were let go. */
  onDrop: (handler: (event: DropEvent) => void) =>
    listen<DropEvent>("drop.dropped", handler),

  /** The drag left the window, or was cancelled. */
  onLeave: (handler: () => void) =>
    listen<Record<string, never>>("drop.left", handler),
};
