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

const networkPermissions = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    allowInvalidCertificates: z.array(z.string()).optional(),
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
        accelerator: z.string().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("checkbox"),
        id: z.string().min(1),
        label: z.string(),
        checked: z.boolean().optional(),
        enabled: z.boolean().optional(),
        accelerator: z.string().optional(),
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
