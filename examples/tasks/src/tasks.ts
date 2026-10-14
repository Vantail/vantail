/**
 * Pure task logic for the Tasks example.
 *
 * Dependency-free like its sibling in the symbols example: everything
 * external (the known-icon check, storage, id generation) is passed in, so
 * this runs unchanged in the app and under `node --test`
 * (see `test/tasks.test.js`).
 */

export interface Task {
  id: string;
  title: string;
  done: boolean;
  starred: boolean;
  /** Canonical Lucide name for the task's kind icon. Validated on load. */
  icon: string;
  createdAt: number;
}

export type Filter = "all" | "starred" | "done";

export const TASKS_KEY = "tasks:list:v1";

/**
 * The small curated set of kind icons the "new task" row offers. This is a
 * UI choice, not a catalogue: the full Lucide set lives in `@vantail/icons`
 * (browse it in the symbols example). Each entry is validated with
 * `isIconName` before use, so a Lucide rename degrades to the default kind
 * instead of breaking.
 */
export const KIND_ICONS = [
  "briefcase",
  "shopping-cart",
  "heart",
  "book-open",
  "dumbbell",
  "plane",
  "gift",
  "phone",
] as const;

export type KindIcon = (typeof KIND_ICONS)[number];

export const DEFAULT_KIND: KindIcon = "briefcase";

export interface TaskStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isKindIcon(value: string): value is KindIcon {
  return (KIND_ICONS as readonly string[]).includes(value);
}

export function createTask(
  id: string,
  title: string,
  icon: string,
  createdAt: number,
): Task | null {
  const trimmed = title.trim();
  if (trimmed === "") return null;
  return {
    id,
    title: trimmed.slice(0, 200),
    done: false,
    starred: false,
    icon: isKindIcon(icon) ? icon : DEFAULT_KIND,
    createdAt,
  };
}

export function toggleDone(tasks: readonly Task[], id: string): Task[] {
  return tasks.map((task) =>
    task.id === id ? { ...task, done: !task.done } : task,
  );
}

export function toggleStar(tasks: readonly Task[], id: string): Task[] {
  return tasks.map((task) =>
    task.id === id ? { ...task, starred: !task.starred } : task,
  );
}

export function removeTask(tasks: readonly Task[], id: string): Task[] {
  return tasks.filter((task) => task.id !== id);
}

export function clearDone(tasks: readonly Task[]): Task[] {
  return tasks.filter((task) => !task.done);
}

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function visibleTasks(
  tasks: readonly Task[],
  filter: Filter,
  query: string,
): Task[] {
  const needle = normalizeQuery(query);
  return tasks
    .filter((task) => {
      if (filter === "starred" && !task.starred) return false;
      if (filter === "done" && !task.done) return false;
      return true;
    })
    .filter(
      (task) => needle === "" || task.title.toLowerCase().includes(needle),
    )
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt);
}

export interface TaskCounts {
  all: number;
  starred: number;
  done: number;
  active: number;
}

export function countTasks(tasks: readonly Task[]): TaskCounts {
  return {
    all: tasks.length,
    starred: tasks.filter((task) => task.starred).length,
    done: tasks.filter((task) => task.done).length,
    active: tasks.filter((task) => !task.done).length,
  };
}

/** Plain-text rendering for the "copy list" action. */
export function taskListText(tasks: readonly Task[]): string {
  if (tasks.length === 0) return "No tasks.";
  return tasks
    .map(
      (task) =>
        `${task.done ? "[x]" : "[ ]"}${task.starred ? " *" : ""} ${task.title}`,
    )
    .join("\n");
}

function isTaskValue(value: unknown): value is Task {
  if (typeof value !== "object" || value === null) return false;
  const task = value as Record<string, unknown>;
  return (
    typeof task.id === "string" &&
    task.id !== "" &&
    typeof task.title === "string" &&
    task.title !== "" &&
    typeof task.done === "boolean" &&
    typeof task.starred === "boolean" &&
    typeof task.icon === "string" &&
    typeof task.createdAt === "number"
  );
}

/**
 * Parse stored JSON, dropping malformed entries and revalidating kind icons
 * (a Lucide rename falls back to the default kind rather than vanishing).
 */
export function sanitizeTasks(
  value: unknown,
  isKnownIcon: (name: string) => boolean,
): Task[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tasks: Task[] = [];
  for (const entry of value) {
    if (!isTaskValue(entry) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    tasks.push({
      ...entry,
      title: entry.title.slice(0, 200),
      icon:
        isKindIcon(entry.icon) && isKnownIcon(entry.icon)
          ? entry.icon
          : DEFAULT_KIND,
    });
  }
  return tasks;
}

export function loadTasks(
  storage: TaskStorage | null | undefined,
  isKnownIcon: (name: string) => boolean,
): Task[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(TASKS_KEY);
    if (raw === null) return [];
    return sanitizeTasks(JSON.parse(raw), isKnownIcon);
  } catch {
    return [];
  }
}

export function saveTasks(
  storage: TaskStorage | null | undefined,
  tasks: readonly Task[],
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(TASKS_KEY, JSON.stringify(tasks));
    return true;
  } catch {
    return false;
  }
}
