"use client";

import Image from "next/image";
import { useId, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

const EASE_OUT_STRONG = [0.23, 1, 0.32, 1] as const;

type Feature = {
  title: string;
  caption: string;
  img: string;
};

type Slot =
  { kind: "card"; feature: Feature } | { kind: "tile"; align: "start" | "end" };

type TabDef = {
  id: string;
  label: string;
  columns: Slot[][];
};

const TRACES: Feature = {
  title: "Traces and sessions",
  caption:
    "Traces, spans, sessions and users, with a timeline, an agent graph and full-text search.",
  img: "/crucible/cost.jpg",
};
const COST: Feature = {
  title: "Cost and latency",
  caption:
    "The cost, tokens and latency of every trace and span, with p50 to p99 latency and dashboards to chart them.",
  img: "/crucible/speed.jpg",
};
const MCP: Feature = {
  title: "MCP servers",
  caption:
    "Every MCP call recorded with its method, tool, error class and latency, and linked to the agent's tool call through trace context.",
  img: "/crucible/failures.jpg",
};
const ALERTS: Feature = {
  title: "Alerts, SQL and exports",
  caption:
    "Alerts to Slack, email and signed webhooks, a read-only SQL workspace isolated by ClickHouse itself, and trace exports.",
  img: "/crucible/rightsized.jpg",
};
const INSTRUMENTATION: Feature = {
  title: "Instrumented your way",
  caption:
    "OpenTelemetry from any SDK or instrumentation library, Crucible's SDKs for TypeScript, Python, Go and Rust, or an MCP proxy that needs no code changes.",
  img: "/crucible/mcp.jpg",
};
const SELF_HOSTED: Feature = {
  title: "Yours to run",
  caption:
    "Self-hosted, with organizations, projects, roles and API keys, retention settings and deletion requests.",
  img: "/crucible/keys.jpg",
};

// [card, tile] facing [tile, card] is what staggers the wall; the second tab mirrors the first.
const TABS: TabDef[] = [
  {
    id: "show",
    label: "What it shows",
    columns: [
      [
        { kind: "card", feature: TRACES },
        { kind: "tile", align: "end" },
      ],
      [{ kind: "card", feature: COST }],
      [
        { kind: "tile", align: "start" },
        { kind: "card", feature: MCP },
      ],
    ],
  },
  {
    id: "run",
    label: "How it runs",
    columns: [
      [
        { kind: "tile", align: "end" },
        { kind: "card", feature: SELF_HOSTED },
      ],
      [{ kind: "card", feature: INSTRUMENTATION }],
      [
        { kind: "card", feature: ALERTS },
        { kind: "tile", align: "start" },
      ],
    ],
  },
];

function FeatureCard({ feature, tall }: { feature: Feature; tall: boolean }) {
  return (
    <div
      className={`relative isolate overflow-hidden rounded-2xl border border-ash-border bg-warm-sand ${
        tall ? "aspect-[15/16]" : "aspect-square"
      }`}
    >
      <Image
        src={feature.img}
        alt=""
        aria-hidden
        fill
        sizes={
          tall
            ? "(min-width: 1024px) 480px, 92vw"
            : "(min-width: 1024px) 320px, 92vw"
        }
        className="object-cover"
      />
      {/* Ink scrim so the parchment caption stays legible over the light editorial photos. */}
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-midnight-ink/60 via-midnight-ink/25 to-transparent"
      />
      <div className="absolute inset-x-0 bottom-0 p-5 sm:p-6">
        <p className="text-subheading font-medium text-parchment-white">
          {feature.title}
        </p>
        <p className="mt-1.5 max-w-sm text-body text-parchment-white/80">
          {feature.caption}
        </p>
      </div>
    </div>
  );
}

export function CrucibleShowcase() {
  const [active, setActive] = useState(TABS[0].id);
  const reduce = useReducedMotion();
  const baseId = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const tab = TABS.find((t) => t.id === active) ?? TABS[0];
  const tabId = (id: string) => `${baseId}-tab-${id}`;
  const panelId = `${baseId}-panel`;

  // Roving tabindex per the tabs pattern: arrows move selection and focus together.
  function onTablistKeyDown(e: React.KeyboardEvent) {
    const idx = TABS.findIndex((t) => t.id === active);
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (idx + 1) % TABS.length;
    else if (e.key === "ArrowLeft")
      next = (idx - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    setActive(TABS[next].id);
    tabRefs.current[next]?.focus();
  }

  const gridVariants = reduce
    ? {
        enter: { opacity: 0 },
        visible: {
          opacity: 1,
          transition: { duration: 0.2, ease: "easeOut" as const },
        },
        exit: {
          opacity: 0,
          transition: { duration: 0.12, ease: "easeOut" as const },
        },
      }
    : {
        enter: {},
        visible: { transition: { staggerChildren: 0.04, delayChildren: 0.05 } },
        exit: {
          opacity: 0,
          y: -6,
          transition: { duration: 0.18, ease: EASE_OUT_STRONG },
        },
      };
  const itemVariants = reduce
    ? undefined
    : {
        enter: { opacity: 0, y: 14, scale: 0.98 },
        visible: {
          opacity: 1,
          y: 0,
          scale: 1,
          transition: { duration: 0.26, ease: EASE_OUT_STRONG },
        },
      };

  return (
    <div>
      <h2 className="sr-only">What Crucible gives you</h2>

      <div className="flex justify-center">
        <div
          role="tablist"
          aria-label="Crucible feature groups"
          onKeyDown={onTablistKeyDown}
          className="inline-flex items-center rounded-full border border-ash-border bg-warm-sand p-1"
        >
          {TABS.map((t, i) => {
            const selected = t.id === active;
            return (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={tabId(t.id)}
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActive(t.id)}
                className={`relative rounded-full px-4 py-2 font-sans text-body transition-[color,transform] duration-150 ease-out active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-warm-sand ${
                  selected
                    ? "text-midnight-ink"
                    : "text-driftwood [@media(hover:hover)_and_(pointer:fine)]:hover:text-midnight-ink"
                }`}
              >
                {selected && (
                  <motion.span
                    layoutId={`${baseId}-thumb`}
                    aria-hidden
                    className="absolute inset-0 rounded-full border border-ash-border bg-parchment-white"
                    transition={
                      reduce
                        ? { duration: 0 }
                        : { type: "spring", duration: 0.3, bounce: 0.15 }
                    }
                  />
                )}
                <span className="relative">{t.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* The persistent tabpanel is the positioned ancestor popLayout pins the exiting grid to. */}
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={tabId(active)}
        className="relative mt-8 sm:mt-10"
      >
        <AnimatePresence initial={false} mode="popLayout">
          <motion.div
            key={tab.id}
            variants={gridVariants}
            initial="enter"
            animate="visible"
            exit="exit"
            className="relative z-10 flex flex-col gap-4 sm:gap-5 lg:grid lg:grid-cols-[1fr_1.5fr_1fr] lg:items-start"
          >
            {tab.columns.map((slots, col) => (
              <div key={col} className="flex flex-col gap-4 sm:gap-5">
                {slots.map((slot, i) =>
                  slot.kind === "card" ? (
                    <motion.div
                      key={slot.feature.title}
                      variants={itemVariants}
                    >
                      <FeatureCard feature={slot.feature} tall={col === 1} />
                    </motion.div>
                  ) : (
                    <motion.div
                      key={`tile-${i}`}
                      variants={itemVariants}
                      aria-hidden
                      className={`hidden aspect-square w-1/2 rounded-2xl border border-ash-border bg-warm-sand lg:block ${
                        slot.align === "end" ? "self-end" : "self-start"
                      }`}
                    />
                  ),
                )}
              </div>
            ))}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
