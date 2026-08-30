import { useCallback, useEffect, useRef, useState } from "react";

import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faChevronLeft,
  faChevronRight,
  faCircleUser,
  faGear,
  faMagnifyingGlass,
} from "@fortawesome/free-solid-svg-icons";

import {
  appWindow,
  titleBarMetrics,
  type MenuItem,
  type Platform,
  type TitleBarButtons,
  type TitleBarMetrics,
  type TitleBarStyle,
} from "@vantail/api";

import { MenuBar } from "./MenuBar.js";
import { PLATFORM } from "./platform.js";
import { MIN_HEIGHT, MIN_WIDTH } from "./window.js";

/**
 * This window's title bar, as state.
 *
 * The runtime measures the platform's bar and hands the numbers to the page
 * before it lays out, so the first render is already correct - no effect, no
 * flash, no hardcoded 28 that is wrong on half the machines it runs on.
 * Everything after that is a state update, which is what makes it React's
 * problem rather than the DOM's.
 */
/**
 * How tall this application draws its title bar.
 *
 * A plain number, because that is all it takes. With `titleBarStyle: "hidden"`
 * the page runs to the top edge of the window, so a bar is however many pixels
 * the design says - no platform involved, and the same on all three of them.
 *
 * `titleBarMetrics().height` is a different question: how tall the *platform's*
 * bar is, which matters for reserving room and not for this.
 */
export const BAR_HEIGHT = 44;

export function useTitleBar() {
  // Read synchronously for the initial state: `titleBarMetrics()` comes off
  // the injected bridge, so there is nothing to await.
  const [metrics, setMetrics] = useState<TitleBarMetrics>(
    () =>
      titleBarMetrics() ?? {
        height: 0,
        insetLeft: 0,
        insetRight: 0,
        buttonTop: 0,
        buttonHeight: 0,
      },
  );
  const [style, setStyleState] = useState<TitleBarStyle>("default");

  useEffect(() => {
    void appWindow.titleBarStyle().then(setStyleState);
  }, []);

  const setStyle = useCallback(async (next: TitleBarStyle) => {
    setMetrics(await appWindow.setTitleBarStyle(next));
    setStyleState(next);
  }, []);

  const setHeight = useCallback(async (height: number | null) => {
    setMetrics(await appWindow.setTitleBarHeight(height));
  }, []);

  const setButtons = useCallback(async (buttons: TitleBarButtons) => {
    setMetrics(await appWindow.setTitleBarButtons(buttons));
  }, []);

  return {
    metrics,
    style,
    setStyle,
    setHeight,
    setButtons,
    /** Whether this application is drawing the window buttons. */
    ownButtons: metrics.insetLeft === 0,
    /** Whether this window is the one drawing its title bar. */
    custom: style === "hidden",
  };
}

/** Somewhere this window can go back to, the way a browser has history. */
export interface Place {
  id: string;
  label: string;
}

/**
 * The bar itself.
 *
 * Laid out from the metrics rather than from constants, so it matches the bar
 * it replaced and follows a height change without this component knowing what
 * any platform's numbers are.
 */
export function TitleBar({
  metrics,
  title,
  places,
  current,
  menu,
  onGo,
  onProfile,
  onSettings,
}: {
  metrics: TitleBarMetrics;
  title: string;
  places: Place[];
  current: number;
  /** The application menu, when this bar is the one drawing it. */
  menu?: MenuItem[];
  onGo: (index: number) => void;
  onProfile: () => void;
  onSettings: () => void;
}) {
  const interactive = (event: { target: EventTarget | null }) =>
    (event.target as Element).closest("button, input, a, select, [role='menu']");

  const drag = (event: React.PointerEvent) => {
    // Buttons and inputs stay clickable; everything else drags the window,
    // which is what the bar this replaced did.
    if (interactive(event)) return;
    if (event.buttons === 1) void appWindow.startDragging();
  };

  const maximise = (event: React.MouseEvent) => {
    if (interactive(event)) return;
    void appWindow.toggleMaximize();
  };

  // Where the platform reserved no room on the leading edge it drew no
  // buttons either, so this application has to. Measuring is the test rather
  // than the platform's name: it stays right if a platform changes its mind.
  const ownControls = metrics.insetLeft === 0;

  // The bar this application draws, which is its own decision - see
  // `BAR_HEIGHT`. At least as tall as the room the platform reserved, or the
  // window buttons would hang off the bottom of it.
  //
  // The controls inside are centred in it, and the system's window buttons are
  // not: macOS puts those near the top, so in a bar much taller than its own
  // they sit a little above everything else. `titleBarMetrics()` reports
  // `buttonTop` and `buttonHeight` for applications that would rather line a
  // row up with them than with the middle - a two-row bar usually wants that,
  // and a one-row bar this close to the platform's own height does not.
  const barHeight = Math.max(BAR_HEIGHT, metrics.height);

  // macOS greys its traffic lights when the window is not in front, and an
  // application drawing its own should do the same - coloured dots on a
  // background window are the tell of a title bar that is only a picture of
  // one.
  const [focused, setFocused] = useState(true);
  useEffect(() => appWindow.onFocusChanged((state) => setFocused(state.focused)), []);

  // Windows and GNOME swap the maximise button for a restore one, so the bar
  // has to know which the window currently is. Asked again on every resize
  // because this button is not the only thing that maximises a window: a
  // double-click on the bar does, so does a snap to the edge of the screen,
  // and a button still offering to maximise a maximised window is the tell of
  // a bar that is only a picture of one.
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const sync = () => void appWindow.isMaximized().then(setMaximized);
    sync();
    return appWindow.onResized(sync);
  }, []);

  const controls = ownControls ? (
    <WindowControls platform={PLATFORM} maximized={maximized} />
  ) : null;

  const bar = useRef<HTMLDivElement>(null);

  // Keep the window wider than its own title bar.
  //
  // A bar that has run out of room is a bar with the close button off the end
  // of it, and no amount of CSS stops a window being dragged narrower. So the
  // bar measures what it needs and makes that the window's minimum - which
  // also means nobody has to keep a hardcoded number in step with what the
  // bar happens to contain this month.
  useEffect(() => {
    const element = bar.current;
    if (!element) return;

    let applied = 0;

    const measure = (): void => {
      const style = getComputedStyle(element);
      const gap = parseFloat(style.columnGap) || 0;
      const search = element.querySelector<HTMLElement>(".titlebar-search");
      const searchStyle = search && getComputedStyle(search);
      // What the field is meant to keep, which is not a `min-width` on the
      // field itself - see `style.css` for why that would be worse than
      // useless.
      const floor = parseFloat(style.getPropertyValue("--tb-search-min")) || 0;

      // Everything except the field, which is the one thing here that gives
      // way. Split at the field, because where it sits decides which of the
      // two sums below is the one that matters.
      let leading = 0;
      let trailing = 0;
      let past = false;
      for (const child of Array.from(element.children) as HTMLElement[]) {
        if (child === search) {
          past = true;
          continue;
        }
        if (past) trailing += child.offsetWidth + gap;
        else leading += child.offsetWidth + gap;
      }

      // Centred on the window, the field clears both ends only when the wider
      // end fits in half of what is left over - so the narrow end buys
      // nothing and the wide one is counted twice. In the flow it simply
      // needs whatever is left after everything else.
      const centred = searchStyle?.position === "absolute";
      const needed = Math.ceil(
        parseFloat(style.paddingLeft) +
          parseFloat(style.paddingRight) +
          floor +
          (centred ? 2 * Math.max(leading, trailing) : leading + trailing),
      );

      if (needed === applied) return;
      applied = needed;

      const width = Math.max(MIN_WIDTH, needed);
      void appWindow.setMinSize(width, MIN_HEIGHT);
      // A limit is a limit on the next resize, not on the size the window is
      // already at, so a window that is too narrow now stays too narrow until
      // somebody drags it. Maximised, it is wider than this by definition and
      // this does not fire.
      if (window.innerWidth < width) {
        void appWindow.setSize(width, window.innerHeight);
      }
    };

    measure();
    // The contents change size for reasons that are not a window resize - a
    // menu appearing, a taller bar, a longer label - and each of them moves
    // the floor.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [menu, barHeight, ownControls]);

  return (
    <div
      ref={bar}
      className={focused ? "titlebar" : "titlebar unfocused"}
      data-platform={PLATFORM}
      // Says a menu is in front of the search, which changes how the search
      // is centred - see `style.css`.
      data-menu={menu ? "" : undefined}
      onPointerDown={drag}
      onDoubleClick={maximise}
      style={
        {
          height: barHeight,
          // The room the system reserved for its own buttons. Left out
          // entirely when it reserved none, so the stylesheet's per-platform
          // padding gets a say - an inline zero would beat it.
          paddingLeft: metrics.insetLeft || undefined,
          paddingRight: metrics.insetRight || undefined,
          // The bar's own furniture is sized off this, so a taller bar scales
          // it with them instead of leaving it adrift in the middle of too
          // much space. The window controls are the exception - see the
          // per-platform blocks in `style.css` for why they hold their size.
          "--tb-height": `${barHeight}px`,
        } as React.CSSProperties
      }
    >
      {/* macOS keeps its buttons on the leading edge; Windows and GNOME put
          theirs on the trailing one, after whatever the application has up
          there. A change of DOM order rather than a CSS `order`, so tabbing
          through the bar follows what it looks like. */}
      {PLATFORM === "macos" && controls}

      {/* Where macOS puts its buttons, Windows puts the app icon. Windows
          only: GTK dropped the icon from its header bars, so an Adwaita
          application with one in the corner looks as out of place as traffic
          lights would.

          It lives in `public/` rather than being imported, because importing
          `icon.png` would ship a 1024px source into the bundle to draw 16
          points of it. Decorative: the window already says whose it is, and
          a screen reader announcing "Vantail Example" twice helps nobody. */}
      {PLATFORM === "windows" && (
        <img
          className="titlebar-icon"
          src="/app-icon.png"
          alt=""
          // An image drags itself by default, and a drag that starts an image
          // drag is a drag that does not move the window.
          draggable={false}
        />
      )}

      {menu && <MenuBar items={menu} />}

      <nav className="titlebar-history" aria-label="History">
        <button
          type="button"
          title="Back"
          disabled={current === 0}
          onClick={() => onGo(current - 1)}
        >
          <FontAwesomeIcon icon={faChevronLeft} />
        </button>
        <button
          type="button"
          title="Forward"
          disabled={current >= places.length - 1}
          onClick={() => onGo(current + 1)}
        >
          <FontAwesomeIcon icon={faChevronRight} />
        </button>
      </nav>

      <SearchBar
        title={title}
        places={places}
        current={current}
        onGo={onGo}
      />

      <span className="titlebar-actions">
        <button
          type="button"
          className="titlebar-action"
          title="Profile"
          aria-label="Profile"
          onClick={onProfile}
        >
          <FontAwesomeIcon icon={faCircleUser} />
        </button>
        <button
          type="button"
          className="titlebar-action"
          title="Settings"
          aria-label="Settings"
          onClick={onSettings}
        >
          <FontAwesomeIcon icon={faGear} />
        </button>
      </span>

      {PLATFORM !== "macos" && controls}
    </div>
  );
}

/**
 * The centred search field, and the list it drops down.
 *
 * The same shape as the one across the top of VS Code: it reads as the
 * window's title until you click it, and then it is a picker.
 */
function SearchBar({
  title,
  places,
  current,
  onGo,
}: {
  title: string;
  places: Place[];
  current: number;
  onGo: (index: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    field.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    // A click anywhere else closes it, which is what makes it feel like a
    // menu rather than a panel.
    const onDown = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const matches = places.filter((place) =>
    place.label.toLowerCase().includes(query.trim().toLowerCase()),
  );

  const choose = (id: string) => {
    const index = places.findIndex((place) => place.id === id);
    if (index >= 0) onGo(index);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="titlebar-search" ref={box}>
      {open ? (
        <input
          ref={field}
          className="titlebar-search-field"
          placeholder="Go to..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && matches[0]) choose(matches[0].id);
          }}
        />
      ) : (
        <button
          type="button"
          className="titlebar-search-button"
          onClick={() => setOpen(true)}
        >
          <FontAwesomeIcon
            icon={faMagnifyingGlass}
            className="titlebar-search-icon"
          />
          <span className="titlebar-search-label">
            {places[current]?.label ?? title}
          </span>
        </button>
      )}

      {open && (
        <div className="titlebar-menu" role="menu">
          {matches.length === 0 && (
            <p className="titlebar-menu-empty">Nothing matches “{query}”.</p>
          )}
          {matches.map((place) => (
            <button
              type="button"
              role="menuitem"
              key={place.id}
              className={place.id === places[current]?.id ? "current" : ""}
              onClick={() => choose(place.id)}
            >
              {place.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Close, minimise and maximise, in the shape the platform draws them.
 *
 * Three platforms, three conventions, and they do not travel. Traffic lights
 * on Windows read as a web page wearing a window, and Windows' square caption
 * buttons on macOS read the same way - a custom title bar is only convincing
 * for as long as its controls are the ones the user already knows, so this
 * branches on the platform rather than picking one look and calling it
 * consistency.
 *
 * What differs is more than the drawing: macOS puts them on the leading edge
 * in close-minimise-zoom order, Windows and GNOME on the trailing edge in
 * minimise-maximise-close. The order lives here; the geometry is in
 * `style.css`, keyed off `data-platform` on the bar.
 */
function WindowControls({
  platform,
  maximized,
}: {
  platform: Platform;
  maximized: boolean;
}) {
  const restore = maximized ? "Restore" : "Maximise";

  if (platform === "macos") {
    return (
      <span className="titlebar-controls mac">
        <button
          type="button"
          className="dot close"
          title="Close"
          aria-label="Close"
          onClick={() => void appWindow.close()}
        />
        <button
          type="button"
          className="dot minimise"
          title="Minimise"
          aria-label="Minimise"
          onClick={() => void appWindow.minimize()}
        />
        <button
          type="button"
          className="dot zoom"
          title={restore}
          aria-label={restore}
          onClick={() => void appWindow.toggleMaximize()}
        />
      </span>
    );
  }

  return (
    <span
      className={`titlebar-controls ${platform === "windows" ? "win" : "adw"}`}
    >
      <button
        type="button"
        className="cap minimise"
        title="Minimise"
        aria-label="Minimise"
        onClick={() => void appWindow.minimize()}
      >
        <Glyph d="M0 5 H10" />
      </button>
      <button
        type="button"
        className="cap zoom"
        title={restore}
        aria-label={restore}
        onClick={() => void appWindow.toggleMaximize()}
      >
        {maximized ? (
          // The window in front and the one behind it, which is what both
          // platforms draw once there is something to restore to.
          <Glyph d="M0.5 2.5 h7 v7 h-7 z M2.5 2.5 v-2 h7 v7 h-2" />
        ) : (
          <Glyph d="M0.5 0.5 h9 v9 h-9 z" />
        )}
      </button>
      <button
        type="button"
        className="cap close"
        title="Close"
        aria-label="Close"
        onClick={() => void appWindow.close()}
      >
        <Glyph d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5" />
      </button>
    </span>
  );
}

/**
 * One caption glyph.
 *
 * Drawn rather than set in Segoe Fluent Icons. That font is the real source
 * of these shapes, but it only exists on Windows 11 - Windows 10 has the same
 * glyphs under a different name, and Linux has neither - and a missing icon
 * font shows as three empty boxes in the corner of every window. A path is
 * the same picture with nothing to install and nothing to fall back to.
 *
 * The box is ten units and the glyph is drawn at ten pixels, so a unit is a
 * pixel and a stroke of 1 is the hairline the system draws - which is what
 * keeps these from looking soft next to a real Windows caption.
 */
function Glyph({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}
