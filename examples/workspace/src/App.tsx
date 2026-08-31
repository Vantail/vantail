/**
 * A two-row title bar: a dark command bar with a lighter tab strip under it.
 *
 * Both rows are the title bar. The page runs to the top edge of the window
 * and there is no platform bar above them, so between them they have to do
 * everything the bar they replaced did - drag the window, zoom it on a double
 * click, and on the platforms that took the buttons away, close it.
 *
 * The one number the runtime needs is `titleBarHeight`, and for a design like
 * this it is the height of the **first** row rather than of both. See
 * `titlebar.ts`.
 */

import { useEffect, useState } from "react";

import { appWindow, menu } from "@vantail/api";

import { CommandBar } from "./CommandBar.js";
import { TabBar } from "./TabBar.js";
import { CLOSE_TAB, NEW_TAB } from "./menu.js";
import { COMMAND, TABS, drawsOwnControls, useTitleBar } from "./titlebar.js";
import { FIRST, newTab, type Tab } from "./tabs.js";

export function App() {
  const metrics = useTitleBar();
  const ownControls = drawsOwnControls(metrics);

  const [tabs, setTabs] = useState<Tab[]>(FIRST);
  const [active, setActive] = useState(FIRST[0]!.id);
  const [maximized, setMaximized] = useState(false);

  const open = () => {
    const tab = newTab();
    setTabs((it) => [...it, tab]);
    setActive(tab.id);
  };

  const close = (id: number) =>
    setTabs((it) => {
      const left = it.filter((tab) => tab.id !== id);
      // Closing the last tab closes the window, the way a tabbed application
      // behaves everywhere else.
      if (left.length === 0) void appWindow.close();
      // Moving to the neighbour rather than to the first tab: the one beside
      // the one you shut is where you were looking.
      if (id === active && left.length > 0) {
        const was = it.findIndex((tab) => tab.id === id);
        setActive((left[was] ?? left[was - 1] ?? left[0])!.id);
      }
      return left;
    });

  // The caption buttons swap glyph when the window is maximised, so this has
  // to follow the window rather than only the button that changed it - the
  // user can also double-click the bar, or use the platform's own gesture.
  useEffect(() => {
    void appWindow.isMaximized().then(setMaximized);
    return appWindow.onResized(() => {
      void appWindow.isMaximized().then(setMaximized);
    });
  }, []);

  useEffect(
    () =>
      menu.onClick(({ id }) => {
        if (id === NEW_TAB) open();
        if (id === CLOSE_TAB) close(active);
      }),
    [active, tabs],
  );

  return (
    <div
      className="app"
      style={
        {
          "--command": `${COMMAND}px`,
          "--tabs": `${TABS}px`,
        } as React.CSSProperties
      }
    >
      <header className="chrome">
        <CommandBar metrics={metrics} ownControls={ownControls} maximized={maximized} />
        <TabBar
          tabs={tabs}
          active={active}
          onSelect={setActive}
          onClose={close}
          onNew={open}
        />
      </header>

      <main className="canvas">
        <h1>{tabs.find((tab) => tab.id === active)?.title}</h1>
        <p>
          Everything above this line is the title bar: two rows, drawn by the
          page, with the platform's window buttons placed inside the first one.
        </p>
        <p className="hint">
          Drag either row to move the window. Double-click to zoom. Cmd-T and
          Cmd-W open and close tabs.
        </p>
      </main>
    </div>
  );
}
