/**
 * The glyphs this window needs, as inline SVG.
 *
 * Drawn here rather than pulled from an icon package: a handful of shapes is
 * not worth a dependency, and an example that installs one is an example that
 * stops building the day that package changes its exports.
 */

type Props = { className?: string };

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function Close(props: Props) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...props}>
      <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" {...stroke} />
    </svg>
  );
}

export function Plus(props: Props) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...props}>
      <path d="M12 5.5v13M5.5 12h13" {...stroke} />
    </svg>
  );
}
