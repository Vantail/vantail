/**
 * The sidebar column, top to bottom.
 *
 * Its header is not a separate title bar - it is the top of this column. It
 * wires up no dragging: the runtime moves the window from the band a hidden
 * bar left behind, and leaves the controls in it alone.
 */

import { SECTIONS, THREADS } from "./threads.js";

export function Sidebar({
  selected,
  onSelect,
  reservesInset,
}: {
  selected: string;
  onSelect: (id: string) => void;
  reservesInset: boolean;
}) {
  return (
    <aside className="sidebar">
      <header className={`bar sidebar-head${reservesInset ? " inset" : ""}`}>
        <span className="account">Threads</span>
        <button className="icon" title="New thread" onClick={() => {}}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3.5v9M3.5 8h9" />
          </svg>
        </button>
      </header>

      <nav className="threads">
        {SECTIONS.map((section) => (
          <section key={section}>
            <h2>{section}</h2>
            {THREADS.filter((thread) => thread.section === section).map((thread) => (
              <button
                key={thread.id}
                className={`thread${thread.id === selected ? " on" : ""}`}
                onClick={() => onSelect(thread.id)}
              >
                <span className="row">
                  <span className="title">{thread.title}</span>
                  <span className="at">{thread.at}</span>
                </span>
                <span className="row">
                  <span className="preview">{thread.preview}</span>
                  {thread.unread > 0 && <span className="badge">{thread.unread}</span>}
                </span>
              </button>
            ))}
          </section>
        ))}
      </nav>
    </aside>
  );
}
