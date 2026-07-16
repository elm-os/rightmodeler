"use client";

// CrucibleShowcase — the six Crucible features as a tabbed gallery: a centered pill toggle over a
// three-column grid of full-bleed image cards (the center column runs wider, the sides carry a
// half-width empty tile so the columns stagger), in the spirit of an editorial news wall. The two
// tabs mirror each other's arrangement, so switching visibly re-choreographs the wall. The accent
// hues live only inside the two generated grain-gradient images; every control stays monochrome.
// Motion: the whole grid crossfades per tab via AnimatePresence popLayout (exit snaps out as one
// unit, cards re-enter with a short stagger — asymmetric, interruptible, transform/opacity only),
// and the toggle thumb slides between labels as a shared element. Reduced motion drops movement
// and stagger, keeping only opacity.

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

const COST: Feature = {
  title: "Cost, by layer",
  caption: "One invoice becomes a map: spend per agent, per step, per model.",
  img: "/crucible/cost.jpg",
};
const SPEED: Feature = {
  title: "Speed, by step",
  caption:
    "p50 and p95 per step, so the slow layer stops hiding in an aggregate.",
  img: "/crucible/speed.jpg",
};
const FAILURES: Feature = {
  title: "Failures, as they happen",
  caption:
    "Failed tools, silent retries, and quality regressions surface in a passive feed.",
  img: "/crucible/failures.jpg",
};
const RIGHTSIZED: Feature = {
  title: "Continuously right-sized",
  caption:
    "Every new trace is audited as it arrives, so the stack never drifts.",
  img: "/crucible/rightsized.jpg",
};
const MCP: Feature = {
  title: "Connected over MCP",
  caption:
    "Reads the traces you already have. No new SDK, no re-instrumentation.",
  img: "/crucible/mcp.jpg",
};
const KEYS: Feature = {
  title: "Your keys, your routes",
  caption: "BYO keys, or route through OpenRouter, the AI Gateway, or LiteLLM.",
  img: "/crucible/keys.jpg",
};

// Column recipe per tab — [big, tile] against [tile, big] on the opposite side is what makes the
// wall stagger, and the second tab mirrors the first so the swap reads as a re-choreography.
const TABS: TabDef[] = [
  {
    id: "instruments",
    label: "The instruments",
    columns: [
      [
        { kind: "card", feature: COST },
        { kind: "tile", align: "end" },
      ],
      [{ kind: "card", feature: SPEED }],
      [
        { kind: "tile", align: "start" },
        { kind: "card", feature: FAILURES },
      ],
    ],
  },
  {
    id: "always-on",
    label: "Always on",
    columns: [
      [
        { kind: "tile", align: "end" },
        { kind: "card", feature: KEYS },
      ],
      [{ kind: "card", feature: MCP }],
      [
        { kind: "card", feature: RIGHTSIZED },
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
            ? "(min-width: 1024px) 480px, (min-width: 768px) 42vw, 92vw"
            : "(min-width: 1024px) 320px, (min-width: 768px) 28vw, 92vw"
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

  // The exiting grid leaves as one fast unit; the entering cards land with a short stagger
  // (asymmetric timing). Under reduced motion both collapse to a plain opacity fade.
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
            className="relative z-10 flex flex-col gap-4 sm:gap-5 md:grid md:grid-cols-[1fr_1.5fr_1fr] md:items-start"
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
                      className={`hidden aspect-square w-1/2 rounded-2xl border border-ash-border bg-warm-sand md:block ${
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
