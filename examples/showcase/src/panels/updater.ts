import { deepLink, fileDrop, updater } from "@vantail/api";
import { panel, type Panel } from "../ui.js";

/** Self-update. */
export function updaterPanel(): Panel {
  const p = panel("updater", "updater", "Checking for, downloading and installing a new version of itself.");

  p.row(
    p.button("check()", () => updater.check()),
    p.button("pending()", () => updater.pending()),
  );

  p.row(
    p.button("download()", () => updater.download((progress) => p.log(`${progress.downloaded} bytes so far`))),
    p.button("install()", () => updater.install()),
    p.button("downloadAndInstall()", () => updater.downloadAndInstall()),
  );

  p.note(
    "This needs an updater endpoint in the config and a build that was signed for " +
      "it, so from `vantail dev` it will report that there is nothing to update. " +
      "An update that is not signed by the expected key is refused rather than " +
      "installed. `install()` never returns: it relaunches.",
  );

  // `total` is 0 when the server sent no content length, so a percentage is
  // not always available.
  updater.onProgress(({ downloaded, total }) =>
    p.log(total ? `${Math.round((downloaded / total) * 100)}%` : `${downloaded} bytes`),
  );

  return p;
}

/** Custom URL schemes. */
export function deepLinkPanel(): Panel {
  const p = panel("deeplink", "deepLink", "Opening the application from a link elsewhere on the machine.");

  p.row(p.button("protocols()", () => deepLink.protocols()));

  p.note(
    "The config registers `vantail-showcase://`, and `vantail package` is what tells " +
      "the OS about it - so this works from an installed build, not from `vantail dev`. " +
      "Once installed, open a terminal and run `open vantail-showcase://hello/world` " +
      "on macOS, or paste the URL into a browser. If the app is already running, the " +
      "link arrives here instead of starting a second copy.",
  );

  deepLink.onOpen((url) => p.log(`opened with ${url}`));

  return p;
}

/** Files dragged onto the window. */
export function dropPanel(): Panel {
  const p = panel("drop", "fileDrop", "Files dragged from the file manager onto this window.");

  p.note(
    "Drag a file anywhere onto this window. With the permission on, the runtime " +
      "handles the drop and hands over real paths, which the page could never get " +
      "from an HTML5 drop event. Dropping also grants those paths for the session, " +
      "the same way picking them in a dialog does.",
  );

  fileDrop.onEnter((event) => p.log(`entering with ${event.paths.length} file(s)`));
  fileDrop.onLeave(() => p.log("left without dropping"));
  fileDrop.onDrop((event) => p.out(event.paths));

  return p;
}
