/**
 * The part of this application that is always there.
 *
 * The window is incidental - it is shut most of the time and the application
 * keeps running without it (`quitOnLastWindowClosed: false`). What persists
 * is the icon and the countdown beside it, so this file owns both.
 */

import { menu, notification, tray, type MenuItem } from "@vantail/api";

import { clock, LENGTH, pause, reset, start, switchTo, timer } from "./timer.js";

/**
 * `title` is the text beside the icon, and macOS is the only platform that
 * shows it. Elsewhere the countdown lives in the tooltip instead, which is
 * the closest thing to a menu bar those platforms have.
 */
export async function paint() {
  // Shown while a phase is under way, running or paused - a paused timer
  // reading 12:04 is the most useful thing the menu bar can say, and blanking
  // it would make a paused application look like a broken one. An untouched
  // phase shows just the icon, so an idle app takes no room.
  const started = timer.running || timer.left < LENGTH[timer.phase];

  await tray.setTitle(started ? clock(timer.left) : null);
  await tray.setTooltip(
    started
      ? `${clock(timer.left)} of ${label(timer.phase)}${timer.running ? "" : " - paused"}`
      : "Focus",
  );
}

const label = (phase: "focus" | "break") => (phase === "focus" ? "focus" : "a break");

/**
 * The menu, rebuilt whenever the state it describes changes.
 *
 * A tray menu is not live: it is a snapshot taken when it was set, so "Start"
 * would still say Start after the timer had been started unless something
 * replaced it. Nothing here depends on the clock, so that is a handful of
 * times per session rather than once a second.
 */
export function items(): MenuItem[] {
  return [
    // No countdown in the label. It used to read `Pause (24:57)`, which meant
    // rebuilding the menu - and so mutating the status item - once a second,
    // for a number already sitting beside the icon. The menu now changes only
    // when the state it describes does.
    { type: "normal", id: "toggle", label: timer.running ? "Pause" : "Start" },
    { type: "normal", id: "reset", label: "Reset", enabled: timer.left < LENGTH[timer.phase] },
    { type: "separator" },
    {
      type: "checkbox",
      id: "focus",
      label: "Focus - 25 minutes",
      checked: timer.phase === "focus",
    },
    {
      type: "checkbox",
      id: "break",
      label: "Break - 5 minutes",
      checked: timer.phase === "break",
    },
    { type: "separator" },
    { type: "predefined", item: "quit" },
  ];
}

/** Create the icon. The menu and title are filled in by `paint` after. */
export async function install() {
  await tray.set({
    icon: "trayTemplate.png",
    // Without this the icon is drawn as-is and stays black against a dark
    // menu bar. As a template, macOS recolours it to match.
    iconAsTemplate: true,
    tooltip: "Focus",
    // The window is not "brought back" - it is placed under the icon, which
    // only this application knows how to do. So the click comes to us.
    leftClick: "event",
    menu: items(),
  });
}

/**
 * One listener for every menu in the application.
 *
 * `menu.onClick` fires for any item with an id wherever it lives - the app
 * menu, a tray menu, a popup - so the tray menu does not need its own.
 */
/** What the menu shows. Rebuild it when this changes, and not otherwise. */
export const menuState = () =>
  `${timer.running}:${timer.phase}:${timer.left < LENGTH[timer.phase]}`;

export function onMenu(handler: (id: string) => void) {
  return menu.onClick(({ id }) => handler(id));
}

/** What the menu items do, shared with the popover's buttons. */
export function command(id: string) {
  if (id === "toggle") return timer.running ? pause() : start();
  if (id === "reset") return reset();
  if (id === "focus") return switchTo("focus");
  if (id === "break") return switchTo("break");
}

/**
 * A phase ending is the one thing worth interrupting for, and the window is
 * usually closed when it happens - so it has to be a notification rather than
 * anything drawn in the popover.
 */
export async function announce(finished: "focus" | "break") {
  await notification.show({
    title: finished === "focus" ? "Focus finished" : "Break over",
    body: finished === "focus" ? "Take five." : "Back to it.",
  });
}
