"use client";

// The hero — a thesis, not a claim. The most characteristic artifact in rightmodeler's world is
// the per-step approval TUI where a human ratifies each downgrade against evidence, so THAT is the
// hero: a faithful, monochrome `cheaper-models · per-step approval` ledger on an opaque warm-sand
// window, with the HeroGradient reduced to paper matting in the gutters. One bold move only — an
// ink "reading head" caret that walks the pipeline as the ledger fills and comes to rest on the
// abstain row (Step 5), making the product's most honest behaviour ("it tells you when NOT to
// switch") kinetic. Everything else stays quiet: left-aligned editorial copy on a feathered
// parchment scrim, a labelled + hedged proof number that rhymes to Row 1, a copy-able command.
// Every figure is stamped illustrative; the UI is strictly black-on-paper (accent hues live only
// inside HeroGradient). Row entrances and the caret honour prefers-reduced-motion.

import { motion, useReducedMotion } from "motion/react";
import { HeroGradient } from "../HeroGradient";
import { CopyCommand } from "../CopyCommand";
import { AnimatedNumber } from "../AnimatedNumber";
import { Reveal } from "../Reveal";
import { ProgressiveBlur } from "../ProgressiveBlur";
import { GitHubIcon, ArrowRightIcon } from "../icons";

// Strong ease-out curve (docs/design.md § Motion) as a motion-friendly tuple.
const EASE: [number, number, number, number] = [0.23, 1, 0.32, 1];

// Fixed ledger geometry so the reading-head caret aligns to each row deterministically (rows never
// wrap — they live in an overflow-x-auto lane and keep a single mono line).
const ROW_H = 44; // px, uniform data-row height
const CARET_H = 20; // px, slightly shorter than the row
const CARET_TOP = (ROW_H - CARET_H) / 2; // vertical centring inside a row
const GRID = "14px 40px 30px 132px 244px 54px 58px 132px 156px"; // caret · status · Step · Family · Current → Candidate · Save · Quality · Evidence · Flag

type Flag = { label: string; strong?: boolean } | null;

type LedgerRow = {
  key: string;
  glyph: string; // ✓ ⚙ ✕ — real Textual status glyphs, monochrome
  status: "approved" | "pending" | "abstained";
  srStatus: string; // spoken status (glyph alone is not accessible)
  step: string;
  family: string;
  from: string;
  to: string;
  save: string;
  quality: string;
  evidence: string;
  flag: Flag;
  dim?: boolean; // the abstain row is de-emphasised to fog; its verdict stays ink
};

// The exact five illustrative rows from the brief. Row 2 sits at quality 0.88 — below the 0.90
// floor stated in the title bar — which is why it is still ⚙ pending with a CASCADE hold rather
// than an auto-✓. Row 5 is the pratfall/trust payoff: the tool declining to gamble.
const ROWS: LedgerRow[] = [
  {
    key: "pr_summary",
    glyph: "✓",
    status: "approved",
    srStatus: "Approved",
    step: "1",
    family: "pr_summary",
    from: "gpt-4.1",
    to: "gpt-4o-mini",
    save: "72%",
    quality: "0.94",
    evidence: "reference+judge",
    flag: null,
  },
  {
    key: "tool_agent",
    glyph: "⚙",
    status: "pending",
    srStatus: "Pending — cascade risk",
    step: "2",
    family: "tool_agent",
    from: "claude-opus-4",
    to: "llama-3.3-70b",
    save: "41%",
    quality: "0.88",
    evidence: "trajectory",
    flag: { label: "CASCADE" },
  },
  {
    key: "json_extraction",
    glyph: "✓",
    status: "approved",
    srStatus: "Approved",
    step: "3",
    family: "json_extraction",
    from: "gpt-4o",
    to: "gpt-4o-mini",
    save: "68%",
    quality: "1.00",
    evidence: "deterministic",
    flag: null,
  },
  {
    key: "sql_generation",
    glyph: "✓",
    status: "approved",
    srStatus: "Approved",
    step: "4",
    family: "sql_generation",
    from: "gpt-4o",
    to: "deepseek-chat",
    save: "55%",
    quality: "0.91",
    evidence: "reference",
    flag: null,
  },
  {
    key: "auth_code_edit",
    glyph: "✕",
    status: "abstained",
    srStatus: "Abstained",
    step: "5",
    family: "auth_code_edit",
    from: "gpt-4.1",
    to: "—",
    save: "—",
    quality: "—",
    evidence: "none",
    flag: { label: "HIGH-RISK · abstain", strong: true },
    dim: true,
  },
];

// Caret rest points, one per row, measured from the top of the rows track.
const STOPS = ROWS.map((_, i) => i * ROW_H + CARET_TOP);

export function Hero() {
  return (
    <section className="bg-parchment-white">
      <div className="relative isolate overflow-hidden">
        {/* Grain-gradient backdrop spans the full framed column, edge to edge — reaching the
            frame's side rules with no inner boundary. The two accent hues live only in here. */}
        <HeroGradient className="absolute inset-0 -z-10" />
        {/* Legibility veil — a parchment wash densest behind the top-left copy, fading into the
            vivid gradient toward the bottom-right. Edge-to-edge, no box, so it never reads as an
            inner panel. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            background:
              "radial-gradient(130% 115% at 24% 30%, rgba(253,252,252,0.82) 0%, rgba(253,252,252,0.34) 46%, rgba(253,252,252,0) 74%)",
          }}
        />

        <div className="mx-auto max-w-5xl px-6 py-20 sm:px-8 sm:py-28">
          {/* ── Copy column: left-aligned editorial argument on a feathered parchment scrim ── */}
          <Reveal className="relative max-w-3xl">
            <div className="relative">
              <p className="font-mono text-caption text-fog uppercase">
                Evidence-backed model downgrades
              </p>

              <h1 className="mt-5 font-display text-heading-lg text-balance text-midnight-ink sm:text-display">
                Prove which models you can safely downgrade.
              </h1>

              <p className="mt-6 max-w-2xl text-subheading text-driftwood">
                rightmodeler replays your real agent traces through cheaper
                models, judges each output against what you already shipped, and
                shows exactly where you can cut cost — with evidence and
                confidence on every call.
              </p>

              {/* Labelled proof number. Not boxed (the ledger is the only framed artifact) and
                deliberately hedged — its caption reads "PR summary", so it rhymes straight to
                Row 1 of the ledger below rather than floating free as a lone hero stat. */}
              <div className="mt-9">
                <AnimatedNumber
                  value={72}
                  suffix="%"
                  className="font-display text-heading text-midnight-ink sm:text-heading-lg"
                />
                <p className="mt-1.5 font-mono text-caption text-fog">
                  cost reduction · PR summary · medium confidence — illustrative
                  example
                </p>
              </div>

              {/* CTA row — the trivial first step (a copy-able command) plus a quiet repo link. */}
              <div className="mt-8 flex flex-col items-start gap-5 sm:flex-row sm:items-center">
                <CopyCommand command="uv run python -m pipeline ingest" />
                <a
                  href="https://github.com/elm-os/rightmodeler"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="group inline-flex items-center gap-2 rounded text-body text-driftwood transition-colors duration-150 hover:text-midnight-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white"
                >
                  <GitHubIcon />
                  <span>View on GitHub</span>
                  <ArrowRightIcon className="transition-transform duration-150 ease-out [@media(hover:hover)_and_(pointer:fine)]:group-hover:translate-x-0.5" />
                </a>
              </div>
            </div>
          </Reveal>

          {/* ── The star artifact: the per-step approval ledger, wider than the copy measure ── */}
          <div className="mt-14 sm:mt-16">
            <div className="mb-3 flex justify-end">
              <span className="font-mono text-caption text-fog">
                Illustrative — not measured results
              </span>
            </div>
            <ApprovalTable />
          </div>
        </div>
      </div>
    </section>
  );
}

// ── ApprovalTable ─────────────────────────────────────────────────────────────────────────────
// A faithful HTML/CSS re-creation of the real Textual TUI: opaque warm-sand window, ash-border
// hairlines, strict monochrome status glyphs (no traffic-light dots, no semantic hue). Rows
// stagger in on load (50ms) as the ledger populates; a single ink reading-head caret walks down
// the status gutter and rests on the abstain row. Nothing here fakes a live measurement — it is a
// still artifact with one explanatory entrance.
function ApprovalTable() {
  const reduce = useReducedMotion();

  return (
    <div className="relative overflow-hidden rounded-xl border border-ash-border bg-warm-sand">
      {/* Title bar — artifact name (left) and a real methodology fact (right): the default 0.90
          quality floor, which explains why Row 2 at 0.88 is held rather than approved. */}
      <div className="flex items-center justify-between gap-4 border-b border-ash-border px-4 py-3">
        <span className="min-w-0 truncate font-mono text-caption text-driftwood">
          cheaper-models · per-step approval
        </span>
        <span className="shrink-0 font-mono text-caption text-fog">
          5 steps · quality floor 0.90
        </span>
      </div>

      {/* ── Mobile ledger (< sm): the same five steps as stacked records, so nothing scrolls
          sideways on a phone. The wide TUI grid below is desktop-only; here each row carries the
          whole verdict — status, family, the model swap, and the numbers that back it — and the
          abstain row keeps its de-emphasis + emphasised flag so the "it declines to gamble"
          payoff still lands. A static ink marker stands in for the desktop reading-head caret. */}
      <div className="divide-y divide-ash-border sm:hidden">
        {ROWS.map((row, i) => {
          const glyphColor =
            row.status === "pending"
              ? "text-driftwood"
              : row.dim
                ? "text-fog"
                : "text-midnight-ink";
          return (
            <motion.div
              key={row.key}
              className="relative px-4 py-3.5"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
              whileInView={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{
                delay: reduce ? 0 : i * 0.05,
                duration: reduce ? 0.2 : 0.32,
                ease: EASE,
              }}
            >
              {/* Where the reading head rests on desktop — a still ink tick on the abstain row. */}
              {row.dim && (
                <span
                  aria-hidden
                  className="absolute top-1/2 left-0 h-5 w-[3px] -translate-y-1/2 rounded-r-[1px] bg-midnight-ink"
                />
              )}

              {/* Line 1 — status glyph + family, flag docked right (dropped when there is none). */}
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span
                    aria-hidden
                    className={`font-mono text-[13px] ${glyphColor}`}
                  >
                    {row.glyph}
                  </span>
                  <span className="sr-only">{row.srStatus}</span>
                  <span
                    className={`truncate font-mono text-[13px] ${row.dim ? "text-fog" : "text-midnight-ink"}`}
                  >
                    {row.family}
                  </span>
                </span>
                {row.flag && (
                  <span className="shrink-0">
                    <FlagCell flag={row.flag} />
                  </span>
                )}
              </div>

              {/* Line 2 — the candidate swap. */}
              <div className="mt-1.5 font-mono text-[13px]">
                <span className={row.dim ? "text-fog" : "text-midnight-ink"}>
                  {row.from}
                </span>
                <span className="text-fog"> → </span>
                <span className={row.dim ? "text-fog" : "text-midnight-ink"}>
                  {row.to}
                </span>
              </div>

              {/* Line 3 — the numbers behind the verdict, labelled in place of column headers. */}
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-caption text-fog">
                <span>
                  save{" "}
                  <span
                    className={`tabular-nums ${row.dim ? "text-fog" : "text-midnight-ink"}`}
                  >
                    {row.save}
                  </span>
                </span>
                <span>
                  quality{" "}
                  <span
                    className={`tabular-nums ${row.dim ? "text-fog" : "text-midnight-ink"}`}
                  >
                    {row.quality}
                  </span>
                </span>
                <span className="text-driftwood">{row.evidence}</span>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Horizontal scroll lane (>= sm): the mono grid keeps its columns and scrolls like a real
          wide TUI on tablet/desktop; the page body itself never scrolls sideways. */}
      <div className="hidden overflow-x-auto sm:block">
        <div className="w-max px-4">
          {/* Column headers */}
          <div
            className="grid h-9 items-center gap-x-3 border-b border-ash-border font-mono text-caption text-fog"
            style={{ gridTemplateColumns: GRID }}
          >
            <span aria-hidden />
            <span>status</span>
            <span>Step</span>
            <span>Family</span>
            <span>Current → Candidate</span>
            <span className="text-right">Save</span>
            <span className="text-right">Quality</span>
            <span>Evidence</span>
            <span>Flag</span>
          </div>

          {/* Rows track (relative) — hosts the absolutely-positioned reading-head caret. */}
          <div className="relative" style={{ height: ROWS.length * ROW_H }}>
            {ROWS.map((row, i) => (
              <motion.div
                key={row.key}
                className="grid items-center gap-x-3 border-b border-ash-border font-mono text-[13px]"
                style={{ gridTemplateColumns: GRID, height: ROW_H }}
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
                animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
                transition={{
                  delay: reduce ? 0 : 0.15 + i * 0.05,
                  duration: reduce ? 0.2 : 0.32,
                  ease: EASE,
                }}
              >
                {/* caret gutter (empty — the caret floats over it) */}
                <span aria-hidden />

                {/* status glyph + spoken label */}
                <span className="flex items-center justify-center">
                  <span
                    aria-hidden
                    className={
                      row.status === "pending"
                        ? "text-driftwood"
                        : row.dim
                          ? "text-fog"
                          : "text-midnight-ink"
                    }
                  >
                    {row.glyph}
                  </span>
                  <span className="sr-only">{row.srStatus}</span>
                </span>

                <span className={row.dim ? "text-fog" : "text-driftwood"}>
                  {row.step}
                </span>

                <span
                  className={`truncate ${row.dim ? "text-fog" : "text-midnight-ink"}`}
                >
                  {row.family}
                </span>

                <span className="truncate">
                  <span className={row.dim ? "text-fog" : "text-midnight-ink"}>
                    {row.from}
                  </span>
                  <span className="text-fog"> → </span>
                  <span className={row.dim ? "text-fog" : "text-midnight-ink"}>
                    {row.to}
                  </span>
                </span>

                <span
                  className={`text-right tabular-nums ${row.dim ? "text-fog" : "text-midnight-ink"}`}
                >
                  {row.save}
                </span>
                <span
                  className={`text-right tabular-nums ${row.dim ? "text-fog" : "text-midnight-ink"}`}
                >
                  {row.quality}
                </span>

                <span className="truncate text-driftwood">{row.evidence}</span>

                <span className="flex min-w-0 items-center">
                  <FlagCell flag={row.flag} />
                </span>
              </motion.div>
            ))}

            {/* Reading-head caret: an ink block that walks the ledger as it fills and settles on
                Row 5 (abstain). One-shot, GPU transform only; under reduced motion it is placed
                statically on Row 5 with zero travel so the meaning survives without movement. */}
            <motion.span
              aria-hidden
              className="pointer-events-none absolute left-1 z-10 w-[3px] rounded-[1px] bg-midnight-ink"
              style={{ top: 0, height: CARET_H }}
              initial={{ y: reduce ? STOPS[STOPS.length - 1] : STOPS[0] }}
              animate={{ y: reduce ? STOPS[STOPS.length - 1] : STOPS }}
              transition={
                reduce
                  ? { duration: 0 }
                  : {
                      delay: 0.22,
                      duration: 0.72,
                      times: [0, 0.25, 0.5, 0.75, 1],
                      ease: EASE,
                    }
              }
            />
          </div>

          {/* Empty tail — implies these five are a slice of a longer run, and gives the bottom
              ProgressiveBlur a region to soften without ever touching the abstain row. */}
          <div aria-hidden style={{ height: 64 }} />
        </div>
      </div>

      {/* Melt the window's lower edge into the parchment canvas (desktop lane only — on mobile the
          stacked cards end on the abstain row, which must never be blurred). maxBlur 3 (Safari-cheap). */}
      <ProgressiveBlur
        side="bottom"
        height="3.5rem"
        maxBlur={3}
        className="hidden sm:block"
      />
    </div>
  );
}

// Flags are monochrome hairline tags (never colour-coded pills). "—" is a quiet fog dash; the
// abstain verdict is emphasised to ink so the stop reads as intentional, not missing data.
function FlagCell({ flag }: { flag: Flag }) {
  if (!flag) {
    return <span className="text-[13px] text-fog">—</span>;
  }
  return (
    <span
      className={`inline-flex w-fit items-center rounded border border-ash-border px-1.5 py-0.5 font-mono text-caption ${
        flag.strong ? "font-medium text-midnight-ink" : "text-midnight-ink"
      }`}
    >
      {flag.label}
    </span>
  );
}
