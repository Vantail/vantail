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
  type TitleBarMetrics,
  type TitleBarStyle,
} from "@vantail/api";

/**
 * This window's title bar, as state.
 *
 * The runtime measures the platform's bar and hands the numbers to the page
 * before it lays out, so the first render is already correct - no effect, no
 * flash, no hardcoded 28 that is wrong on half the machines it runs on.
 * Everything after that is a state update, which is what makes it React's
 * problem rather than the DOM's.
 */
export function useTitleBar() {
  // Read synchronously for the initial state: `titleBarMetrics()` comes off
  // the injected bridge, so there is nothing to await.
  const [metrics, setMetrics] = useState<TitleBarMetrics>(
    () => titleBarMetrics() ?? { height: 0, insetLeft: 0, insetRight: 0 },
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

  return {
    metrics,
    style,
    setStyle,
    setHeight,
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
  onGo,
  onProfile,
  onSettings,
}: {
  metrics: TitleBarMetrics;
  title: string;
  places: Place[];
  current: number;
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

  return (
    <div
      className="titlebar"
      onPointerDown={drag}
      onDoubleClick={maximise}
      style={
        {
          height: metrics.height,
          paddingLeft: metrics.insetLeft,
          paddingRight: metrics.insetRight,
          // Everything inside is sized off this, so asking for a taller bar
          // scales the controls with it instead of leaving them adrift in the
          // middle of too much space.
          "--tb-height": `${metrics.height}px`,
        } as React.CSSProperties
      }
    >
      {ownControls && <WindowDots />}

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
 * Close, minimise and zoom, for the platforms that took theirs away with the
 * title bar.
 *
 * Round and on the left, to match the ones macOS keeps - this is one
 * application looking the same on three platforms rather than three
 * conventions in one codebase. They centre themselves in whatever height the
 * bar is, the same as the real ones do.
 */
function WindowDots() {
  return (
    <span className="titlebar-dots">
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
        title="Maximise"
        aria-label="Maximise"
        onClick={() => void appWindow.toggleMaximize()}
      />
    </span>
  );
}
