/**
 * Inline SVG, because a title bar's icons are in the first frame the window
 * paints. An icon font or a sprite sheet arrives a request later, and you can
 * watch the bar reflow when it does.
 */

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const Grid = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <g fill="currentColor">
      <rect x="2" y="2" width="5" height="5" rx="1.4" />
      <rect x="9" y="2" width="5" height="5" rx="1.4" />
      <rect x="2" y="9" width="5" height="5" rx="1.4" />
      <rect x="9" y="9" width="5" height="5" rx="1.4" />
    </g>
  </svg>
);

export const Chevron = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="chevron">
    <path {...stroke} d="M4 6.5l4 4 4-4" />
  </svg>
);

export const Search = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <circle {...stroke} cx="7.2" cy="7.2" r="4.3" />
    <path {...stroke} d="M10.4 10.4L13.5 13.5" />
  </svg>
);

export const Bell = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path {...stroke} d="M4 6.6a4 4 0 018 0c0 3 1 3.6 1 3.6H3s1-.6 1-3.6z" />
    <path {...stroke} d="M6.6 12.4a1.6 1.6 0 002.8 0" />
  </svg>
);

export const Help = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <circle {...stroke} cx="8" cy="8" r="5.8" />
    <path {...stroke} d="M6.5 6.3a1.6 1.6 0 113 .8c-.5.5-1 .8-1 1.6" />
    <circle cx="8.5" cy="11.1" r="0.75" fill="currentColor" />
  </svg>
);

export const Doc = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path {...stroke} d="M4 2.2h5l3 3v8.6H4z" />
    <path {...stroke} d="M9 2.2v3h3" />
  </svg>
);

export const Close = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path {...stroke} d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
  </svg>
);

export const Plus = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path {...stroke} strokeWidth={1.9} d="M8 3.6v8.8M3.6 8h8.8" />
  </svg>
);

export const Share = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <circle {...stroke} cx="6.2" cy="5.4" r="2.6" />
    <path {...stroke} d="M1.9 13.4c0-2.4 1.9-3.9 4.3-3.9 1 0 1.9.3 2.6.7" />
    <path {...stroke} d="M12.4 8.2v4.2M10.3 10.3h4.2" />
  </svg>
);

export const Comment = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path {...stroke} d="M13.4 9.6a1.6 1.6 0 01-1.6 1.6H6l-3.4 2.4V4a1.6 1.6 0 011.6-1.6h7.6A1.6 1.6 0 0113.4 4z" />
  </svg>
);

export const History = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <circle {...stroke} cx="8" cy="8" r="5.8" />
    <path {...stroke} d="M8 4.6V8l2.4 1.6" />
  </svg>
);

/**
 * The caption buttons Windows and most Linux desktops draw: thin, square, and
 * on the trailing edge. Not used on macOS, where the platform's own are still
 * there - see `App.tsx`.
 */
export const Minimise = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <path stroke="currentColor" strokeWidth={1} d="M2.5 6.5h7" />
  </svg>
);

export const Maximise = ({ restored }: { restored?: boolean }) =>
  restored ? (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth={1} d="M3.5 4.5h5v5h-5z" />
      <path fill="none" stroke="currentColor" strokeWidth={1} d="M5 3.5h4v4" />
    </svg>
  ) : (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth={1} d="M2.8 2.8h6.4v6.4H2.8z" />
    </svg>
  );

export const Dismiss = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <path stroke="currentColor" strokeWidth={1} d="M2.8 2.8l6.4 6.4M9.2 2.8L2.8 9.2" />
  </svg>
);
