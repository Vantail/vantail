/**
 * The content column, and the toolbar across the top of it.
 *
 * The toolbar takes over reserving `insetLeft` when the sidebar is collapsed,
 * because that is when the window buttons are above this column instead.
 */

import { WindowControls } from "./WindowControls.js";
import { drag, zoom } from "./Sidebar.js";
import type { Thread } from "./threads.js";

export function Content({
  thread,
  collapsed,
  onToggleSidebar,
  reservesInset,
  ownControls,
}: {
  thread: Thread;
  collapsed: boolean;
  onToggleSidebar: () => void;
  reservesInset: boolean;
  ownControls: boolean;
}) {
  return (
    <main className="content">
      <header
        className={`bar toolbar${reservesInset ? " inset" : ""}`}
        onPointerDown={drag}
        onDoubleClick={zoom}
      >
        <button
          className="icon"
          title={collapsed ? "Show sidebar (Cmd-\\)" : "Hide sidebar (Cmd-\\)"}
          aria-pressed={!collapsed}
          onClick={onToggleSidebar}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="2" y="3" width="12" height="10" rx="2" />
            <path d="M6.5 3v10" />
          </svg>
        </button>

        <div className="crumbs">
          <span className="where">{thread.section}</span>
          <span className="sep">/</span>
          <span className="what">{thread.title}</span>
        </div>

        <div className="spacer" />

        <button className="icon" title="Archive">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="2.5" y="3" width="11" height="3" rx="1" />
            <path d="M4 6.5v6.5h8V6.5M6.5 9h3" />
          </svg>
        </button>

        {ownControls && <WindowControls />}
      </header>

      <article className="thread-view">
        <h1>{thread.title}</h1>
        {thread.messages.map((message, index) => (
          <div className="message" key={index}>
            <div className="who">
              <span className="from">{message.from}</span>
              <span className="at">{message.at}</span>
            </div>
            <p>{message.body}</p>
          </div>
        ))}
      </article>
    </main>
  );
}
