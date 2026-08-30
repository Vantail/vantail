/**
 * A title bar in the shape of a streaming app's: window buttons, history
 * arrows, a home button and a search field in the middle, and an account menu
 * on the right.
 *
 * Everything here is laid out by CSS. Nothing measures the window, listens for
 * `resize`, or positions anything from JavaScript - which is what keeps the
 * bar in step with the frame while the window is being dragged. The only
 * numbers that come from the runtime are the ones it alone knows: how much
 * room the platform's window buttons need, and how far down they sit.
 */

import { useEffect, useRef, useState } from "react";

import { appWindow, titleBarMetrics } from "@vantail/api";
import type { MenuItem, TitleBarMetrics } from "@vantail/api";

import { MenuBar } from "./MenuBar.js";
import { DRAWS_OWN_MENU, PLATFORM } from "./platform.js";
import { WindowControls } from "./WindowControls.js";
import { MIN_HEIGHT, MIN_WIDTH } from "./window.js";

import {
  Bell,
  Browse,
  ChevronLeft,
  ChevronRight,
  Check,
  External,
  Friends,
  Home,
  Search,
} from "./icons.js";

/** What the runtime says when it has nothing to say - a plain title bar. */
const NOTHING_RESERVED: TitleBarMetrics = {
  height: 0,
  insetLeft: 0,
  insetRight: 0,
  buttonTop: 0,
  buttonHeight: 0,
};

const MENU = [
  { label: "Account", external: true },
  { label: "Set up your Duo plan", external: true },
  { label: "Profile", external: false },
  { label: "Recents", external: false },
  { label: "Support", external: true },
  { label: "Private session", external: false },
  { label: "Settings", external: false },
  { label: "Log out", external: false },
];

export function TitleBar({ menu }: { menu?: MenuItem[] }) {
  // Read synchronously: `titleBarMetrics()` comes off the injected bridge, so
  // the first paint already has the right numbers and the bar never jumps.
  const [metrics] = useState<TitleBarMetrics>(
    () => titleBarMetrics() ?? NOTHING_RESERVED,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const account = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLElement>(null);

  // Where the platform reserved no room on the leading edge it drew no window
  // buttons either, so this application has to. Measuring is the test rather
  // than the platform's name: it stays right if a platform changes its mind.
  const ownControls = metrics.insetLeft === 0;

  // The maximise button has two shapes, and which one it shows is the
  // window's business rather than this component's.
  useEffect(() => {
    if (!ownControls) return;
    void appWindow.isMaximized().then(setMaximized);
    return appWindow.onResized(() => {
      void appWindow.isMaximized().then(setMaximized);
    });
  }, [ownControls]);

  // Keep the window wider than its own title bar.
  //
  // A bar that has run out of room is a bar with the close button off the end
  // of it, and no amount of CSS stops a window being dragged narrower. So the
  // bar measures what it needs and makes that the window's minimum, which
  // also means nobody has to keep a hardcoded number in step with whatever
  // the bar happens to contain this month.
  useEffect(() => {
    const element = bar.current;
    if (!element) return;

    let applied = 0;

    const measure = () => {
      const style = getComputedStyle(element);
      const gap = parseFloat(style.columnGap) || 0;
      const search = element.querySelector<HTMLElement>(".search");
      // What the field is meant to keep. It is the one thing in the bar that
      // gives way, so it is measured as a floor rather than as a width.
      const floor = 220;

      let others = 0;
      for (const child of Array.from(element.children) as HTMLElement[]) {
        if (child === search?.parentElement) continue;
        others += child.offsetWidth + gap;
      }

      const needed = Math.ceil(
        parseFloat(style.paddingLeft) +
          parseFloat(style.paddingRight) +
          floor +
          others,
      );
      if (needed === applied) return;
      applied = needed;

      const width = Math.max(MIN_WIDTH, needed);
      void appWindow.setMinSize(width, MIN_HEIGHT);
      // A limit binds the next resize, not the size the window is already at.
      if (window.innerWidth < width) {
        void appWindow.setSize(width, window.innerHeight);
      }
    };

    measure();
    // The contents change size for reasons that are not a window resize - a
    // menu appearing, a longer label - and each of them moves the floor.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [menu, ownControls]);

  // Close on a click anywhere else, or on Escape - the two ways every menu on
  // every platform closes.
  useEffect(() => {
    if (!menuOpen) return;

    const away = (event: MouseEvent) => {
      if (!account.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };

    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [menuOpen]);

  // Anything that is not a control drags the window, and a double-click zooms
  // it - which is what the bar this replaced did, and what people expect of
  // any strip along the top of a window.
  const interactive = (event: { target: EventTarget | null }) =>
    (event.target as Element).closest("button, input, a, [role='menu']");

  const drag = (event: React.PointerEvent) => {
    if (interactive(event) || event.buttons !== 1) return;
    void appWindow.startDragging();
  };

  const zoom = (event: React.MouseEvent) => {
    if (interactive(event)) return;
    void appWindow.toggleMaximize();
  };

  return (
    <header
      ref={bar}
      className="titlebar"
      data-platform={PLATFORM}
      onPointerDown={drag}
      onDoubleClick={zoom}
      style={{
        // The three numbers only the runtime knows. `insetLeft` is the room
        // the platform's window buttons take; it is 0 where the platform drew
        // none, and then this padding simply disappears.
        paddingLeft: `calc(${metrics.insetLeft}px + var(--gap))`,
        paddingRight: `calc(${metrics.insetRight}px + var(--gap))`,
      }}
    >
      {ownControls && PLATFORM === "macos" && (
        <WindowControls platform={PLATFORM} maximized={maximized} />
      )}

      {menu && DRAWS_OWN_MENU && <MenuBar items={menu} />}

      <nav className="history" aria-label="History">
        <button type="button" aria-label="Back" onClick={() => history.back()}>
          <ChevronLeft className="glyph" />
        </button>
        <button
          type="button"
          aria-label="Forward"
          onClick={() => history.forward()}
        >
          <ChevronRight className="glyph" />
        </button>
      </nav>

      <div className="middle">
        <button type="button" className="home" aria-label="Home">
          <Home className="glyph" />
        </button>

        <div className="search">
          <Search className="glyph search-glyph" />
          <input
            type="search"
            placeholder="What do you want to play?"
            aria-label="Search"
          />
          <span className="search-divider" />
          <button type="button" className="browse" aria-label="Browse">
            <Browse className="glyph" />
          </button>
        </div>
      </div>

      <div className="account" ref={account}>
        <button type="button" className="icon" aria-label="What's new">
          <Bell className="glyph" />
        </button>
        <button type="button" className="icon" aria-label="Friend activity">
          <Friends className="glyph" />
        </button>
        <button
          type="button"
          className="avatar"
          aria-label="Account"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span aria-hidden>JW</span>
        </button>

        {menuOpen && (
          <div className="menu" role="menu">
            {MENU.map((item) => (
              <button
                type="button"
                role="menuitem"
                key={item.label}
                onClick={() => setMenuOpen(false)}
              >
                {item.label}
                {item.external && <External className="glyph external" />}
              </button>
            ))}

            <div className="menu-updates">
              <h2>Your Updates</h2>
              <Check className="glyph tick" />
              <p className="caught-up">You're all caught up</p>
              <p className="quiet">
                Watch this space for news on your followers, playlists, events
                and more.
              </p>
            </div>
          </div>
        )}
      </div>

      {ownControls && PLATFORM !== "macos" && (
        <WindowControls platform={PLATFORM} maximized={maximized} />
      )}
    </header>
  );
}
