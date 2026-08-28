import { useEffect, useState } from "react";

import { TitleBar, useTitleBar, type Place } from "./TitleBar.js";

/**
 * Somewhere the search bar can take you.
 *
 * A real application would have routes here; this one only has to prove the
 * bar's arrows and dropdown are wired to something.
 */
const PLACES: Place[] = [
  { id: "files", label: "Files" },
  { id: "windows", label: "Windows and screens" },
  { id: "clipboard", label: "Clipboard" },
  { id: "shortcuts", label: "Shortcuts and menus" },
  { id: "system", label: "System and power" },
];

import {
  app,
  appWindow,
  clipboard,
  createWindow,
  dialog,
  fileDrop,
  filesystem,
  getWindow,
  listWindows,
  menu,
  os,
  power,
  process,
  runtimeVersion,
  screen,
  shortcut,
  tray,
  VantailError,
  type FileInfo,
} from "@vantail/api";

interface OpenFile {
  path: string;
  contents: string;
  info: FileInfo;
}

const SETTINGS = "settings";

export function App() {
  const [file, setFile] = useState<OpenFile | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [platform, setPlatform] = useState<string>("");
  const [wrap, setWrap] = useState(true);
  const [windows, setWindows] = useState<string[]>([]);
  const [trayOn, setTrayOn] = useState(false);
  const [display, setDisplay] = useState<string>("");
  const [dropped, setDropped] = useState<string[]>([]);
  const [watching, setWatching] = useState<string | null>(null);
  const [changes, setChanges] = useState<string[]>([]);
  const [hotkey, setHotkey] = useState(false);
  const [sleepEvents, setSleepEvents] = useState(false);

  // Static app facts are injected before any script runs, so no await needed.
  const info = app.infoSync();

  useEffect(() => {
    void os.platform().then(setPlatform);
    void refreshWindows();

    // Menu items are wired up here rather than in the config, because the
    // config describes the menu and this decides what the items do.
    const stopMenu = menu.onClick(({ id }) => {
      if (id === "open") void open();
      if (id === "settings") void openSettings();
      if (id === "wrap") void menu.isChecked("wrap").then(setWrap);
    });

    // The runtime already brings the window back on a tray click; this is
    // only here to show that the event still arrives.
    const stopTray = tray.onClick(() => setNote("tray clicked"));

    // Where this window actually is, so a second monitor is not guesswork.
    void power.supported().then(setSleepEvents);

    void screen.current().then((found) => {
      if (found)
        setDisplay(
          `${found.size.width}x${found.size.height} @${found.scaleFactor}x`,
        );
    });

    // A dropped file arrives with its path, which HTML5 never gives you - and
    // the path is readable afterwards without any standing filesystem grant.
    const stopDrop = fileDrop.onDrop(({ paths }) => setDropped(paths));

    // The machine going to sleep. macOS only for now; elsewhere these never
    // fire, which is why `supported()` exists.
    const stopSuspend = power.onSuspend(() => setNote("suspending..."));
    const stopResume = power.onResume(() => setNote("woke up"));

    const stopHotkey = shortcut.onPressed(({ id }) =>
      setNote(`shortcut: ${id}`),
    );

    const stopWatch = filesystem.onChange(({ kind, path }) =>
      setChanges((seen) =>
        [`${kind} ${path.split("/").pop()}`, ...seen].slice(0, 5),
      ),
    );

    return () => {
      stopMenu();
      stopTray();
      stopDrop();
      stopSuspend();
      stopResume();
      stopHotkey();
      stopWatch();
    };
  }, []);

  const titleBar = useTitleBar();
  // The history the arrows walk, which the dropdown also jumps into.
  const [place, setPlace] = useState(0);

  async function refreshWindows() {
    setWindows(await listWindows());
  }

  function report(cause: unknown) {
    setNote(
      VantailError.is(cause)
        ? `${cause.code}: ${cause.message}`
        : String(cause),
    );
  }

  async function open() {
    setNote(null);
    try {
      const path = await dialog.openFile({
        title: "Open a text file",
        filters: [
          {
            name: "Text",
            extensions: ["txt", "md", "json", "ts", "tsx", "js", "css"],
          },
          { name: "All files", extensions: ["*"] },
        ],
      });
      if (!path) return;

      // This file sits outside the configured read scope, and it still works:
      // picking it in the dialog granted access to exactly this path.
      const [contents, stats] = await Promise.all([
        filesystem.readText(path),
        filesystem.stat(path),
      ]);
      setFile({ path, contents, info: stats });
    } catch (cause) {
      report(cause);
    }
  }

  async function openSettings() {
    setNote(null);
    try {
      const existing = await getWindow(SETTINGS).exists();
      if (existing) {
        await getWindow(SETTINGS).focus();
        return;
      }
      // Resolves once the new window's page is running, so the message below
      // cannot arrive before anything is listening for it.
      await createWindow(SETTINGS, {
        url: "settings.html",
        title: "Settings",
        width: 420,
        height: 300,
      });
      await app.emit(
        "hello",
        { from: info?.name ?? "Vantail" },
        { to: SETTINGS },
      );
      await refreshWindows();
    } catch (cause) {
      report(cause);
    }
  }

  async function toggleTray() {
    setNote(null);
    try {
      if (trayOn) {
        await tray.remove();
        // Without a tray icon there is no way back, so the window closes for
        // real again.
        await appWindow.setCloseBehavior("close");
        setTrayOn(false);
        return;
      }
      await tray.set({
        icon: "tray-icon.png",
        tooltip: info?.name ?? "Vantail",
        iconAsTemplate: true,
        // Close the window with Cmd-W and it hides rather than quitting;
        // clicking the tray icon brings it back. Clicking it again, with the
        // window already in front, opens this menu instead.
        leftClick: "showWindow",
        menu: [
          { id: "open", label: "Open a file..." },
          { type: "separator" },
          { type: "predefined", item: "quit" },
        ],
      });
      await appWindow.setCloseBehavior("hide");
      setTrayOn(true);
    } catch (cause) {
      report(cause);
    }
  }

  async function runUptime() {
    setNote(null);
    try {
      const { stdout } = await process.execute("/usr/bin/uptime");
      setNote(stdout.trim());
    } catch (cause) {
      report(cause);
    }
  }

  async function readIconBytes() {
    setNote(null);
    try {
      const bytes = await filesystem.readBinary(
        `${await os.resourceDir()}/tray-icon.png`,
      );
      const magic = [...bytes.slice(1, 4)]
        .map((byte) => String.fromCharCode(byte))
        .join("");
      setNote(
        `tray-icon.png is ${bytes.length} bytes, and really is a ${magic}`,
      );
    } catch (cause) {
      report(cause);
    }
  }

  async function toggleHotkey() {
    setNote(null);
    try {
      if (hotkey) {
        await shortcut.unregisterAll();
        setHotkey(false);
        return;
      }
      // Works while another application is in front - which is the whole
      // point, and something a page can never do for itself.
      await shortcut.register("CmdOrCtrl+Shift+F9", { id: "demo" });
      setHotkey(true);
      setNote("Press Cmd/Ctrl+Shift+F9, even from another app");
    } catch (cause) {
      report(cause);
    }
  }

  async function toggleWatch() {
    setNote(null);
    try {
      if (watching) {
        await filesystem.unwatch(watching);
        setWatching(null);
        return;
      }
      const directory = await dialog.openDirectory({ title: "Watch a folder" });
      if (!directory) return;
      const watch = await filesystem.watch(directory, { recursive: true });
      setWatching(watch.id);
      setChanges([]);
    } catch (cause) {
      report(cause);
    }
  }

  async function showProgress() {
    setNote(null);
    try {
      // The bar across the dock or taskbar icon, for work the window is not
      // showing.
      for (const value of [20, 45, 70, 100]) {
        await app.setProgress({ value, state: "normal" });
        await new Promise((done) => setTimeout(done, 400));
      }
      await app.setProgress({ state: "none" });
      await app.setBadge(String(dropped.length || 3));
      setNote("Badge set - clear it with app.setBadge(null)");
    } catch (cause) {
      report(cause);
    }
  }

  async function readSomethingForbidden() {
    setNote(null);
    try {
      await filesystem.readText("/etc/passwd");
      setNote("That should not have worked.");
    } catch (cause) {
      report(cause);
    }
  }

  return (
    <>
      {titleBar.custom && (
        <TitleBar
          metrics={titleBar.metrics}
          title={info?.name ?? "Vantail"}
          places={PLACES}
          current={place}
          onGo={setPlace}
          onProfile={() => setNote("profile: whatever your app puts here")}
          onSettings={() => void openSettings()}
        />
      )}
      <main>
      <header>
        <div>
          <h1>{info?.name ?? "Vantail"}</h1>
          <p className="meta">
            v{info?.version} | {platform || "..."} | runtime{" "}
            {runtimeVersion() ?? "-"}
            {info?.isDev ? " | dev" : ""} | windows: {windows.join(", ")}
          </p>
        </div>
        <div className="window-controls">
          <button
            onClick={() =>
              void titleBar.setStyle(titleBar.custom ? "default" : "hidden")
            }
          >
            {titleBar.custom ? "System title bar" : "Custom title bar"}
          </button>
          {titleBar.custom && (
            <button
              onClick={() =>
                void titleBar.setHeight(titleBar.metrics.height > 40 ? null : 40)
              }
            >
              {titleBar.metrics.height > 40 ? "Native height" : "Taller bar"}
            </button>
          )}
          <button onClick={() => void appWindow.minimize()}>Minimise</button>
          <button onClick={() => void appWindow.toggleMaximize()}>
            Maximise
          </button>
        </div>
      </header>

      <section className="actions">
        <button className="primary" onClick={() => void open()}>
          Select file
        </button>
        <button onClick={() => void openSettings()}>Second window</button>
        <button onClick={() => void toggleTray()}>
          {trayOn ? "Remove tray" : "Add tray"}
        </button>
        <button onClick={() => void runUptime()}>Run uptime</button>
        <button onClick={() => void readIconBytes()}>Read icon bytes</button>
        <button
          onClick={() =>
            void (
              file &&
              clipboard.writeText(file.path).then(() => setNote("Copied"))
            )
          }
          disabled={!file}
        >
          Copy path
        </button>
        <button onClick={() => void readSomethingForbidden()}>
          Try /etc/passwd
        </button>
        <button onClick={() => void app.quit()}>Quit</button>
      </section>

      <section className="actions">
        <button onClick={() => void toggleHotkey()}>
          {hotkey ? "Release shortcut" : "Global shortcut"}
        </button>
        <button onClick={() => void toggleWatch()}>
          {watching ? "Stop watching" : "Watch a folder"}
        </button>
        <button onClick={() => void showProgress()}>Dock progress</button>
      </section>

      <p className="meta">
        {display ? `screen ${display}` : "screen ..."} |{" "}
        {sleepEvents ? "sleep events reported" : "no sleep events here"} | drag
        a file onto this window
      </p>

      {dropped.length > 0 ? (
        <section className="empty">
          <p className="meta">
            dropped, with real paths - readable although the config grants no
            standing access:
          </p>
          <pre>{dropped.join("\n")}</pre>
        </section>
      ) : null}

      {changes.length > 0 ? (
        <section className="empty">
          <p className="meta">recent changes under the watched folder:</p>
          <pre>{changes.join("\n")}</pre>
        </section>
      ) : null}

      {note ? <p className="note">{note}</p> : null}

      {file ? (
        <section className="file">
          <h2>{file.path.split("/").pop()}</h2>
          <p className="meta">
            {file.path} | {file.info.size} bytes |{" "}
            {file.info.modifiedAt
              ? new Date(file.info.modifiedAt).toLocaleString()
              : "unknown"}
          </p>
          <pre className={wrap ? "" : "nowrap"}>{file.contents}</pre>
        </section>
      ) : (
        <section className="empty">
          <p>No file open.</p>
          <p className="meta">
            Nothing here is Node.js - <code>dialog.openFile()</code> and{" "}
            <code>filesystem.readText()</code> are calls into a native runtime.
          </p>
        </section>
      )}
      </main>
    </>
  );
}
