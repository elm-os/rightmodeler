// Progressive edge blur (Rauno technique, adapted): a stack of backdrop-blur layers, each
// masked to a progressive band so the blur intensifies toward one edge. Used to melt the
// approval-table's bottom edge and the footer gradient's top edge into the parchment.
// Purely decorative; blur stays well under 20px (cheap in Safari).

export function ProgressiveBlur({
  className,
  side = "bottom",
  height = "6rem",
  layers = 5,
  maxBlur = 3,
}: {
  className?: string;
  side?: "top" | "bottom";
  height?: string;
  layers?: number;
  maxBlur?: number;
}) {
  const isBottom = side === "bottom";
  const dir = isBottom ? "to top" : "to bottom";
  return (
    <div
      aria-hidden
      className={className}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        [isBottom ? "bottom" : "top"]: 0,
        height,
        pointerEvents: "none",
      }}
    >
      {Array.from({ length: layers }).map((_, i) => {
        const blur = ((i + 1) / layers) * maxBlur;
        const start = (i / layers) * 100;
        const end = ((i + 1.5) / layers) * 100;
        const mask = `linear-gradient(${dir}, rgba(0,0,0,1) ${start}%, rgba(0,0,0,0) ${end}%)`;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              inset: 0,
              backdropFilter: `blur(${blur}px)`,
              WebkitBackdropFilter: `blur(${blur}px)`,
              maskImage: mask,
              WebkitMaskImage: mask,
            }}
          />
        );
      })}
    </div>
  );
}
