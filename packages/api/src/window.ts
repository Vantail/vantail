import { VantailError } from "./error.js";
import { invoke, listen, windowLabel } from "./transport.js";
import type { TitleBarMetrics, VantailBridge } from "./protocol.js";

export interface Size {
  width: number;
  height: number;
}

export interface Position {
  x: number;
  y: number;
}

/** Everything a new window can be given, matching `window` in the config. */
export interface WindowOptions {
  /** Path within the application, e.g. `settings.html` or `/#/settings`. */
  url?: string;
  /**
   * Resolve only once the new window's page has loaded. Default `true`.
   *
   * A window exists before its document does, so without this a message sent
   * straight after `createWindow` would arrive at a webview with nothing
   * listening yet, and vanish.
   */
  waitForReady?: boolean;
  /** How long to wait for that. Default 15000. */
  readyTimeoutMs?: number;
  title?: string;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  x?: number;
  y?: number;
  resizable?: boolean;
  maximized?: boolean;
  fullscreen?: boolean;
  decorations?: boolean;
  /**
   * Whether the title bar is a bar, or space your application draws in.
   *
   * `hidden` is what every editor and browser does: no title bar, the page
   * running to the top edge of the window, and a toolbar of your own where
   * the bar would have been.
   *
   * On macOS the traffic lights stay - they are the system's, and an
   * application drawing its own gets them subtly wrong. Windows and Linux
   * have no way to keep the buttons without the bar, so `hidden` there is an
   * undecorated window and your toolbar has to include close and minimise.
   *
   * A window with no title bar has nothing to drag it by. Give your toolbar
   * `appWindow.startDragging()` on `pointerdown`.
   */
  titleBarStyle?: TitleBarStyle;
  /**
   * Nudge the traffic lights, for a toolbar taller than the bar it replaced.
   * Logical pixels from the top left. macOS only.
   */
  trafficLightPosition?: { x: number; y: number };
  /**
   * How tall the bar your application draws should be.
   *
   * Defaults to the height of the platform's own, which is what makes a
   * custom bar read as a title bar rather than as a div. Set it larger for a
   * browser-style toolbar and the traffic lights are re-centred in it - the
   * part that is easy to get wrong by hand, and obvious the moment it is.
   */
  titleBarHeight?: number;
  /**
   * Whether the platform draws the window buttons, or you do.
   *
   * macOS keeps its traffic lights when the title bar is hidden, and they are
   * a fixed size. `hidden` takes them away so you can draw your own - bigger,
   * or in your own style - the way you already have to on the platforms that
   * keep nothing.
   *
   * With them hidden, `insetLeft` is `0`: the same signal those platforms
   * already give, so code that draws its own controls when nothing is
   * reserved needs no new branch.
   */
  titleBarButtons?: TitleBarButtons;
  transparent?: boolean;
  alwaysOnTop?: boolean;
  center?: boolean;
  visible?: boolean;
  closeBehavior?: CloseBehavior;
}

/**
 * What a window's own close button does.
 *
 * - `close` - destroy it. With no other windows open and
 *   `quitOnLastWindowClosed`, that ends the application.
 * - `hide` - hide it instead. The webview keeps running, so timers keep
 *   firing and sockets stay connected. This is what a tray application wants.
 * - `ask` - do nothing, and let `onCloseRequested` decide.
 *
 * There is no `preventDefault()` here on purpose: it would mean the runtime
 * waiting on an answer from JavaScript before it could close a window, and an
 * application that never answered would have a window nobody could shut.
 * Declaring the behaviour is the same thing without that failure mode.
 */
export type CloseBehavior = "close" | "hide" | "ask";

/**
 * `default` keeps the platform's title bar. `hidden` removes it and lets the
 * page run to the top edge of the window - see `titleBarStyle`.
 */
export type TitleBarStyle = "default" | "hidden";

/** Who draws close, minimise and zoom. */
export type TitleBarButtons = "system" | "hidden";

/**
 * The room a hidden title bar left behind, without awaiting.
 *
 * `undefined` outside a Vantail window. All zeroes when this window has an
 * ordinary title bar, since there is then nothing to leave room for.
 *
 * The same numbers are already on `:root` as CSS variables before the page
 * lays out, so reach for those first:
 *
 * ```css
 * .toolbar {
 *   height: var(--vantail-titlebar-height);
 *   padding-left: var(--vantail-titlebar-inset-left);
 *   padding-right: var(--vantail-titlebar-inset-right);
 * }
 * ```
 *
 * This is for the cases CSS cannot reach - laying out a canvas, or deciding
 * whether to draw your own window controls:
 *
 * ```ts
 * const { insetLeft } = titleBarMetrics() ?? { insetLeft: 0 };
 * if (insetLeft === 0) drawOwnWindowControls();
 * ```
 */
export function titleBarMetrics(): TitleBarMetrics | undefined {
  return (globalThis as { __VANTAIL__?: VantailBridge }).__VANTAIL__?.titleBar;
}

/**
 * A handle to one window.
 *
 * `appWindow` is the window your code is running in. `getWindow(label)` is any
 * other. The two are the same object shape, so code that adjusts a window does
 * not care which one it was handed.
 */
export interface WindowHandle {
  /** `undefined` on `appWindow`, which always means "whichever window I am". */
  readonly label: string | undefined;

  setTitle(title: string): Promise<null>;
  title(): Promise<string>;

  setSize(width: number, height: number): Promise<null>;
  size(): Promise<Size>;
  setPosition(x: number, y: number): Promise<null>;
  position(): Promise<Position>;
  center(): Promise<null>;

  minimize(): Promise<null>;
  unminimize(): Promise<null>;
  /**
   * Stop the user shrinking the window below this. Pass `null` to remove it.
   *
   * Logical pixels, like every other window measurement.
   */
  setMinSize(width: number | null, height: number | null): Promise<null>;
  /** The other end. `null` removes it. */
  setMaxSize(width: number | null, height: number | null): Promise<null>;
  /**
   * Keep the window out of the taskbar. Windows and Linux only - macOS has no
   * taskbar, and answers `UNSUPPORTED`.
   */
  setSkipTaskbar(value: boolean): Promise<null>;

  maximize(): Promise<null>;
  unmaximize(): Promise<null>;
  toggleMaximize(): Promise<boolean>;
  isMaximized(): Promise<boolean>;

  setFullscreen(value: boolean): Promise<null>;
  isFullscreen(): Promise<boolean>;
  setResizable(value: boolean): Promise<null>;
  setAlwaysOnTop(value: boolean): Promise<null>;

  /**
   * Drag the window from wherever the pointer is.
   *
   * What a title bar would have done for you. Call it on `pointerdown` in
   * your own toolbar and the platform takes the drag from there:
   *
   * ```ts
   * toolbar.addEventListener("pointerdown", (event) => {
   *   // Let buttons and inputs be clicked rather than dragged.
   *   if ((event.target as Element).closest("button, input, a")) return;
   *   if (event.buttons === 1) void appWindow.startDragging();
   * });
   * ```
   *
   * `-webkit-app-region: drag` is a Chromium extension and does nothing in a
   * WKWebView, which is why this is a call rather than a CSS property.
   */
  startDragging(): Promise<null>;

  /**
   * Switch between an ordinary title bar and one your application draws in,
   * on a window that is already open.
   *
   * Answers with the room the new arrangement leaves. The CSS variables and
   * {@link titleBarMetrics} are updated before it resolves, so a toolbar
   * sized from either resizes with the change.
   *
   * ```ts
   * const { height } = await appWindow.setTitleBarStyle("hidden");
   * ```
   *
   * On macOS the switch is seamless. Everywhere else the only lever is the
   * window frame, so this adds and removes decorations - and switching back
   * restores what the config asked for rather than assuming a frame.
   */
  setTitleBarStyle(style: TitleBarStyle): Promise<TitleBarMetrics>;

  /** Which one this window is using now. */
  titleBarStyle(): Promise<TitleBarStyle>;

  /**
   * Hand the window buttons to your application, or take them back.
   *
   * ```ts
   * await appWindow.setTitleBarButtons("hidden"); // draw your own
   * ```
   *
   * Answers with the metrics, whose `insetLeft` is then `0`.
   */
  setTitleBarButtons(buttons: TitleBarButtons): Promise<TitleBarMetrics>;

  /** Which of the two this window is using. */
  titleBarButtons(): Promise<TitleBarButtons>;

  /**
   * Ask for a bar of a particular height; `null` for the platform's own.
   *
   * ```ts
   * await appWindow.setTitleBarHeight(48); // a browser-style toolbar
   * await appWindow.setTitleBarHeight(null); // back to the platform's
   * ```
   *
   * The traffic lights move to the middle of the new height, and the CSS
   * variables follow, so a toolbar sized from them resizes with it.
   */
  setTitleBarHeight(height: number | null): Promise<TitleBarMetrics>;

  /**
   * Move the traffic lights, for a toolbar taller than the bar they came
   * from. Logical pixels from the top left.
   *
   * macOS only; `UNSUPPORTED` everywhere else, since nowhere else has them.
   */
  setTrafficLightPosition(x: number, y: number): Promise<TitleBarMetrics>;

  /**
   * Put them back in the middle of the bar, which is where they sit unless
   * you have moved them.
   */
  centerTrafficLights(): Promise<TitleBarMetrics>;

  setCloseBehavior(behavior: CloseBehavior): Promise<null>;
  closeBehavior(): Promise<CloseBehavior>;

  show(): Promise<null>;
  hide(): Promise<null>;
  isVisible(): Promise<boolean>;
  focus(): Promise<null>;
  close(): Promise<boolean>;
  exists(): Promise<boolean>;

  openDevtools(): Promise<null>;

  /**
   * Window events reach only the window they happened to, so these fire for
   * `appWindow` and stay quiet on a handle to somebody else's window.
   */
  onResized(handler: (size: Size) => void): () => void;
  onMoved(handler: (position: Position) => void): () => void;
  onFocusChanged(handler: (state: { focused: boolean }) => void): () => void;
  /**
   * The close button was pressed. `outcome` says what the runtime did:
   * `hidden` under `hide`, or `ignored` under `ask` - in which case closing
   * or hiding the window is now your job.
   *
   * Not emitted under `close`, where the window is already gone.
   */
  onCloseRequested(
    handler: (event: { outcome: "hidden" | "ignored" }) => void,
  ): () => void;
}

function handle(label?: string): WindowHandle {
  // Omitting `label` entirely lets the runtime answer for the calling window,
  // which is what makes one implementation serve both cases.
  const target = label === undefined ? {} : { label };
  const call = <T>(method: string, params: object = {}) =>
    invoke<T>(method, { ...target, ...params });

  const scoped = <T extends { label?: string }>(
    event: string,
    handler: (payload: T) => void,
  ) => {
    // `appWindow` has no label of its own, but it still means *this* window -
    // so fall back to the one the runtime injected rather than taking
    // everything that happens to arrive.
    const mine = label ?? windowLabel();
    return listen<T>(event, (payload) => {
      if (
        mine !== undefined &&
        payload.label !== undefined &&
        payload.label !== mine
      )
        return;
      handler(payload);
    });
  };

  return {
    label,

    setTitle: (title) => call<null>("window.setTitle", { title }),
    title: () => call<string>("window.title"),

    setSize: (width, height) => call<null>("window.setSize", { width, height }),
    size: () => call<Size>("window.size"),
    setPosition: (x, y) => call<null>("window.setPosition", { x, y }),
    position: () => call<Position>("window.position"),
    center: () => call<null>("window.center"),

    minimize: () => call<null>("window.minimize"),
    unminimize: () => call<null>("window.unminimize"),
    setMinSize: (width: number | null, height: number | null) =>
      call<null>("window.setMinSize", { width, height }),
    setMaxSize: (width: number | null, height: number | null) =>
      call<null>("window.setMaxSize", { width, height }),
    setSkipTaskbar: (value: boolean) =>
      call<null>("window.setSkipTaskbar", { value }),

    maximize: () => call<null>("window.maximize"),
    unmaximize: () => call<null>("window.unmaximize"),
    toggleMaximize: () => call<boolean>("window.toggleMaximize"),
    isMaximized: () => call<boolean>("window.isMaximized"),

    setFullscreen: (value) => call<null>("window.setFullscreen", { value }),
    isFullscreen: () => call<boolean>("window.isFullscreen"),
    setResizable: (value) => call<null>("window.setResizable", { value }),
    setAlwaysOnTop: (value) => call<null>("window.setAlwaysOnTop", { value }),

    setTitleBarStyle: (style) =>
      call<TitleBarMetrics>("window.setTitleBarStyle", { style }),
    titleBarStyle: () => call<TitleBarStyle>("window.titleBarStyle"),
    setTitleBarButtons: (buttons) =>
      call<TitleBarMetrics>("window.setTitleBarButtons", { buttons }),
    titleBarButtons: () => call<TitleBarButtons>("window.titleBarButtons"),
    setTitleBarHeight: (height) =>
      call<TitleBarMetrics>("window.setTitleBarHeight", { height }),

    startDragging: () => call<null>("window.startDragging"),
    setTrafficLightPosition: (x, y) =>
      call<TitleBarMetrics>("window.setTrafficLightPosition", { x, y }),
    centerTrafficLights: () =>
      call<TitleBarMetrics>("window.centerTrafficLights"),

    setCloseBehavior: (behavior) =>
      call<null>("window.setCloseBehavior", { behavior }),
    closeBehavior: () => call<CloseBehavior>("window.closeBehavior"),

    show: () => call<null>("window.show"),
    hide: () => call<null>("window.hide"),
    isVisible: () => call<boolean>("window.isVisible"),
    focus: () => call<null>("window.focus"),
    close: () => call<boolean>("window.close"),
    exists: () => call<boolean>("window.exists"),

    openDevtools: () => call<null>("window.openDevtools"),

    onResized: (fn) => scoped<Size & { label?: string }>("window.resized", fn),
    onMoved: (fn) => scoped<Position & { label?: string }>("window.moved", fn),
    onFocusChanged: (fn) =>
      scoped<{ focused: boolean; label?: string }>("window.focus", fn),
    onCloseRequested: (fn) =>
      scoped<{ outcome: "hidden" | "ignored"; label?: string }>(
        "window.closeRequested",
        fn,
      ),
  };
}

/**
 * The window this code is running in.
 *
 * Note this shadows the global `window` when imported under that name. Import
 * it as `appWindow` if you need both.
 */
export const appWindow: WindowHandle = handle();

/** A handle to another window. Calls on a window that is gone reject. */
export function getWindow(label: string): WindowHandle {
  return handle(label);
}

/**
 * Open a new window and return a handle to it.
 *
 * Labels are how every other call names this window, so they have to be
 * unique - creating one that already exists rejects with `ALREADY_EXISTS`.
 */
export async function createWindow(
  label: string,
  options: WindowOptions = {},
): Promise<WindowHandle> {
  const {
    url,
    waitForReady = true,
    readyTimeoutMs = 15_000,
    ...window
  } = options;

  // Subscribed before the window is asked for, so a page that loads instantly
  // cannot report ready before anyone is listening.
  const ready = waitForReady ? waitFor(label, readyTimeoutMs) : undefined;

  try {
    await invoke<string>("window.create", {
      label,
      ...(url === undefined ? {} : { url }),
      window,
    });
  } catch (error) {
    ready?.cancel();
    throw error;
  }

  await ready?.promise;
  return handle(label);
}

function waitFor(
  label: string,
  timeoutMs: number,
): { promise: Promise<void>; cancel(): void } {
  let settle: (() => void) | undefined;
  let fail: ((error: Error) => void) | undefined;

  const stop = listen<{ label: string }>("window.ready", (event) => {
    if (event.label === label) settle?.();
  });

  const timer = setTimeout(() => {
    fail?.(
      new VantailError(
        "INTERNAL",
        `The window "${label}" opened but its page did not finish loading within ${timeoutMs}ms. ` +
          `Check the URL it was given, or pass { waitForReady: false }.`,
      ),
    );
  }, timeoutMs);

  const promise = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  }).finally(() => {
    clearTimeout(timer);
    stop();
  });

  return {
    promise,
    cancel: () => {
      clearTimeout(timer);
      stop();
      // Nothing is awaiting it, but an unhandled rejection would still be
      // reported if the timer had already fired.
      settle?.();
    },
  };
}

/** Fires when a window's page has finished loading. */
export function onWindowReady(
  handler: (event: { label: string }) => void,
): () => void {
  return listen<{ label: string }>("window.ready", handler);
}

/** Labels of every open window, in the order they were opened. */
export function listWindows(): Promise<string[]> {
  return invoke<string[]>("window.list");
}

/** The label of the calling window, without awaiting. */
export function currentWindow(): string | undefined {
  return windowLabel();
}

export function onWindowCreated(
  handler: (event: { label: string }) => void,
): () => void {
  return listen<{ label: string }>("window.created", handler);
}

export function onWindowClosed(
  handler: (event: { label: string }) => void,
): () => void {
  return listen<{ label: string }>("window.closed", handler);
}
