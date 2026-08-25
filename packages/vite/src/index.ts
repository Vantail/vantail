/**
 * The Vite plugin.
 *
 * `vantail dev` and `vantail build` apply this automatically, so a project does
 * not need a `vite.config.ts` at all. Add it by hand when you already have
 * one and want the same defaults:
 *
 * ```ts
 * import { defineConfig } from "vite";
 * import vantail from "@vantail/vite";
 *
 * export default defineConfig({ plugins: [vantail()] });
 * ```
 *
 * It does four small things: point the build output at the `distDir` from
 * `vantail.config.ts`, target the engines a webview actually has, expose the
 * app's identity to application code, and warn when the page is opened in a
 * normal browser where the native APIs cannot work.
 */

import { loadConfig, type ParsedConfig } from "@vantail/shared/load";
import type { Plugin, UserConfig } from "vite";

export interface VantailPluginOptions {
  /** Path to `vantail.config.ts`. Found automatically when omitted. */
  config?: string;
  /**
   * A config that has already been loaded. `@vantail/cli` passes this so the
   * config is not read and validated twice.
   */
  resolved?: { config: ParsedConfig; root: string };
}

/**
 * Browser engines a Vantail app can actually run on: WKWebView on macOS,
 * WebView2 on Windows, WebKitGTK on Linux. Pinned rather than left to Vite's
 * default so a build cannot silently start emitting syntax that the oldest
 * supported webview rejects.
 */
export const WEBVIEW_TARGETS = ["es2022", "safari16", "chrome110"];

export default function vantail(options: VantailPluginOptions = {}): Plugin {
  let resolved: { config: ParsedConfig; root: string } | undefined = options.resolved;

  return {
    name: "vantail",

    async config(userConfig: UserConfig): Promise<UserConfig> {
      if (!resolved) {
        const loaded = await loadConfig({
          cwd: userConfig.root ?? process.cwd(),
          ...(options.config ? { path: options.config } : {}),
        });
        resolved = { config: loaded.config, root: loaded.root };
      }

      const { app, distDir } = resolved.config;

      return {
        // The custom protocol serves the resource directory as its root, so
        // absolute asset URLs resolve exactly as they do on a web server.
        base: "/",
        clearScreen: false,
        envPrefix: ["VITE_", "VANTAIL_"],
        build: {
          outDir: distDir ?? "dist",
          target: WEBVIEW_TARGETS,
          emptyOutDir: true,
        },
        server: {
          // A moved port would leave the runtime pointing at nothing.
          strictPort: true,
          host: "127.0.0.1",
        },
        define: {
          "import.meta.env.VANTAIL_APP_NAME": JSON.stringify(app.name),
          "import.meta.env.VANTAIL_APP_VERSION": JSON.stringify(app.version ?? "0.0.0"),
          "import.meta.env.VANTAIL_APP_IDENTIFIER": JSON.stringify(app.identifier),
        },
      };
    },

    transformIndexHtml: {
      order: "pre",
      handler(html: string, ctx: { server?: unknown }) {
        // Dev only: opening http://localhost:5173 in Chrome is a normal thing
        // to do by accident, and the failure is otherwise mystifying.
        if (!ctx.server || html.includes(NOTICE_MARKER)) return html;
        return {
          html,
          tags: [
            {
              tag: "script",
              injectTo: "head-prepend" as const,
              children: BROWSER_NOTICE,
            },
          ],
        };
      },
    },
  };
}

const NOTICE_MARKER = "[vantail] No native runtime detected";

const BROWSER_NOTICE = `
if (!window.__VANTAIL__) {
  console.warn(
    "[vantail] No native runtime detected. Native APIs will throw NO_RUNTIME.\\n" +
    "This page is meant to be opened by \`vantail dev\`, not in a browser tab."
  );
}
`.trim();

export { vantail };
