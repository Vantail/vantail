/**
 * The light band under the command bar: open documents on the leading edge,
 * document actions on the trailing one.
 *
 * The runtime knows nothing about this row. `titleBarHeight` covers the
 * command bar above, because that is where the platform's window buttons go -
 * so the band the runtime drags by itself stops before this one, and
 * `data-vantail-drag` is what says this row moves the window too.
 *
 * The tabs are `role="tab"`, which is both the right ARIA and what keeps them
 * clickable: a bare `<div>` with a pointer handler is indistinguishable from
 * background, and the window would move instead of the tab being chosen.
 */

import { Close, Comment, Doc, History, Plus, Share } from "./icons.js";
import type { Tab } from "./tabs.js";

export function TabBar({
  tabs,
  active,
  onSelect,
  onClose,
  onNew,
}: {
  tabs: Tab[];
  active: number;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onNew: () => void;
}) {
  return (
    <div className="tabbar" data-vantail-drag>
      <div className="tabs" role="tablist">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === active}
            className={`tab${tab.id === active ? " on" : ""}`}
            onPointerDown={() => onSelect(tab.id)}
          >
            <span className="doc">
              <Doc />
            </span>
            <span className="label">{tab.title}</span>
            <button
              type="button"
              className="shut"
              title="Close tab"
              aria-label={`Close ${tab.title}`}
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
            >
              <Close />
            </button>
          </div>
        ))}

        <span className="rule" />

        <button type="button" className="new" title="New tab" onClick={onNew}>
          <Plus />
        </button>
      </div>

      <div className="doc-actions">
        <button type="button" className="share">
          <Share />
          Share
        </button>
        <button type="button" className="bar-button icon" title="Comments">
          <Comment />
        </button>
        <button type="button" className="bar-button icon" title="Version history">
          <History />
        </button>
      </div>
    </div>
  );
}
