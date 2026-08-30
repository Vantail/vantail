/**
 * `vantail.config.ts` - the whole configuration surface.
 *
 * Deliberately small. Anything that can be derived (output directories, dev
 * server URL, platform triples) is derived rather than configured.
 */

export interface AppConfig {
  /** Human-readable name. Used for the window title and the bundle name. */
  name: string;
  /** Reverse-DNS bundle identifier, e.g. `dev.wissen.myapp`. */
  identifier: string;
  version?: string;
  /**
   * A square PNG, relative to this config file. Every icon a platform asks
   * for is scaled down from it, so give it at least 256x256 - 1024x1024 if
   * you have it.
   */
  icon?: string;
}

export interface WindowConfig {
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
  /**
   * What shows through before the page has painted, as `#rgb` or `#rrggbb`.
   *
   * Worth setting. A web view paints on its own schedule and is a frame or two
   * behind the window during a live resize, so growing a window quickly leaves
   * a strip down the right the page has not reached yet. Whatever is under it
   * shows, and by default that is a neutral grey that reads as a hole. Matched
   * to your own background it is invisible instead.
   *
   * It does not make the page paint any sooner - nothing can. It stops the gap
   * being conspicuous while it lasts.
   */
  backgroundColor?: string;
  titleBarStyle?: TitleBarStyle;
  /**
   * Nudge the traffic lights, for a toolbar taller than the bar it replaced.
   * Logical pixels from the top left. macOS only.
   */
  /**
   * Where to put the window buttons, macOS only.
   *
   * `y` is optional: leave it out to nudge the group sideways and let them
   * stay centred in whatever height the bar is - which also means the nudge
   * survives a change of `titleBarHeight` instead of needing to be redone.
   */
  trafficLightPosition?: { x: number; y?: number };
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
  /** Centre on the current monitor unless `x`/`y` are given. Default `true`. */
  center?: boolean;
  visible?: boolean;
  /**
   * What the window's own close button does. `close` destroys it (the
   * default), `hide` keeps the webview - and everything it is doing -
   * running, and `ask` leaves it to the application.
   */
  closeBehavior?: "close" | "hide" | "ask";
}

/**
 * A filesystem scope.
 *
 * `false` denies everything, `true` allows everything, an array is a list of
 * allowed globs, and the object form adds denials that win over allowances.
 *
 * Globs may use `$HOME`, `$DESKTOP`, `$DOCUMENT`, `$DOWNLOAD`, `$PICTURE`,
 * `$VIDEO`, `$AUDIO`, `$TEMP`, `$CWD`, `$RESOURCE`, `$APPDATA`,
 * `$APPCONFIG` and `$APPCACHE`.
 */
/**
 * `default` keeps the platform's title bar. `hidden` removes it and lets the
 * page run to the top edge of the window.
 */
export type TitleBarStyle = "default" | "hidden";

/** Who draws close, minimise and zoom. */
export type TitleBarButtons = "system" | "hidden";

export type PathScope =
  boolean | string[] | { allow?: string[]; deny?: string[] };

export interface FilesystemPermissions {
  read?: PathScope;
  write?: PathScope;
  /**
   * Treat a path the user picked in a native dialog as granted for the rest
   * of the session. Default `true` - it is what makes a narrow scope usable.
   */
  grantFromDialog?: boolean;
  /**
   * The same for a path dropped on the window. Default `true` - without it the
   * paths a drop reports cannot be opened.
   */
  grantFromDrop?: boolean;
}

export type ClipboardPermissions =
  boolean | { read?: boolean; write?: boolean };

/**
 * One argument position of an allowed command.
 *
 * A string must match exactly; `{ pattern }` is a glob, where `*` matches
 * anything including `/` because arguments are not paths.
 */
export type ArgRule = string | { pattern: string };

export interface ShellRule {
  /**
   * Exactly what the application must ask for: a bare name resolved on PATH,
   * an absolute path, or `$RESOURCE/...` for a sidecar shipped in the bundle.
   */
  program: string;
  /**
   * One rule per argument position. The number of rules is the number of
   * arguments allowed. Omit to allow any arguments, which for most programs
   * amounts to allowing anything.
   */
  args?: ArgRule[];
  /** Directories the program may run in. Denied unless set. */
  cwd?: PathScope;
}

/**
 * Which hosts the application may reach with `network.request`.
 *
 * Rules take four forms:
 *
 * - `api.example.com` - that host exactly, any scheme, any port.
 * - `*.example.com` - anything strictly beneath it. Not the apex.
 * - `192.168.0.0/16` - any address in that range.
 * - `http://192.168.1.50:9123` - that scheme and host, and that port if given.
 */
export interface NetworkPermissions {
  allow?: string[];
  /** Checked first, and wins. */
  deny?: string[];
  /**
   * Hosts whose TLS certificate does not have to be trusted - which is what a
   * smart-home hub needs, since it serves HTTPS with a self-signed one.
   *
   * Separate from `allow` because "may talk to" and "may talk to without
   * checking who is answering" are different decisions.
   */
  allowInvalidCertificates?: string[];
  /**
   * Client certificates to present, and which hosts to present them to.
   *
   * `hosts` is not optional: a client key is an identity, and an entry that
   * read as "present this to everyone" would hand it to whatever host the
   * application was talked into contacting.
   */
  clientCertificates?: ClientCertificate[];
  /** Send requests through a proxy. */
  proxy?: NetworkProxy;
  /**
   * Ask the user about a host that is not in `allow`, rather than refusing it
   * outright. For an application whose whole job is a host its user names.
   *
   * `deny` still wins and is never prompted for.
   */
  grantFromPrompt?: boolean;
}

export interface ClientCertificate {
  /** The same rule forms as `allow`. Cannot be empty. */
  hosts: string[];
  /** A PEM certificate chain. `$APPDATA` and friends expand. */
  certificate: string;
  /** The matching PEM private key. */
  key: string;
}

export interface NetworkProxy {
  /** `<protocol>://<user>:<password>@<host>:<port>`; only the host is required. */
  url: string;
  /** Which hosts go through it. Everything, when left out. */
  for?: string[];
}

export interface ShellPermissions {
  allow?: ShellRule[];
  /**
   * Handing a URL or path to the system's default application. `true` allows
   * anything, which on every platform includes "run this program".
   */
  open?: boolean | string[];
}

export interface PermissionsConfig {
  filesystem?: FilesystemPermissions;
  dialog?: boolean;
  clipboard?: ClipboardPermissions;
  notification?: boolean;
  /** Read-only machine facts. Default `true`. */
  os?: boolean;
  /** Control over the app's own windows. Default `true`. */
  window?: boolean;
  /** Running other programs, and `shell.open`. Default: nothing. */
  shell?: ShellPermissions;
  /** Creating and changing the tray icon. Default `false`. */
  tray?: boolean;

  /**
   * Claiming key combinations system-wide. Default `false`.
   *
   * A global shortcut fires while other applications are in front, so it is
   * worth granting deliberately.
   */
  shortcut?: boolean;

  /** Starting the application at login. Default `false`. */
  autostart?: boolean;

  /**
   * Receiving files dragged onto the window. Default `false`.
   *
   * Turning this on means the runtime handles drops, so the page stops
   * getting HTML5 `drop` events for files and gets paths instead.
   */
  dragDrop?: boolean;
  /** Setting the application menu. Default `false`. */
  menu?: boolean;
  /** Checking for, downloading and installing updates. Default `false`. */
  updater?: boolean;
  /** HTTP requests made by the runtime rather than the webview. */
  network?: NetworkPermissions;
  /** The OS credential store. Default `false`. */
  secrets?: boolean;
  /**
   * SQLite. Default `false`.
   *
   * This is the capability; `filesystem.write` is still what says where a
   * database may live. Both are needed.
   *
   * `{ encryption: true }` additionally says this application encrypts its
   * database, which needs the `sqlcipher` runtime build - `vantail dev` and
   * `vantail package` pick it up from here.
   */
  database?: boolean | { encryption?: boolean };
  /**
   * Service types the application may discover, e.g. `_hub._tcp.local`.
   * `true` allows any, which is a different request from "find me the lights".
   */
  mdns?: boolean | string[];
  /**
   * USB HID devices the application may open, by what the hardware reports
   * about itself. A name is whatever a device claims; an id is assigned.
   */
  hid?: boolean | HidRule[];
}

export interface HidRule {
  vendorId: number;
  /** Any product from that vendor when omitted. */
  productId?: number;
  /** Narrow further to one HID usage page, e.g. `0xFFA0` for vendor-defined. */
  usagePage?: number;
}

/** A menu entry. `type` defaults to `normal` when omitted. */
export type MenuItem =
  | {
      type?: "normal";
      /** Identifies the item in `menu.click` events and in `menu.setEnabled`. */
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

/**
 * Platform-provided menu items.
 *
 * On macOS these are not decoration: without `copy`, `paste`, `undo` and
 * `selectAll` present in the menu, their keyboard shortcuts do not work
 * anywhere in the application.
 */
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

export interface TrayConfig {
  /** PNG path. Relative paths resolve inside the application's resources. */
  icon?: string;
  tooltip?: string;
  /** Text beside the icon. macOS only. */
  title?: string;
  /** Render as a monochrome template so macOS can invert it. Recommended. */
  iconAsTemplate?: boolean;
  menu?: MenuItem[];
  /**
   * What a left click does. A right click always opens the menu.
   *
   * `showWindow` (the default) brings the window back if it is hidden,
   * focuses it if it is behind something, and opens the menu if it is already
   * in front.
   */
  leftClick?: "showWindow" | "menu" | "event";
  /** Which window `showWindow` brings back. `main` by default. */
  window?: string;
}

export interface UpdaterConfig {
  /**
   * URL of the update manifest. `{{target}}`, `{{arch}}` and
   * `{{currentVersion}}` are substituted before the request.
   */
  endpoint: string;
  /**
   * base64 ed25519 public key, from `vantail updater keygen`. Updates that do
   * not verify against it are refused before anything is extracted.
   */
  publicKey: string;
  /** Default 30000. */
  timeoutMs?: number;
}

export interface VantailConfig {
  app: AppConfig;
  /** The window opened at startup, labelled `main`. */
  window?: WindowConfig;
  permissions?: PermissionsConfig;
  /**
   * The application menu, installed at startup.
   *
   * On macOS, leaving this out installs the standard one - About, Hide, Quit,
   * the Edit items and a Window menu - because without a menu Cmd-W, Cmd-Q,
   * Cmd-C and the rest do nothing at all. Pass `[]` for no menu on purpose.
   */
  menu?: MenuItem[];
  /** The tray icon, created at startup. */
  tray?: TrayConfig;
  updater?: UpdaterConfig;
  /**
   * Custom URL schemes this application answers to, e.g. `["myapp"]`, so that
   * `myapp://callback` reaches it. Registered with the OS by
   * `vantail package`.
   *
   * Reserved schemes - `http`, `file`, `javascript` and the like - are
   * refused.
   */
  protocols?: string[];
  /**
   * Refuse to start twice: a second launch hands its arguments to the running
   * application and exits.
   *
   * Defaults to on when `protocols` is set, because on Windows and Linux that
   * is how a deep link reaches an application that is already running.
   */
  singleInstance?: boolean;
  /**
   * Quit once every window is closed. Default `true`. Set it to `false` for
   * an application that lives in the tray and has no window most of the time.
   */
  quitOnLastWindowClosed?: boolean;
  /** Directory of built web assets, relative to the config file. Default `dist`. */
  distDir?: string;
  /** Force the webview inspector on or off. Defaults to on in `vantail dev`. */
  devtools?: boolean;
  /**
   * Where `vantail package` writes bundles. Default {@link DEFAULT_OUT_DIR}.
   *
   * Visible on purpose: this holds the application someone is meant to find
   * and open. Vantail's own scratch - the generated dev config, the updater
   * signing key - stays in `.vantail`.
   */
  outDir?: string;
}

/**
 * The shape the runtime actually reads. `vantail dev` and `vantail package`
 * generate this; nobody writes it by hand.
 */
export interface RuntimeConfig extends Omit<VantailConfig, "outDir"> {
  dev?: { url: string };
}

/**
 * Identity function that exists purely so editors can type-check and complete
 * `vantail.config.ts`.
 */
export function defineConfig(config: VantailConfig): VantailConfig {
  return config;
}

/**
 * Where a packaged application lands.
 *
 * Not a dot-directory: Finder hides those, and the whole point of this folder
 * is that someone can open it and double-click what is inside. `.vantail` is
 * for what Vantail needs and nobody else does - the generated dev config, the
 * updater signing key.
 */
export const DEFAULT_OUT_DIR = "build";

/** Where Vantail keeps its own working files, which are nobody else's business. */
export const INTERNAL_DIR = ".vantail";
