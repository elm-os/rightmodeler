"use client";

// The home hero: editorial copy over a per-step approval ledger. Every figure is illustrative.

import { motion, useReducedMotion } from "motion/react";
import { AnimatedNumber } from "@/components/animated-number";
import { CopyCommand } from "@/components/copy-command";
import { HeroGradient } from "@/components/hero-gradient";
import { ArrowRightIcon, GitHubIcon } from "@/components/icons";
import { ProgressiveBlur } from "@/components/progressive-blur";
import { Reveal } from "@/components/reveal";
import { ILLUSTRATIVE_SCORECARD } from "@/lib/product-facts";
import { REPO_URL, RUN_COMMAND } from "@/lib/site";

// Strong ease-out curve (docs/design.md § Motion) as a motion-friendly tuple.
const EASE: [number, number, number, number] = [0.23, 1, 0.32, 1];

// Fixed geometry: the caret aligns to rows by arithmetic, so rows must never wrap.
const ROW_H = 44; // px
const CARET_H = 20; // px
const CARET_TOP = (ROW_H - CARET_H) / 2;
const GRID = "14px 40px 30px 132px 244px 54px 58px 132px 156px"; // caret · status · Step · Family · Current → Candidate · Save · Quality · Evidence · Flag

type Flag = { label: string; strong?: boolean } | null;

type LedgerRow = {
  key: string;
  glyph: string; // ✓ ⚙ ✕
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
  dim?: boolean; // the abstain row: fog, with its verdict in ink
};

// Row 2 is below the quality floor in the title bar, hence pending. Row 5 is the abstention.
const ROWS: LedgerRow[] = [
  {
    key: "pr_summary",
    glyph: "✓",
    status: "approved",
    srStatus: "Approved",
    step: "1",
    family: "pr_summary",
    from: "gpt-5.6",
    to: "gpt-5.4",
    save: "72%",
    quality: ILLUSTRATIVE_SCORECARD.approved,
    evidence: "reference+judge",
    flag: null,
  },
  {
    key: "tool_agent",
    glyph: "⚙",
    status: "pending",
    srStatus: "Pending, cascade risk",
    step: "2",
    family: "tool_agent",
    from: "claude-opus-5",
    to: "llama-3.3-70b",
    save: "41%",
    quality: ILLUSTRATIVE_SCORECARD.pending,
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
    from: "gpt-5.4",
    to: "qwen3.7-flash",
    save: "68%",
    quality: ILLUSTRATIVE_SCORECARD.deterministic,
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
    from: "gpt-5.4",
    to: "deepseek-chat",
    save: "55%",
    quality: ILLUSTRATIVE_SCORECARD.alternative,
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
    from: "gpt-5.6",
    to: "·",
    save: "·",
    quality: "·",
    evidence: "none",
    flag: { label: "NO EVIDENCE · abstain", strong: true },
    dim: true,
  },
];

// Caret rest points, one per row, measured from the top of the rows track.
const STOPS = ROWS.map((_, i) => i * ROW_H + CARET_TOP);

export function Hero() {
  return (
    <section className="bg-parchment-white">
      <div className="relative isolate overflow-hidden">
        {/* The two accent hues live only in here. */}
        <HeroGradient className="absolute inset-0 -z-10" />
        {/* Legibility veil: parchment densest behind the top-left copy, fading into the gradient. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            background:
              "radial-gradient(130% 115% at 24% 30%, rgba(253,252,252,0.82) 0%, rgba(253,252,252,0.34) 46%, rgba(253,252,252,0) 74%)",
          }}
        />

        <div className="mx-auto max-w-5xl px-6 py-20 sm:px-8 sm:py-28">
          <Reveal lcp className="relative max-w-3xl">
            <div className="relative">
              <p className="font-mono text-caption text-fog uppercase">
                Evidence-backed model decisions
              </p>

              <h1 className="mt-5 font-display text-heading-lg text-balance text-midnight-ink sm:text-display">
                Measure cheaper models against what you shipped.
              </h1>

              <p className="mt-6 max-w-2xl text-subheading text-driftwood">
                rightmodeler replays your real agent traces through cheaper
                models, judges each output against what you already shipped, and
                reports agreement, cost, evidence, sample size, and every
                abstention.
              </p>

              {/* The caption names "PR summary" so the figure reads against Row 1 of the ledger. */}
              <div className="mt-9">
                <AnimatedNumber
                  value={72}
                  suffix="%"
                  className="font-display text-heading text-midnight-ink sm:text-heading-lg"
                />
                <p className="mt-1.5 font-mono text-caption text-fog">
                  cost reduction · PR summary · medium confidence · illustrative
                  example
                </p>
              </div>

              <div className="mt-8 flex flex-col items-start gap-5 sm:flex-row sm:items-center">
                <CopyCommand command={RUN_COMMAND} />
                <a
                  href={REPO_URL}
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

          <div className="mt-14 sm:mt-16">
            <div className="mb-3 flex justify-end">
              <span className="font-mono text-caption text-fog">
                {ILLUSTRATIVE_SCORECARD.label}, not measured results
              </span>
            </div>
            <ApprovalTable />
          </div>
        </div>
      </div>
    </section>
  );
}

// The CLI's per-step swap plan as a still artifact: nothing here is a live measurement.
function ApprovalTable() {
  const reduce = useReducedMotion();

  return (
    <div className="relative overflow-hidden rounded-xl border border-ash-border bg-warm-sand">
      {/* The quality floor on the right is why Row 2 is held rather than approved. */}
      <div className="flex items-center justify-between gap-4 border-b border-ash-border px-4 py-3">
        <span className="min-w-0 truncate font-mono text-caption text-driftwood">
          rightmodeler · per-step approval
        </span>
        <span className="shrink-0 font-mono text-caption text-fog">
          5 steps · quality floor {ILLUSTRATIVE_SCORECARD.floor}
        </span>
      </div>

      {/* < sm: the same five steps as stacked cards, so nothing scrolls sideways. */}
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
              data-reveal
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
              {/* Stands in for the desktop caret. */}
              {row.dim && (
                <span
                  aria-hidden
                  className="absolute top-1/2 left-0 h-5 w-[3px] -translate-y-1/2 rounded-r-[1px] bg-midnight-ink"
                />
              )}

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

              <div className="mt-1.5 font-mono text-[13px]">
                <span className={row.dim ? "text-fog" : "text-midnight-ink"}>
                  {row.from}
                </span>
                <span className="text-fog"> → </span>
                <span className={row.dim ? "text-fog" : "text-midnight-ink"}>
                  {row.to}
                </span>
              </div>

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

      {/* >= sm: the grid scrolls inside this lane, so the page itself never scrolls sideways. */}
      <div className="hidden overflow-x-auto sm:block">
        <div className="w-max px-4">
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

          {/* relative: positions the caret */}
          <div className="relative" style={{ height: ROWS.length * ROW_H }}>
            {ROWS.map((row, i) => (
              <motion.div
                key={row.key}
                data-reveal
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
                {/* caret gutter */}
                <span aria-hidden />

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

            {/* Reading-head caret. Under reduced motion it starts at rest on Row 5. */}
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

          {/* Room for the bottom ProgressiveBlur, so it never touches the abstain row. */}
          <div aria-hidden style={{ height: 64 }} />
        </div>
      </div>

      {/* Desktop only: the stacked cards end on the abstain row, which must never be blurred. */}
      <ProgressiveBlur
        side="bottom"
        height="3.5rem"
        maxBlur={3}
        className="hidden sm:block"
      />
    </div>
  );
}

// Monochrome hairline tags, never colour-coded. The abstain verdict is ink: a stop, not a gap.
function FlagCell({ flag }: { flag: Flag }) {
  if (!flag) {
    return <span className="text-[13px] text-fog">·</span>;
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
