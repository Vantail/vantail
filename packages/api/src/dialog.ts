import { invoke } from "./transport.js";

export interface FileFilter {
  /** Shown in the dialog's file-type dropdown, e.g. "Markdown". */
  name: string;
  /** Extensions without the dot, e.g. `["md", "markdown"]`. */
  extensions: string[];
}

export interface OpenOptions {
  title?: string;
  /** A file or directory to open the dialog at. */
  defaultPath?: string;
  filters?: FileFilter[];
}

export interface SaveOptions {
  title?: string;
  defaultPath?: string;
  /** Pre-filled file name. */
  defaultName?: string;
  filters?: FileFilter[];
}

export interface MessageOptions {
  title?: string;
  kind?: "info" | "warning" | "error";
}

export interface ConfirmOptions extends MessageOptions {
  okLabel?: string;
  cancelLabel?: string;
}

/**
 * Native dialogs.
 *
 * A path the user picks here is also *granted* to `filesystem` for the rest
 * of the session - the user's choice is the authorisation. That is what makes
 * a tight `permissions.filesystem` scope practical.
 *
 * Every picker resolves to `null` when the user cancels.
 */
export const dialog = {
  openFile: (options: OpenOptions = {}) =>
    invoke<string | null>("dialog.openFile", { ...options, multiple: false }),

  openFiles: (options: OpenOptions = {}) =>
    invoke<string[]>("dialog.openFile", { ...options, multiple: true }),

  openDirectory: (options: OpenOptions = {}) =>
    invoke<string | null>("dialog.openDirectory", {
      ...options,
      multiple: false,
    }),

  openDirectories: (options: OpenOptions = {}) =>
    invoke<string[]>("dialog.openDirectory", { ...options, multiple: true }),

  saveFile: (options: SaveOptions = {}) =>
    invoke<string | null>("dialog.saveFile", { ...options, multiple: false }),

  /** An informational dialog with a single dismiss button. */
  message: (message: string, options: MessageOptions = {}) =>
    invoke<null>("dialog.message", { ...options, message }),

  /** Resolves `true` when the user accepts. */
  confirm: (message: string, options: ConfirmOptions = {}) =>
    invoke<boolean>("dialog.confirm", { ...options, message }),
};
