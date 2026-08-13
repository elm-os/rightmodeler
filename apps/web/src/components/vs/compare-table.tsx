// Side-by-side dimension ledger — the integrations reads-card grammar (warm-sand framed window,
// mono rows on hairlines) widened to three columns: the dimension, their answer, ours. Desktop is
// a fixed grid with mono caption headers; mobile stacks each row into label-over-values so nothing
// scrolls sideways. The rightmodeler column carries the ink, matching the split-columns emphasis.
// Server component, no motion: the ledger is data, not theater.

export type CompareRow = { dimension: string; theirs: string; ours: string };

export function CompareTable({
  caption,
  leftLabel,
  rightLabel,
  rows,
}: {
  caption?: string;
  leftLabel: string;
  rightLabel: string;
  rows: CompareRow[];
}) {
  return (
    <div className="rounded-xl border border-ash-border bg-warm-sand">
      {caption && (
        <div className="border-b border-ash-border px-4 py-2.5">
          <span className="font-mono text-caption text-driftwood">
            {caption}
          </span>
        </div>
      )}
      {/* Desktop column headers; the stacked mobile rows carry inline labels instead. */}
      <div className="hidden border-b border-ash-border px-4 py-2.5 sm:grid sm:grid-cols-[minmax(0,9rem)_1fr_1fr] sm:gap-4">
        <span />
        <span className="font-mono text-caption text-fog">{leftLabel}</span>
        <span className="font-mono text-caption text-fog">{rightLabel}</span>
      </div>
      <div className="divide-y divide-ash-border">
        {rows.map((row) => (
          <div
            key={row.dimension}
            className="px-4 py-2.5 font-mono text-[12px] sm:grid sm:grid-cols-[minmax(0,9rem)_1fr_1fr] sm:gap-4"
          >
            <div className="text-driftwood">{row.dimension}</div>
            <div className="mt-1 text-driftwood sm:mt-0">
              <span className="text-fog sm:hidden">{leftLabel} · </span>
              {row.theirs}
            </div>
            <div className="mt-1 text-midnight-ink sm:mt-0">
              <span className="text-fog sm:hidden">{rightLabel} · </span>
              {row.ours}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
