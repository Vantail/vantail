/**
 * The glyphs the bar needs, as inline SVG.
 *
 * Drawn here rather than pulled from an icon package: six shapes is not worth
 * a dependency, and an example that installs one is an example that stops
 * building the day it changes its exports.
 */

type Props = { className?: string };

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function ChevronLeft(props: Props) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...props}>
      <path d="M15 5 8 12l7 7" {...stroke} />
    </svg>
  );
}

export function ChevronRight(props: Props) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...props}>
      <path d="m9 5 7 7-7 7" {...stroke} />
    </svg>
  );
}

export function Home(props: Props) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...props}>
      <path
        d="M12 3.2 3.5 10v10.3h5.8v-5.6h5.4v5.6h5.8V10Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function Search(props: Props) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...props}>
      <circle cx="10.5" cy="10.5" r="6.5" {...stroke} />
      <path d="m15.5 15.5 4.5 4.5" {...stroke} />
    </svg>
  );
}

/** The "browse everything" grid on the right of the search field. */
export function Browse(props: Props) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...props}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2.4" {...stroke} />
      <path d="M3.5 9.2h17" {...stroke} />
      <path d="M9.2 9.2v11.3" {...stroke} />
    </svg>
  );
}

export function Bell(props: Props) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...props}>
      <path
        d="M18 16.5V11a6 6 0 1 0-12 0v5.5L4.5 18.5h15Z"
        {...stroke}
      />
      <path d="M10 21.2h4" {...stroke} />
    </svg>
  );
}

export function Friends(props: Props) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...props}>
      <circle cx="9" cy="8.5" r="3.4" {...stroke} />
      <path d="M3.4 19.5c0-3.1 2.5-5.2 5.6-5.2s5.6 2.1 5.6 5.2" {...stroke} />
      <path d="M16 5.6a3.4 3.4 0 0 1 0 6.6" {...stroke} />
      <path d="M17.4 14.6c2.1.5 3.6 2.2 3.6 4.4" {...stroke} />
    </svg>
  );
}

/** The arrow that marks a menu item as leaving the app. */
export function External(props: Props) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...props}>
      <path d="M14 4.8h5.2V10" {...stroke} />
      <path d="M19.2 4.8 11.5 12.5" {...stroke} />
      <path d="M18 14.4v4.8H4.8V6h4.8" {...stroke} />
    </svg>
  );
}

export function Check(props: Props) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...props}>
      <path d="m4.5 12.5 5 5 10-11" {...stroke} strokeWidth={2.2} />
    </svg>
  );
}
