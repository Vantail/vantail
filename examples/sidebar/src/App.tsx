/**
 * A sidebar-split title bar - the Mail, Notes, Xcode and Linear layout.
 *
 * The thing to understand is that there is no title bar element. The two
 * columns run the full height of the window, each with its own background,
 * and the "bar" is just their top `BAR_HEIGHT` pixels. The divider between
 * them runs through it. That is what makes the layout look like one piece
 * rather than a strip sitting on top of a sidebar.
 *
 * Which leaves one question, and it is the whole reason this example exists:
 * the platform's window buttons are at a fixed spot in the top-left corner of
 * the *window*, so whichever column happens to be under them has to reserve
 * `insetLeft`. Open the sidebar and that is the sidebar. Collapse it and it
 * becomes the content column. On Windows and Linux it is nobody, because
 * `insetLeft` is zero and this application draws its own controls instead.
 */

import { useCallback, useEffect, useState } from "react";

import { menu } from "@vantail/api";

import { Sidebar } from "./Sidebar.js";
import { Content } from "./Content.js";
import { BAR_HEIGHT, drawsOwnControls, useTitleBar } from "./titlebar.js";
import { THREADS } from "./threads.js";

const MIN_WIDTH = 180;
const MAX_WIDTH = 420;
const DEFAULT_WIDTH = 260;

export function App() {
  const metrics = useTitleBar();
  const ownControls = drawsOwnControls(metrics);

  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [collapsed, setCollapsed] = useState(false);
  const [selected, setSelected] = useState(THREADS[0]!.id);

  const thread = THREADS.find((it) => it.id === selected) ?? THREADS[0]!;

  const toggle = useCallback(() => setCollapsed((it) => !it), []);

  // Cmd-\ to collapse, the shortcut applications with this layout use. It
  // comes through the application menu rather than a key listener so it works
  // while focus is anywhere - including inside a control - and so it is
  // discoverable in the menu rather than being folklore.
  useEffect(() => menu.onClick(({ id }) => {
    if (id === "toggle-sidebar") toggle();
  }), [toggle]);

  /**
   * Dragging the divider.
   *
   * It is a child of the root rather than of either column, laid over the
   * boundary, so a pointer landing on it never reaches the headers that start
   * a window drag - the two gestures share the same strip of the title bar
   * and would otherwise both fire.
   */
  const startResize = (event: React.PointerEvent) => {
    if (collapsed) return;
    event.preventDefault();

    const from = event.clientX;
    const start = width;

    const move = (moved: PointerEvent) => {
      const next = start + moved.clientX - from;
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)));
    };
    const done = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", done);
      document.body.classList.remove("resizing");
    };

    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
  };

  // Never shorter than the room the platform reserved, or the window buttons
  // would hang off the bottom of the bar the page drew.
  const barHeight = Math.max(BAR_HEIGHT, metrics.height);

  return (
    <div
      className={`app${collapsed ? " collapsed" : ""}`}
      style={
        {
          "--sidebar-width": collapsed ? "0px" : `${width}px`,
          "--bar-height": `${barHeight}px`,
          // The two numbers the platform decides. `buttonTop` is where the
          // window buttons actually sit, which is not the middle of a bar
          // this tall - macOS puts them near the top - so anything meant to
          // line up with them uses it rather than centring.
          "--inset-left": `${metrics.insetLeft}px`,
          "--button-top": `${metrics.buttonTop}px`,
          "--button-height": `${metrics.buttonHeight}px`,
        } as React.CSSProperties
      }
    >
      <Sidebar
        selected={selected}
        onSelect={setSelected}
        // The sidebar is under the window buttons only while it is open.
        reservesInset={!collapsed && !ownControls}
      />

      {!collapsed && (
        <div
          className="divider"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onPointerDown={startResize}
          onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
        />
      )}

      <Content
        thread={thread}
        collapsed={collapsed}
        onToggleSidebar={toggle}
        // ...and the content column is under them once it is not.
        reservesInset={collapsed && !ownControls}
        ownControls={ownControls}
      />
    </div>
  );
}
