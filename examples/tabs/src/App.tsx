/**
 * A tabbed application whose tabs live in the title bar.
 *
 * Deliberately not a browser: there is no address bar, no back and forward,
 * nothing pretending to load a page. Tabs in the title bar are a shape any
 * document application can use - editors, terminals, chat clients - and the
 * interesting part is the strip, not what is under it.
 */

import { useEffect, useState } from "react";

import { appWindow, menu } from "@vantail/api";

import { appMenu } from "./menu.js";

import { TabStrip } from "./TabStrip.js";
import type { Tab } from "./TabStrip.js";

type Note = Tab & { body: string };

const START: Note[] = [
  {
    id: 1,
    title: "Meeting notes",
    hue: 265,
    body:
      "Tabs in the title bar\n\n" +
      "The strip above is the window's title bar. The page runs to the top " +
      "edge and draws the tabs itself; the runtime only says how much room " +
      "the platform's window buttons need.\n\n" +
      "Try dragging the empty part of the strip - it moves the window, the " +
      "way the bar it replaced did.",
  },
  {
    id: 2,
    title: "Shopping list",
    hue: 210,
    body: "Coffee\nOat milk\nSomething for Sunday\nBatteries (AA)",
  },
  {
    id: 3,
    title: "Draft: release post",
    hue: 25,
    body:
      "Open a few more tabs with Cmd-T and watch them share the strip out " +
      "between them. That is flexbox doing it, not a resize handler - which " +
      "is why they keep up while the window is being dragged.",
  },
];

export function App() {
  const [notes, setNotes] = useState<Note[]>(START);
  const [activeId, setActiveId] = useState(1);
  const [nextId, setNextId] = useState(4);

  const active = notes.find((note) => note.id === activeId) ?? notes[0];

  const open = () => {
    const note: Note = {
      id: nextId,
      title: "Untitled",
      hue: (nextId * 47) % 360,
      body: "",
    };
    setNotes((current) => [...current, note]);
    setActiveId(note.id);
    setNextId((id) => id + 1);
  };

  const close = (id: number) => {
    setNotes((current) => {
      // The last tab closing closes the window, which is what every tabbed
      // application does - and the one part of a tab strip that needs the
      // native side.
      if (current.length === 1) {
        void appWindow.close();
        return current;
      }

      const index = current.findIndex((note) => note.id === id);
      const remaining = current.filter((note) => note.id !== id);
      // Focus whatever slid into its place, or the new last one.
      setActiveId((was) =>
        was === id
          ? (remaining[index] ?? remaining[remaining.length - 1]).id
          : was,
      );
      return remaining;
    });
  };

  // File > New Tab and File > Close Tab, which is where Cmd-T and Cmd-W come
  // from. Reading `activeId` inside the handler rather than closing over it
  // keeps the subscription from being torn down on every tab switch.
  useEffect(() => {
    return menu.onClick(({ id }) => {
      if (id === "new-tab") open();
      if (id === "close-tab") close(activeId);
    });
  }, [activeId, nextId]);

  const edit = (body: string) =>
    setNotes((current) =>
      current.map((note) => (note.id === activeId ? { ...note, body } : note)),
    );

  return (
    <div className="app">
      <TabStrip
        tabs={notes}
        activeId={activeId}
        menu={appMenu()}
        onSelect={setActiveId}
        onClose={close}
        onOpen={open}
      />

      <main className="page">
        <textarea
          key={active?.id}
          className="editor"
          value={active?.body ?? ""}
          onChange={(event) => edit(event.target.value)}
          spellCheck={false}
          aria-label={active?.title ?? "Note"}
        />
      </main>
    </div>
  );
}
