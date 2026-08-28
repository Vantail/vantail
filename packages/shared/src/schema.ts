/**
 * Runtime validation for `vantail.config.ts`.
 *
 * Kept in its own entry point so `@vantail/api` - which ships to the browser
 * - never pulls Zod into an application bundle.
 */

import { z } from "zod";

const pathScope = z.union([
  z.boolean(),
  z.array(z.string()),
  z
    .object({
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .strict(),
]);

const clipboardPermissions = z.union([
  z.boolean(),
  z
    .object({ read: z.boolean().optional(), write: z.boolean().optional() })
    .strict(),
]);

const positive = z.number().positive();

export const appSchema = z
  .object({
    name: z.string().min(1, "app.name cannot be empty"),
    identifier: z
      .string()
      .regex(
        /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/,
        "app.identifier must be reverse-DNS, e.g. dev.wissen.myapp",
      ),
    version: z.string().optional(),
    icon: z.string().optional(),
  })
  .strict();

export const windowSchema = z
  .object({
    title: z.string().optional(),
    width: positive.optional(),
    height: positive.optional(),
    minWidth: positive.optional(),
    minHeight: positive.optional(),
    maxWidth: positive.optional(),
    maxHeight: positive.optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    resizable: z.boolean().optional(),
    maximized: z.boolean().optional(),
    fullscreen: z.boolean().optional(),
    decorations: z.boolean().optional(),
    titleBarStyle: z.enum(["default", "hidden"]).optional(),
    titleBarHeight: z.number().positive().optional(),
    trafficLightPosition: z
      .object({ x: z.number(), y: z.number() })
      .strict()
      .optional(),
    transparent: z.boolean().optional(),
    alwaysOnTop: z.boolean().optional(),
    center: z.boolean().optional(),
    visible: z.boolean().optional(),
    closeBehavior: z.enum(["close", "hide", "ask"]).optional(),
  })
  .strict();

const argRule = z.union([
  z.string(),
  z.object({ pattern: z.string() }).strict(),
]);

const shellRule = z
  .object({
    program: z.string().min(1),
    args: z.array(argRule).optional(),
    cwd: pathScope.optional(),
  })
  .strict();

const clientCertificate = z
  .object({
    // A certificate with no hosts would read as "present it to everyone",
    // which is how a client key leaks. Say who it is for.
    hosts: z.array(z.string()).min(1, "a client certificate needs `hosts`"),
    certificate: z.string().min(1),
    key: z.string().min(1),
  })
  .strict();

const networkProxy = z
  .object({
    url: z.string().min(1),
    /** Which hosts go through it. Everything, when left out. */
    for: z.array(z.string()).optional(),
  })
  .strict();

const networkPermissions = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    allowInvalidCertificates: z.array(z.string()).optional(),
    clientCertificates: z.array(clientCertificate).optional(),
    proxy: networkProxy.optional(),
    grantFromPrompt: z.boolean().optional(),
  })
  .strict();

const usbId = z.number().int().min(0).max(0xffff);

const hidPermissions = z.union([
  z.boolean(),
  z.array(
    z
      .object({
        vendorId: usbId,
        productId: usbId.optional(),
        usagePage: usbId.optional(),
      })
      .strict(),
  ),
]);

const shellPermissions = z
  .object({
    allow: z.array(shellRule).optional(),
    open: z.union([z.boolean(), z.array(z.string())]).optional(),
  })
  .strict();

const PREDEFINED = [
  "separator",
  "copy",
  "cut",
  "paste",
  "selectAll",
  "undo",
  "redo",
  "minimize",
  "maximize",
  "fullscreen",
  "hide",
  "hideOthers",
  "showAll",
  "closeWindow",
  "quit",
  "about",
  "services",
  "bringAllToFront",
] as const;

/**
 * Every key name muda - the menu library the runtime uses - will accept,
 * plus `Return`, which the runtime rewrites to `Enter` for the benefit of
 * anyone typing what is printed on an Apple keyboard.
 *
 * Taken from muda's own parser rather than written by hand, so this check
 * cannot disagree with the one that actually installs the menu.
 */
const ACCELERATOR_KEYS = new Set([
  "'", ",", "-", ".", "/", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
  ";", "=", "A", "ARROWDOWN", "ARROWLEFT", "ARROWRIGHT", "ARROWUP",
  "AUDIOVOLUMEDOWN", "AUDIOVOLUMEMUTE", "AUDIOVOLUMEUP", "B", "BACKQUOTE",
  "BACKSLASH", "BACKSPACE", "BRACKETLEFT", "BRACKETRIGHT", "C", "CAPSLOCK",
  "COMMA", "D", "DELETE", "DIGIT0", "DIGIT1", "DIGIT2", "DIGIT3", "DIGIT4",
  "DIGIT5", "DIGIT6", "DIGIT7", "DIGIT8", "DIGIT9", "DOWN", "E", "END",
  "ENTER", "EQUAL", "ESC", "ESCAPE", "F", "F1", "F10", "F11", "F12", "F13",
  "F14", "F15", "F16", "F17", "F18", "F19", "F2", "F20", "F21", "F22",
  "F23", "F24", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "G", "H", "HOME",
  "I", "INSERT", "J", "K", "KEYA", "KEYB", "KEYC", "KEYD", "KEYE", "KEYF",
  "KEYG", "KEYH", "KEYI", "KEYJ", "KEYK", "KEYL", "KEYM", "KEYN", "KEYO",
  "KEYP", "KEYQ", "KEYR", "KEYS", "KEYT", "KEYU", "KEYV", "KEYW", "KEYX",
  "KEYY", "KEYZ", "L", "LEFT", "M", "MINUS", "N", "NUM0", "NUM1", "NUM2",
  "NUM3", "NUM4", "NUM5", "NUM6", "NUM7", "NUM8", "NUM9", "NUMADD",
  "NUMDECIMAL", "NUMDIVIDE", "NUMENTER", "NUMEQUAL", "NUMLOCK",
  "NUMMULTIPLY", "NUMPAD0", "NUMPAD1", "NUMPAD2", "NUMPAD3", "NUMPAD4",
  "NUMPAD5", "NUMPAD6", "NUMPAD7", "NUMPAD8", "NUMPAD9", "NUMPADADD",
  "NUMPADDECIMAL", "NUMPADDIVIDE", "NUMPADENTER", "NUMPADEQUAL",
  "NUMPADMULTIPLY", "NUMPADPLUS", "NUMPADSUBTRACT", "NUMPLUS",
  "NUMSUBTRACT", "O", "P", "PAGEDOWN", "PAGEUP", "PERIOD", "PRINTSCREEN",
  "Q", "QUOTE", "R", "RETURN", "RIGHT", "S", "SCROLLLOCK", "SEMICOLON",
  "SLASH", "SPACE", "T", "TAB", "U", "UP", "V", "VOLUMEDOWN", "VOLUMEMUTE",
  "VOLUMEUP", "W", "X", "Y", "Z", "[", "\\", "]", "`",
]);

const ACCELERATOR_MODIFIERS = new Set([
  "ALT", "CMD", "CMDORCONTROL", "CMDORCTRL", "COMMAND", "COMMANDORCONTROL",
  "COMMANDORCTRL", "CONTROL", "CTRL", "OPTION", "SHIFT", "SUPER",
]);

/**
 * Split an accelerator into modifiers and a key, the way the runtime does.
 *
 * Modifiers come first and the key is last, so the split is on the *final*
 * `+` - which is also what lets `Ctrl++` mean the `+` key.
 */
function splitAccelerator(text: string): { modifiers: string[]; key: string } {
  const trimmed = text.trim();
  const at = trimmed.lastIndexOf("+");
  if (at < 0) return { modifiers: [], key: trimmed };

  const rawKey = trimmed.slice(at + 1);
  const head =
    rawKey.trim() === ""
      ? trimmed.slice(0, at).replace(/\++$/, "")
      : trimmed.slice(0, at);

  return {
    modifiers: head === "" ? [] : head.split("+"),
    key: rawKey.trim() === "" ? "+" : rawKey.trim(),
  };
}

/**
 * What is wrong with an accelerator, if anything.
 *
 * Worth checking here rather than only in the runtime because of how the
 * failure used to land: an accelerator the platform cannot parse takes the
 * *whole menu* with it, and on macOS a missing menu means Cmd-C, Cmd-V,
 * Cmd-Q and Cmd-W silently stop working - those shortcuts exist only as menu
 * items. The runtime now leaves the one bad item out instead, but a mistake
 * in a literal string in `vantail.config.ts` should not need a window to be
 * found at all. `vantail dev`, `vantail build` and `vantail doctor` all load
 * this schema.
 */
export function acceleratorProblem(text: string): string | undefined {
  if (text.trim() === "") return "an accelerator cannot be empty";

  const { modifiers, key } = splitAccelerator(text);

  for (const modifier of modifiers) {
    const name = modifier.trim();
    if (name === "") {
      return `\`${text}\` has an empty modifier - check the \`+\` signs`;
    }
    if (!ACCELERATOR_MODIFIERS.has(name.toUpperCase())) {
      return (
        `\`${name}\` is not a modifier. Use CmdOrCtrl, Cmd, Ctrl, Alt, ` +
        `Option, Shift or Super, and put the key last`
      );
    }
  }

  if (!ACCELERATOR_KEYS.has(key.toUpperCase())) {
    return (
      `\`${key}\` is not a key name. Keys are a letter, a digit, ` +
      `F1-F24, or a name like Enter, Escape, Space, Tab, Delete, ` +
      `ArrowUp or PageDown`
    );
  }

  return undefined;
}

const acceleratorSchema = z.string().superRefine((value, ctx) => {
  const problem = acceleratorProblem(value);
  if (problem !== undefined) {
    ctx.addIssue({ code: "custom", message: problem });
  }
});

/**
 * Menus nest, so the schema does too. Zod needs the explicit annotation
 * because a recursive type cannot be inferred from its own definition.
 */
export const menuItemSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z
      .object({
        type: z.literal("normal").optional(),
        id: z.string().min(1),
        label: z.string(),
        enabled: z.boolean().optional(),
        accelerator: acceleratorSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("checkbox"),
        id: z.string().min(1),
        label: z.string(),
        checked: z.boolean().optional(),
        enabled: z.boolean().optional(),
        accelerator: acceleratorSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("submenu"),
        label: z.string(),
        items: z.array(menuItemSchema),
        enabled: z.boolean().optional(),
      })
      .strict(),
    z.object({ type: z.literal("separator") }).strict(),
    z
      .object({
        type: z.literal("predefined"),
        item: z.enum(PREDEFINED),
        label: z.string().optional(),
      })
      .strict(),
  ]),
);

export const traySchema = z
  .object({
    icon: z.string().optional(),
    tooltip: z.string().optional(),
    title: z.string().optional(),
    iconAsTemplate: z.boolean().optional(),
    menu: z.array(menuItemSchema).optional(),
    leftClick: z.enum(["showWindow", "menu", "event"]).optional(),
    window: z.string().optional(),
  })
  .strict();

export const updaterSchema = z
  .object({
    endpoint: z.string().url("updater.endpoint must be a URL"),
    publicKey: z
      .string()
      .min(
        1,
        "updater.publicKey is required - generate one with `vantail updater keygen`",
      ),
    timeoutMs: positive.optional(),
  })
  .strict();

export const permissionsSchema = z
  .object({
    filesystem: z
      .object({
        read: pathScope.optional(),
        write: pathScope.optional(),
        grantFromDialog: z.boolean().optional(),
        grantFromDrop: z.boolean().optional(),
      })
      .strict()
      .optional(),
    dialog: z.boolean().optional(),
    clipboard: clipboardPermissions.optional(),
    notification: z.boolean().optional(),
    os: z.boolean().optional(),
    window: z.boolean().optional(),
    shell: shellPermissions.optional(),
    tray: z.boolean().optional(),
    shortcut: z.boolean().optional(),
    dragDrop: z.boolean().optional(),
    autostart: z.boolean().optional(),
    menu: z.boolean().optional(),
    updater: z.boolean().optional(),
    network: networkPermissions.optional(),
    secrets: z.boolean().optional(),
    database: z.boolean().optional(),
    mdns: z.union([z.boolean(), z.array(z.string())]).optional(),
    hid: hidPermissions.optional(),
  })
  .strict();

export const configSchema = z
  .object({
    app: appSchema,
    window: windowSchema.optional(),
    permissions: permissionsSchema.optional(),
    menu: z.array(menuItemSchema).optional(),
    tray: traySchema.optional(),
    updater: updaterSchema.optional(),
    protocols: z
      .array(
        z
          .string()
          .regex(
            /^[a-z][a-z0-9+.-]*$/,
            "a protocol must start with a lowercase letter and contain only lowercase letters, digits, +, - and .",
          ),
      )
      .optional(),
    singleInstance: z.boolean().optional(),
    quitOnLastWindowClosed: z.boolean().optional(),
    distDir: z.string().optional(),
    devtools: z.boolean().optional(),
    outDir: z.string().optional(),
  })
  .strict();

export type ParsedConfig = z.infer<typeof configSchema>;

/**
 * Validate a config object, returning either the parsed value or a list of
 * messages already formatted for a terminal.
 */
export function parseConfig(
  value: unknown,
): { ok: true; config: ParsedConfig } | { ok: false; problems: string[] } {
  const result = configSchema.safeParse(value);
  if (result.success) {
    return { ok: true, config: result.data };
  }
  const problems = result.error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return { ok: false, problems };
}
