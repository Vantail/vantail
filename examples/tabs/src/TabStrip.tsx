/**
 * A tab strip that *is* the title bar.
 *
 * Two things make this work rather than merely look right.
 *
 * The first is `insetLeft`: the platform's window buttons are still up there,
 * and only the runtime knows how much room they need. Padding the strip by it
 * means the first tab starts after them on macOS and hard against the edge on
 * Windows and Linux, where the buttons went with the title bar - one number,
 * no branch on the platform's name.
 *
 * The second is that the tabs are sized by CSS rather than by measuring. They
 * are flex children with a preferred width and a floor, so opening the tenth
 * tab narrows the other nine in the same layout pass that drew them. Nothing
 * here counts pixels, which is what keeps the strip in step with the window
 * frame while it is being dragged.
 */

import { useEffect, useRef, useState } from "react";

import { appWindow, titleBarMetrics } from "@vantail/api";
import type { MenuItem, TitleBarMetrics } from "@vantail/api";

import { Close, Plus } from "./icons.js";
import { MenuBar } from "./MenuBar.js";
import { DRAWS_OWN_MENU, PLATFORM } from "./platform.js";
import { WindowControls } from "./WindowControls.js";
import { MIN_HEIGHT, MIN_WIDTH } from "./window.js";

/** What the runtime reports when there is a title bar doing the job already. */
const NOTHING_RESERVED: TitleBarMetrics = {
  height: 0,
  insetLeft: 0,
  insetRight: 0,
  buttonTop: 0,
  buttonHeight: 0,
};

export type Tab = {
  id: number;
  title: string;
  /** A colour instead of an icon, so the example bundles no images. */
  hue: number;
};

export function TabStrip({
  tabs,
  activeId,
  menu,
  onSelect,
  onClose,
  onOpen,
}: {
  tabs: Tab[];
  activeId: number;
  menu?: MenuItem[];
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onOpen: () => void;
}) {
  // Read straight off the injected bridge - no await, so the first paint
  // already has the right padding and the tabs never jump sideways.
  const metrics = titleBarMetrics() ?? NOTHING_RESERVED;

  // Where the platform reserved no room on the leading edge it drew no window
  // buttons either, so this application has to. Measuring is the test rather
  // than the platform's name: it stays right if a platform changes its mind.
  const ownControls = metrics.insetLeft === 0;

  const [maximized, setMaximized] = useState(false);
  const strip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ownControls) return;
    void appWindow.isMaximized().then(setMaximized);
    return appWindow.onResized(() => {
      void appWindow.isMaximized().then(setMaximized);
    });
  }, [ownControls]);

  // Keep the window wider than the strip's fixed furniture.
  //
  // Tabs give way - that is what `min-width` on them is for - but the menu,
  // the new-tab button and the window controls do not, and a strip out of room
  // is a strip with the close button off the end of it. No amount of CSS stops
  // a window being dragged narrower, so the floor is set from what is actually
  // there rather than from a number somebody has to remember to update.
  useEffect(() => {
    const element = strip.current;
    if (!element) return;

    let applied = 0;

    const measure = () => {
      const style = getComputedStyle(element);
      const gap = parseFloat(style.columnGap) || 0;
      const tabs = element.querySelector<HTMLElement>(".tabs");

      let fixed = 0;
      for (const child of Array.from(element.children) as HTMLElement[]) {
        if (child === tabs) continue;
        fixed += child.offsetWidth + gap;
      }

      // Room for one tab at its floor, so there is always a tab to see.
      const needed = Math.ceil(
        parseFloat(style.paddingLeft) +
          parseFloat(style.paddingRight) +
          56 +
          fixed,
      );
      if (needed === applied) return;
      applied = needed;

      const width = Math.max(MIN_WIDTH, needed);
      void appWindow.setMinSize(width, MIN_HEIGHT);
      if (window.innerWidth < width) {
        void appWindow.setSize(width, window.innerHeight);
      }
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [menu, ownControls]);

  const interactive = (event: { target: EventTarget | null }) =>
    (event.target as Element).closest("button");

  // Empty strip drags the window; a double-click on it zooms. Both are what
  // the title bar this replaced did, and what people try without thinking.
  const drag = (event: React.PointerEvent) => {
    if (interactive(event) || event.buttons !== 1) return;
    void appWindow.startDragging();
  };

  const zoom = (event: React.MouseEvent) => {
    if (interactive(event)) return;
    void appWindow.toggleMaximize();
  };

  return (
    <div
      ref={strip}
      className="strip"
      data-platform={PLATFORM}
      onPointerDown={drag}
      onDoubleClick={zoom}
      style={{
        paddingLeft: `calc(${metrics.insetLeft}px + 8px)`,
        paddingRight: `calc(${metrics.insetRight}px + 8px)`,
      }}
    >
      {ownControls && PLATFORM === "macos" && (
        <WindowControls platform={PLATFORM} maximized={maximized} />
      )}

      {/* Before the tabs, where an editor with a tabbed title bar puts it. */}
      {menu && DRAWS_OWN_MENU && <MenuBar items={menu} />}

      <div className="tabs" role="tablist">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={tab.id === activeId ? "tab active" : "tab"}
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === activeId}
              className="tab-face"
              onClick={() => onSelect(tab.id)}
              title={tab.title}
            >
              <span
                className="favicon"
                style={{ background: `hsl(${tab.hue} 62% 52%)` }}
                aria-hidden
              />
              <span className="tab-title">{tab.title}</span>
            </button>
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${tab.title}`}
              onClick={() => onClose(tab.id)}
            >
              <Close className="glyph" />
            </button>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="new-tab"
        aria-label="New tab"
        onClick={onOpen}
      >
        <Plus className="glyph" />
      </button>

      {ownControls && PLATFORM !== "macos" && (
        <WindowControls platform={PLATFORM} maximized={maximized} />
      )}
    </div>
  );
}
