/**
 * The application window's title bar, drawn by the application.
 *
 * The window is opened with `titleBarStyle: "hidden"` - see the handover in
 * `SplashScreen.tsx` - so there is no platform bar here and the page runs to
 * the top edge of the window. Everything in this strip is the application's,
 * including, on two platforms out of three, the buttons that close it.
 *
 * Nothing here calls `startDragging`. The runtime moves the window from the
 * band a hidden bar left behind - `titleBarHeight` pixels tall, which is
 * exactly this strip - and leaves controls inside it alone, so a bar built out
 * of real `<button>` elements is draggable and clickable without a line of
 * JavaScript.
 */

import { useEffect, useState } from "react";

import { appWindow } from "@vantail/api";
import { PanelsTopLeft, Pin, PinOff } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PLATFORM } from "@/platform";
import { BAR_HEIGHT, drawsOwnControls, useTitleBar } from "@/window";
import { WindowControls } from "@/WindowControls";

export function TitleBar({ title }: { title: string }) {
  const metrics = useTitleBar();
  const ownControls = drawsOwnControls(metrics);

  // macOS greys its traffic lights when the window is not in front, and an
  // application drawing its own should do the same.
  const [focused, setFocused] = useState(true);
  useEffect(() => appWindow.onFocusChanged((state) => setFocused(state.focused)), []);

  // Kept here rather than asked of the window, because the button below is the
  // only thing in this application that changes it. A bar showing a setting
  // something else could change would have to ask - the way the maximise
  // button in `WindowControls` does, since a double click and a snap to the
  // edge of the screen both maximise a window behind its back.
  const [onTop, setOnTop] = useState(false);

  const controls = ownControls ? <WindowControls focused={focused} /> : null;

  return (
    <header
      className="bg-card text-card-foreground flex shrink-0 items-center gap-2 border-b"
      style={{
        // At least as tall as the room the platform reserved, or the traffic
        // lights would hang off the bottom of the bar.
        height: Math.max(BAR_HEIGHT, metrics.height),
        // The room the system reserved for its own buttons. Left off entirely
        // when it reserved none, so the padding below gets a say - an inline
        // zero would beat it.
        paddingLeft: metrics.insetLeft || undefined,
        paddingRight: metrics.insetRight || undefined,
      }}
    >
      {/* macOS keeps its buttons on the leading edge; Windows and GNOME put
          theirs on the trailing one, after whatever the application has up
          here. A change of DOM order rather than a CSS `order`, so tabbing
          through the bar follows what it looks like. */}
      {PLATFORM === "macos" && controls}

      <div
        className={`flex min-w-0 items-center gap-2 ${
          // Where the platform reserved nothing, the first thing in the bar
          // would otherwise run into the corner.
          ownControls ? "pl-2" : ""
        }`}
      >
        <PanelsTopLeft className="text-brand size-4 shrink-0" aria-hidden="true" />
        <span className="truncate text-sm font-medium">{title}</span>
        <Badge variant="secondary" className="hidden shrink-0 sm:inline-flex">
          hidden title bar
        </Badge>
      </div>

      {/*
        Nothing in this bar opts out of the drag band, and nothing has to: the
        runtime skips controls, and every interactive thing here is a real
        `<button>`. It is worth knowing which half of that sentence is doing
        the work - a control built out of a `<div>` is not a control as far as
        the drag is concerned, and a pointer down on one moves the window
        instead of pressing it. Give such a thing `role="button"`, which you
        wanted for screen readers anyway, or mark it `data-vantail-no-drag`.
      */}
      <div className="ml-auto flex items-center gap-1 pr-2">
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground gap-1.5"
          aria-pressed={onTop}
          onClick={() => {
            const next = !onTop;
            setOnTop(next);
            void appWindow.setAlwaysOnTop(next);
          }}
        >
          {onTop ? <Pin aria-hidden="true" /> : <PinOff aria-hidden="true" />}
          <span className="hidden md:inline">{onTop ? "On top" : "Not on top"}</span>
        </Button>
      </div>

      {PLATFORM !== "macos" && controls}
    </header>
  );
}
