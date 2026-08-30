/** Sample content, so the layout has something the right shape to hold. */

export interface Message {
  from: string;
  at: string;
  body: string;
}

export interface Thread {
  id: string;
  title: string;
  preview: string;
  at: string;
  unread: number;
  section: "Inbox" | "Following";
  messages: Message[];
}

export const THREADS: Thread[] = [
  {
    id: "traffic-lights",
    title: "Traffic lights in a 52px bar",
    preview: "AppKit re-places them on every relayout, so...",
    at: "09:14",
    unread: 2,
    section: "Inbox",
    messages: [
      {
        from: "Ines",
        at: "09:02",
        body: "A taller bar leaves the window buttons sitting near the top rather than centred. Is that us or the platform?",
      },
      {
        from: "Rune",
        at: "09:11",
        body: "The platform. macOS puts them 9pt from the top of the window and re-places them on every relayout, so anything you set during layout is discarded.",
      },
      {
        from: "Ines",
        at: "09:14",
        body: "Then `buttonTop` is the number to line a row up with, not half the bar height. Good - that is what the metrics already report.",
      },
    ],
  },
  {
    id: "sidebar-inset",
    title: "Who owns insetLeft?",
    preview: "Whichever column is under the buttons, not...",
    at: "Yesterday",
    unread: 0,
    section: "Inbox",
    messages: [
      {
        from: "Rune",
        at: "16:40",
        body: "The sidebar reserves `insetLeft` while it is open. Collapse it and the content column is under the buttons instead, so the padding has to move with it.",
      },
      {
        from: "Ines",
        at: "16:52",
        body: "Which is the whole argument for reading it rather than hard-coding 78px: the same layout is then correct on Windows, where it is zero.",
      },
    ],
  },
  {
    id: "resize-divider",
    title: "Divider drag vs window drag",
    preview: "Both start on pointerdown in the same strip",
    at: "Yesterday",
    unread: 0,
    section: "Inbox",
    messages: [
      {
        from: "Ines",
        at: "11:20",
        body: "Dragging the divider inside the title bar band moved the whole window. Both handlers fire on pointerdown in the same strip.",
      },
      {
        from: "Rune",
        at: "11:26",
        body: "The divider is a child of the root laid over the boundary, not of either column, so a pointer landing on it never reaches the headers that start the drag. Structure decides which gesture wins, rather than a coordinate check.",
      },
    ],
  },
  {
    id: "windows-controls",
    title: "Drawing our own controls",
    preview: "insetLeft is 0 where the platform drew none",
    at: "Tuesday",
    unread: 1,
    section: "Following",
    messages: [
      {
        from: "Rune",
        at: "14:05",
        body: "Where the platform reserved no room it drew no buttons either, so we draw them. Measuring is a better test than checking the platform's name - it stays right if a platform changes its mind.",
      },
    ],
  },
  {
    id: "background-colour",
    title: "The pale gap on fast resize",
    preview: "backgroundColor matched to the sidebar",
    at: "Monday",
    unread: 0,
    section: "Following",
    messages: [
      {
        from: "Ines",
        at: "08:30",
        body: "Resizing quickly showed a light strip down the side before the page caught up. Setting the window's `backgroundColor` to the sidebar's colour hides it.",
      },
    ],
  },
];

export const SECTIONS = ["Inbox", "Following"] as const;
