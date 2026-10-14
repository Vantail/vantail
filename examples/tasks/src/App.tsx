/**
 * Tasks — a small todo app that uses `@vantail/icons` the way a real
 * application would.
 *
 * Two import styles, each where it belongs:
 *
 * - Static (`import { House } from "@vantail/icons/react"`) for the fixed
 *   chrome: sidebar, toolbar, buttons. Only the imported icons ship.
 * - Dynamic (`<Icon name={task.icon}>`) for data-driven artwork: each task
 *   stores a canonical kind name, resolved at render. Unknown names draw the
 *   placeholder instead of crashing, which is also what makes the stored
 *   list robust across Lucide upgrades.
 */

import { useEffect, useMemo, useState } from "react";

import { clipboard, isVantail } from "@vantail/api";
import { isIconName } from "@vantail/icons";
import {
  Circle,
  CircleCheckBig,
  ClipboardCopy,
  House,
  Icon,
  Inbox,
  Plus,
  Search,
  Star,
  Trash,
} from "@vantail/icons/react";

import {
  clearDone,
  countTasks,
  createTask,
  DEFAULT_KIND,
  KIND_ICONS,
  loadTasks,
  removeTask,
  saveTasks,
  taskListText,
  toggleDone,
  toggleStar,
  visibleTasks,
  type Filter,
  type Task,
} from "./tasks.js";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function newId(): string {
  try {
    return globalThis.crypto?.randomUUID?.() ?? `task-${Date.now()}`;
  } catch {
    return `task-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  }
}

async function copyText(text: string): Promise<void> {
  if (isVantail()) {
    await clipboard.writeText(text);
    return;
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the legacy path.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("the browser refused clipboard access");
    }
  } finally {
    area.remove();
  }
}

const FILTERS: { id: Filter; title: string; icon: (size: number) => React.ReactNode }[] = [
  { id: "all", title: "All tasks", icon: (size) => <House size={size} /> },
  { id: "starred", title: "Starred", icon: (size) => <Star size={size} /> },
  { id: "done", title: "Done", icon: (size) => <CircleCheckBig size={size} /> },
];

export function App() {
  const [tasks, setTasks] = useState<Task[]>(() => loadTasks(storage(), isIconName));
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<string>(DEFAULT_KIND);
  const [notice, setNotice] = useState<string | null>(null);

  function update(next: (prev: Task[]) => Task[]): void {
    // Functional update: every mutation computes from the latest state, so
    // rapid toggles can never overwrite each other with a stale snapshot.
    setTasks(next);
  }

  useEffect(() => {
    saveTasks(storage(), tasks);
  }, [tasks]);

  const shown = useMemo(
    () => visibleTasks(tasks, filter, query),
    [tasks, filter, query],
  );
  const counts = useMemo(() => countTasks(tasks), [tasks]);

  function addTask(): void {
    const task = createTask(newId(), draft, kind, Date.now());
    if (!task) return;
    update((prev) => [...prev, task]);
    setDraft("");
  }

  async function copyList(): Promise<void> {
    try {
      await copyText(taskListText(shown));
      setNotice(`Copied ${shown.length} task${shown.length === 1 ? "" : "s"}.`);
    } catch (cause) {
      setNotice(
        `Copy failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  const emptyHint =
    query.trim() !== ""
      ? `No tasks match “${query.trim()}”.`
      : filter === "starred"
        ? "Star a task to pin it here."
        : filter === "done"
          ? "Finished tasks land here."
          : "Add your first task above.";

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Task views">
        <p className="brand">Tasks</p>
        {FILTERS.map((view) => {
          const count =
            view.id === "all"
              ? counts.all
              : view.id === "starred"
                ? counts.starred
                : counts.done;
          return (
            <button
              key={view.id}
              type="button"
              className={filter === view.id ? "side-item active" : "side-item"}
              aria-current={filter === view.id ? "page" : undefined}
              onClick={() => setFilter(view.id)}
            >
              <span className="side-label">
                {view.icon(17)}
                {view.title}
              </span>
              <span className="side-count">{count}</span>
            </button>
          );
        })}
        <p className="side-hint">
          {counts.active} open · {counts.done} done
        </p>
      </nav>

      <main className="content">
        <div className="toolbar">
          <div className="search-wrap">
            <span className="search-icon" aria-hidden="true">
              <Search size={15} />
            </span>
            <label className="visually-hidden" htmlFor="task-search">
              Search tasks
            </label>
            <input
              id="task-search"
              type="search"
              placeholder="Search tasks…"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={() => void copyList()}
          >
            <ClipboardCopy size={15} />
            Copy list
          </button>
          {counts.done > 0 && (
            <button
              type="button"
              className="ghost-button danger"
              onClick={() => update((prev) => clearDone(prev))}
            >
              <Trash size={15} />
              Clear done
            </button>
          )}
        </div>

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            addTask();
          }}
        >
          <div className="composer-row">
            <label className="visually-hidden" htmlFor="new-task">
              New task title
            </label>
            <input
              id="new-task"
              type="text"
              placeholder="What needs doing?"
              autoComplete="off"
              maxLength={200}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button
              type="submit"
              className="add-button"
              disabled={draft.trim() === ""}
              aria-label="Add task"
            >
              <Plus size={17} />
            </button>
          </div>
          <div
            className="kind-row"
            role="radiogroup"
            aria-label="Task kind icon"
          >
            {KIND_ICONS.map((name) => (
              <button
                key={name}
                type="button"
                role="radio"
                aria-checked={kind === name}
                aria-label={`Kind: ${name}`}
                title={name}
                className={kind === name ? "kind active" : "kind"}
                onClick={() => setKind(name)}
              >
                <Icon name={name} size={17} />
              </button>
            ))}
          </div>
        </form>

        {shown.length === 0 ? (
          <div className="empty">
            <Inbox size={40} strokeWidth={1.25} />
            <p>{emptyHint}</p>
          </div>
        ) : (
          <ul className="task-list">
            {shown.map((task) => (
              <li key={task.id} className={task.done ? "task done" : "task"}>
                <button
                  type="button"
                  className="check"
                  aria-pressed={task.done}
                  aria-label={task.done ? `Reopen ${task.title}` : `Finish ${task.title}`}
                  onClick={() => update((prev) => toggleDone(prev, task.id))}
                >
                  {task.done ? (
                    <CircleCheckBig size={20} />
                  ) : (
                    <Circle size={20} />
                  )}
                </button>
                <span
                  className="kind-mark"
                  title={isIconName(task.icon) ? task.icon : "unknown kind"}
                >
                  <Icon name={task.icon} size={18} />
                </span>
                <span className="task-title">{task.title}</span>
                <button
                  type="button"
                  className={task.starred ? "icon-button starred" : "icon-button"}
                  aria-pressed={task.starred}
                  aria-label={task.starred ? `Unstar ${task.title}` : `Star ${task.title}`}
                  onClick={() => update((prev) => toggleStar(prev, task.id))}
                >
                  <Star size={17} color={task.starred ? "#e8a72a" : undefined} />
                </button>
                <button
                  type="button"
                  className="icon-button danger"
                  aria-label={`Delete ${task.title}`}
                  onClick={() => update((prev) => removeTask(prev, task.id))}
                >
                  <Trash size={17} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="notice" role="status" aria-live="polite">
          {notice}
        </div>
      </main>
    </div>
  );
}
