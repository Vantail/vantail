/**
 * `@vantail/api` - the native surface of a Vantail application.
 *
 * ```ts
 * import { dialog, filesystem } from "@vantail/api";
 *
 * const path = await dialog.openFile();
 * if (path) console.log(await filesystem.readText(path));
 * ```
 *
 * There is no Node.js here: no `node:fs`, no `require`, no npm package with a
 * native addon. Just the browser you already know, plus these calls.
 */

export {
  app,
  type AppInfo,
  type ProgressOptions,
  type ProgressState,
} from "./app.js";
export { autostart } from "./autostart.js";
export { clipboard, type ClipboardImage } from "./clipboard.js";
export { deepLink } from "./deeplink.js";
export { fileDrop, type DropEvent } from "./drop.js";
export {
  dialog,
  type ConfirmOptions,
  type FileFilter,
  type MessageOptions,
  type OpenOptions,
  type SaveOptions,
} from "./dialog.js";
export {
  filesystem,
  type DirEntry,
  type FileChange,
  type FileInfo,
  type Watch,
} from "./filesystem.js";
export { hid, type HidConnection, type HidDeviceInfo } from "./hid.js";
export { mdns, type DiscoveredService, type DiscoverOptions } from "./mdns.js";
export { menu, type MenuItem, type PredefinedMenuItem } from "./menu.js";
export {
  network,
  type NetworkRequestOptions,
  type NetworkResponse,
} from "./network.js";
export { notification, type NotificationOptions } from "./notification.js";
export { os, type OsInfo, type Platform } from "./os.js";
export {
  process,
  type Child,
  type ExecuteOptions,
  type ExecuteResult,
  type ExitEvent,
  type RunOptions,
} from "./process.js";
export { screen, type Screen } from "./screen.js";
export { power } from "./power.js";
export { secrets } from "./secrets.js";
export { shell } from "./shell.js";
export { shortcut, type RegisterOptions, type Shortcut } from "./shortcut.js";
export { tray, type TrayClick, type TrayOptions } from "./tray.js";
export {
  updater,
  type DownloadProgress,
  type DownloadResult,
  type NoUpdate,
  type UpdateAvailable,
  type UpdateCheck,
} from "./updater.js";
export {
  appWindow,
  appWindow as window,
  createWindow,
  currentWindow,
  getWindow,
  listWindows,
  onWindowClosed,
  onWindowCreated,
  onWindowReady,
  type CloseBehavior,
  type Position,
  type Size,
  type WindowHandle,
  type WindowOptions,
} from "./window.js";

export { type BinaryInput } from "./binary.js";
export { VantailError } from "./error.js";
export {
  invoke,
  isVantail,
  listen,
  runtimeVersion,
  windowLabel,
} from "./transport.js";
export { ErrorCode } from "./protocol.js";
export type {
  VantailBridge,
  VantailErrorPayload,
  VantailIncoming,
  VantailRequest,
  VantailResponse,
} from "./protocol.js";
