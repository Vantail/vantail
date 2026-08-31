/** The open documents. Nothing here is persisted; it is a layout example. */

export interface Tab {
  id: number;
  title: string;
}

export const FIRST: Tab[] = [{ id: 1, title: "Design System" }];

const NAMES = [
  "Untitled",
  "Roadmap",
  "Release Notes",
  "Brand Kit",
  "Q3 Planning",
  "Onboarding",
];

let next = FIRST.length + 1;

export function newTab(): Tab {
  const id = next++;
  return { id, title: NAMES[(id - 2) % NAMES.length] ?? "Untitled" };
}
