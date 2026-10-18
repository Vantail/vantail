/**
 * Tasks example tests: pure task logic in `src/tasks.ts`.
 *
 * Dependency-free, so these run with plain `node --test` — no bundler, no
 * DOM, no network. Run from the example directory:
 *
 * ```sh
 * node --test test/tasks.test.js
 * ```
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clearDone,
  countTasks,
  createTask,
  DEFAULT_KIND,
  isKindIcon,
  KIND_ICONS,
  loadTasks,
  normalizeQuery,
  removeTask,
  saveTasks,
  sanitizeTasks,
  taskListText,
  TASKS_KEY,
  toggleDone,
  toggleStar,
  visibleTasks,
} from "../src/tasks.ts";

const KNOWN = new Set(["briefcase", "heart", "phone"]);
const isKnown = (name) => KNOWN.has(name);

function task(overrides = {}) {
  return {
    id: "a",
    title: "Buy milk",
    done: false,
    starred: false,
    icon: "briefcase",
    createdAt: 1,
    ...overrides,
  };
}

function memoryStorage(entries = {}) {
  const store = new Map(Object.entries(entries));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => void store.set(key, value),
  };
}

describe("creation", () => {
  it("trims titles and rejects blanks", () => {
    assert.equal(createTask("id", "  Buy milk  ", "heart", 7)?.title, "Buy milk");
    assert.equal(createTask("id", "   ", "heart", 7), null);
  });

  it("falls back to the default kind for unknown kinds", () => {
    assert.equal(createTask("id", "x", "not-an-icon", 1)?.icon, DEFAULT_KIND);
    assert.equal(createTask("id", "x", "heart", 1)?.icon, "heart");
  });

  it("exposes a curated, non-empty kind set", () => {
    assert.ok(KIND_ICONS.length > 0);
    assert.equal(new Set(KIND_ICONS).size, KIND_ICONS.length);
    assert.ok(isKindIcon(DEFAULT_KIND));
  });
});

describe("updates", () => {
  const tasks = [task({ id: "a" }), task({ id: "b", done: true, starred: true })];

  it("toggles done and starred without touching siblings", () => {
    const done = toggleDone(tasks, "a");
    assert.equal(done[0].done, true);
    assert.equal(done[1].done, true);
    const starred = toggleStar(tasks, "a");
    assert.equal(starred[0].starred, true);
    assert.equal(starred[1].starred, true);
  });

  it("removes one task and clears only finished ones", () => {
    assert.deepEqual(removeTask(tasks, "a").map((t) => t.id), ["b"]);
    assert.deepEqual(clearDone(tasks).map((t) => t.id), ["a"]);
  });
});

describe("views", () => {
  const tasks = [
    task({ id: "a", title: "Buy milk", starred: true }),
    task({ id: "b", title: "File report", done: true }),
    task({ id: "c", title: "Buy stamps" }),
  ];

  it("filters by view and searches case-insensitively", () => {
    assert.deepEqual(visibleTasks(tasks, "all", "").map((t) => t.id), ["a", "b", "c"]);
    assert.deepEqual(visibleTasks(tasks, "starred", "").map((t) => t.id), ["a"]);
    assert.deepEqual(visibleTasks(tasks, "done", "").map((t) => t.id), ["b"]);
    assert.deepEqual(visibleTasks(tasks, "all", "BUY").map((t) => t.id), ["a", "c"]);
    assert.deepEqual(visibleTasks(tasks, "done", "buy"), []);
  });

  it("counts views for the sidebar", () => {
    assert.deepEqual(countTasks(tasks), { all: 3, starred: 1, done: 1, active: 2 });
  });

  it("normalizes search queries", () => {
    assert.equal(normalizeQuery("  Milk "), "milk");
  });
});

describe("copy text", () => {
  it("renders checkboxes and stars as plain text", () => {
    assert.equal(
      taskListText([task({ title: "Buy milk" }), task({ title: "Done", done: true, starred: true })]),
      "[ ] Buy milk\n[x] * Done",
    );
    assert.equal(taskListText([]), "No tasks.");
  });
});

describe("persistence", () => {
  it("round-trips tasks through storage", () => {
    const storage = memoryStorage();
    const tasks = [task({ id: "a" }), task({ id: "b", icon: "heart" })];
    assert.equal(saveTasks(storage, tasks), true);
    assert.deepEqual(loadTasks(storage, isKnown), tasks);
  });

  it("drops malformed and duplicate entries, repairs unknown kinds", () => {
    const storage = memoryStorage({
      [TASKS_KEY]: JSON.stringify([
        task({ id: "a", icon: "shopping-cart" }),
        task({ id: "a" }),
        { id: "b" },
        null,
        "nope",
      ]),
    });
    assert.deepEqual(loadTasks(storage, isKnown), [
      task({ id: "a", icon: DEFAULT_KIND }),
    ]);
  });

  it("treats missing, corrupt, or throwing storage as empty", () => {
    assert.deepEqual(loadTasks(undefined, isKnown), []);
    assert.deepEqual(
      loadTasks(memoryStorage({ [TASKS_KEY]: "{nope" }), isKnown),
      [],
    );
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    assert.deepEqual(loadTasks(throwing, isKnown), []);
    assert.equal(saveTasks(throwing, []), false);
  });

  it("sanitizes non-array payloads", () => {
    assert.deepEqual(sanitizeTasks({}, isKnown), []);
    assert.deepEqual(sanitizeTasks("x", isKnown), []);
  });
});
