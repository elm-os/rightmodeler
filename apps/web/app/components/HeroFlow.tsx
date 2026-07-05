"use client";

// HeroFlow — the star artifact as three tabs over one transparent surface:
//   Swaps    — the optimize run: types the uv command, analyses, then resolves
//              model swaps in a cascade (one family at a time), with real costs.
//              Auth edits abstain — the product declines to swap high-risk,
//              low-evidence families (docs/PRD.md § 9.5).
//   Evidence — the strongest evaluator backing each family + its confidence.
//   Savings  — projected monthly spend per family, before → after.
// Body-size sans (matches the hero copy); compact, centred columns. All three
// views share one grid cell so the panel never resizes between tabs. Figures are
// illustrative list prices, not measured results.

import { useEffect, useState, type ComponentType, type SVGProps } from "react";
import {
  ArrowRightIcon,
  ClaudeIcon,
  GeminiIcon,
  MistralIcon,
  OpenAIIcon,
} from "./icons";

type Provider = "openai" | "anthropic" | "gemini" | "mistral";
type IconCmp = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

const ICONS: Record<Provider, IconCmp> = {
  openai: OpenAIIcon,
  anthropic: ClaudeIcon,
  gemini: GeminiIcon,
  mistral: MistralIcon,
};

const money = (n: number, unit: "M" | "s") => `$${n.toFixed(2)}/${unit}`;

// ── Data ─────────────────────────────────────────────────────────────────────

interface Node {
  label: string;
  p: Provider;
  cost: number;
}
interface Flow {
  task: string;
  unit: "M" | "s";
  from: Node;
  to: Node | null; // null = held (abstain / cascade)
  hold?: "abstain" | "cascade";
}

const FLOWS: Flow[] = [
  {
    task: "PR summary",
    unit: "M",
    from: { label: "GPT-4.1", p: "openai", cost: 3.5 },
    to: { label: "Mistral Small", p: "mistral", cost: 0.3 },
  },
  {
    task: "SQL gen",
    unit: "M",
    from: { label: "GPT-4o", p: "openai", cost: 4.4 },
    to: { label: "Gemini Flash", p: "gemini", cost: 0.18 },
  },
  {
    task: "Tool agent",
    unit: "M",
    from: { label: "Claude Opus", p: "anthropic", cost: 10 },
    to: null,
    hold: "cascade",
  },
  {
    task: "Auth edit",
    unit: "M",
    from: { label: "Claude Opus", p: "anthropic", cost: 10 },
    to: null,
    hold: "abstain",
  },
  {
    task: "Video gen",
    unit: "s",
    from: { label: "Sora", p: "openai", cost: 0.5 },
    to: { label: "Veo 3 Fast", p: "gemini", cost: 0.15 },
  },
  {
    task: "Code exec",
    unit: "M",
    from: { label: "GPT-4o", p: "openai", cost: 4.4 },
    to: { label: "Codestral", p: "mistral", cost: 0.45 },
  },
];

const POOL: { label: string; p: Provider }[] = [
  { label: "Mistral Small", p: "mistral" },
  { label: "Gemini Flash", p: "gemini" },
  { label: "GPT-4o-mini", p: "openai" },
  { label: "Claude Haiku", p: "anthropic" },
];

const EVIDENCE: {
  family: string;
  method: string;
  strength: number;
  conf: "high" | "medium" | "abstain";
}[] = [
  {
    family: "json extraction",
    method: "deterministic",
    strength: 4,
    conf: "high",
  },
  { family: "sql gen", method: "reference", strength: 3, conf: "medium" },
  {
    family: "pr summary",
    method: "reference + judge",
    strength: 3,
    conf: "medium",
  },
  { family: "tool agent", method: "trajectory", strength: 2, conf: "medium" },
  { family: "auth edit", method: "insufficient", strength: 0, conf: "abstain" },
];

const SPEND: { family: string; now: number; next: number }[] = [
  { family: "PR summary", now: 1240, next: 430 },
  { family: "SQL gen", now: 980, next: 290 },
  { family: "Tool agent", now: 1520, next: 620 },
  { family: "Code exec", now: 760, next: 280 },
];
const SPEND_NOW = SPEND.reduce((s, r) => s + r.now, 0);
const SPEND_NEXT = SPEND.reduce((s, r) => s + r.next, 0);
const SPEND_MAX = Math.max(...SPEND.map((r) => r.now));
const SPEND_PCT = Math.round((1 - SPEND_NEXT / SPEND_NOW) * 100);

// ── Shared pieces ────────────────────────────────────────────────────────────

function ModelName({
  label,
  provider,
  tone,
  cost,
}: {
  label: string;
  provider: Provider;
  tone: "ink" | "muted";
  cost?: string;
}) {
  const Icon = ICONS[provider];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 ${
        tone === "muted" ? "text-fog" : "text-midnight-ink"
      }`}
    >
      <Icon size={16} />
      <span className="whitespace-nowrap">{label}</span>
      {cost ? <span className="text-silver-mist">{cost}</span> : null}
    </span>
  );
}

function Spinner() {
  return (
    <span className="inline-block size-3.5 animate-spin rounded-full border border-silver-mist border-t-midnight-ink" />
  );
}

// ── Tab 1: Swaps ─────────────────────────────────────────────────────────────

const COMMAND = "uv run python -m pipeline optimize";
type Phase = "typing" | "analysing" | "done";

function SwapsView() {
  const [typed, setTyped] = useState("");
  const [phase, setPhase] = useState<Phase>("typing");
  const [shuffle, setShuffle] = useState(0);
  const [resolved, setResolved] = useState(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const run = () => {
      setPhase("typing");
      setTyped("");
      setResolved(0);
      let i = 0;
      const type = () => {
        if (cancelled) return;
        i += 1;
        setTyped(COMMAND.slice(0, i));
        if (i < COMMAND.length) {
          timer = setTimeout(type, 46);
          return;
        }
        timer = setTimeout(() => {
          if (cancelled) return;
          setPhase("analysing");
          timer = setTimeout(() => {
            if (cancelled) return;
            setPhase("done");
            timer = setTimeout(() => {
              if (!cancelled) run();
            }, 4200);
          }, 1500);
        }, 460);
      };
      type();
    };
    timer = setTimeout(run, 60);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (phase !== "analysing") return;
    const id = setInterval(() => setShuffle((s) => s + 1), 110);
    return () => clearInterval(id);
  }, [phase]);

  useEffect(() => {
    if (phase !== "done") return;
    const id = setInterval(
      () => setResolved((r) => Math.min(r + 1, FLOWS.length)),
      220,
    );
    return () => clearInterval(id);
  }, [phase]);

  const revealed = phase !== "typing";
  const working =
    phase === "analysing" || (phase === "done" && resolved < FLOWS.length);

  return (
    <div className="overflow-x-auto">
      <div className="mx-auto w-fit px-4">
        <div className="flex items-center gap-2 py-2">
          <span className="text-fog">$</span>
          <span className="text-midnight-ink">{typed}</span>
          {phase === "typing" ? (
            <span className="inline-block h-4 w-[7px] animate-pulse bg-midnight-ink/70" />
          ) : null}
          {working ? <Spinner /> : null}
        </div>

        <div
          className={`transition-opacity duration-500 ${revealed ? "opacity-100" : "opacity-0"}`}
        >
          {FLOWS.map((flow, i) => {
            const settled = resolved > i;
            const cand = settled ? flow.to : POOL[(shuffle + i) % POOL.length];
            const held = settled && !flow.to;
            return (
              <div key={flow.task} className="flex items-center gap-2.5 py-1.5">
                <span className="w-28 shrink-0 text-driftwood">
                  {flow.task}
                </span>
                <span className="w-44 shrink-0">
                  <ModelName
                    label={flow.from.label}
                    provider={flow.from.p}
                    tone={settled ? "muted" : "ink"}
                    cost={money(flow.from.cost, flow.unit)}
                  />
                </span>
                <span className="shrink-0 text-fog">
                  <ArrowRightIcon size={16} />
                </span>
                <span className="w-44 shrink-0">
                  {held ? (
                    flow.hold === "cascade" ? (
                      <span style={{ color: "#c2410c" }}>cascade · hold</span>
                    ) : (
                      <span className="text-driftwood">
                        abstain · high-risk
                      </span>
                    )
                  ) : cand ? (
                    <ModelName
                      label={cand.label}
                      provider={cand.p}
                      tone="ink"
                      cost={
                        settled && flow.to
                          ? money(flow.to.cost, flow.unit)
                          : undefined
                      }
                    />
                  ) : null}
                </span>
                <span className="w-12 shrink-0 text-right tabular-nums text-midnight-ink">
                  {settled
                    ? flow.to
                      ? `−${Math.round((1 - flow.to.cost / flow.from.cost) * 100)}%`
                      : "—"
                    : ""}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Tab 2: Evidence ──────────────────────────────────────────────────────────

function Strength({ n }: { n: number }) {
  return (
    <span className="inline-flex shrink-0 items-end gap-0.5" aria-hidden>
      {[0, 1, 2, 3].map((k) => (
        <span
          key={k}
          className={`w-1 rounded-[1px] ${k < n ? "bg-midnight-ink" : "bg-silver-mist"}`}
          style={{ height: 5 + k * 2 }}
        />
      ))}
    </span>
  );
}

const CONF_TONE: Record<"high" | "medium" | "abstain", string> = {
  high: "text-midnight-ink",
  medium: "text-driftwood",
  abstain: "text-fog",
};

function EvidenceView() {
  return (
    <div className="overflow-x-auto">
      <div className="mx-auto w-fit px-4 py-2">
        {EVIDENCE.map((e) => (
          <div key={e.family} className="flex items-center gap-2.5 py-1.5">
            <span className="w-40 shrink-0 text-driftwood">{e.family}</span>
            <Strength n={e.strength} />
            <span className="w-40 shrink-0 text-midnight-ink">{e.method}</span>
            <span className={`w-20 shrink-0 ${CONF_TONE[e.conf]}`}>
              {e.conf}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tab 3: Savings ───────────────────────────────────────────────────────────

function SavingsView() {
  return (
    <div className="overflow-x-auto">
      <div className="mx-auto w-fit px-4 py-2">
        <div className="mb-1 flex items-baseline gap-4 py-1.5">
          <span className="text-driftwood">projected monthly spend</span>
          <span className="tabular-nums text-midnight-ink">
            ${SPEND_NOW.toLocaleString("en-US")} → $
            {SPEND_NEXT.toLocaleString("en-US")} ·{" "}
            <span style={{ color: "#15803d" }}>−{SPEND_PCT}%</span>
          </span>
        </div>
        {SPEND.map((s) => {
          const barW = (s.now / SPEND_MAX) * 100;
          const keptFrac = s.next / s.now;
          return (
            <div key={s.family} className="flex items-center gap-2.5 py-1.5">
              <span className="w-28 shrink-0 text-driftwood">{s.family}</span>
              <span className="relative h-2 w-40 shrink-0">
                <span
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ width: `${barW}%`, backgroundColor: "#15803d" }}
                />
                <span
                  className="absolute inset-y-0 left-0 rounded-full bg-midnight-ink"
                  style={{ width: `${barW * keptFrac}%` }}
                />
              </span>
              <span
                className="w-12 shrink-0 text-right tabular-nums"
                style={{ color: "#15803d" }}
              >
                −{Math.round((1 - keptFrac) * 100)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Tabs shell ───────────────────────────────────────────────────────────────

const TABS = [
  { id: "swaps", label: "Swaps" },
  { id: "evidence", label: "Evidence" },
  { id: "savings", label: "Savings" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function HeroFlow() {
  const [tab, setTab] = useState<TabId>("swaps");

  return (
    <div>
      <div
        role="tablist"
        aria-label="Illustration"
        className="mb-3 flex justify-center gap-6 text-body tracking-tighter"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`w-24 border-b-2 pb-1 text-center transition-colors duration-150 ${
              tab === t.id
                ? "border-midnight-ink text-midnight-ink"
                : "border-transparent text-driftwood hover:text-midnight-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* All three views occupy the same grid cell, so the panel height is the
          tallest view's and never changes between tabs. */}
      <div aria-hidden className="grid text-body tracking-tighter">
        <div
          className={`col-start-1 row-start-1 ${tab === "swaps" ? "" : "invisible"}`}
        >
          <SwapsView />
        </div>
        <div
          className={`col-start-1 row-start-1 ${tab === "evidence" ? "" : "invisible"}`}
        >
          <EvidenceView />
        </div>
        <div
          className={`col-start-1 row-start-1 ${tab === "savings" ? "" : "invisible"}`}
        >
          <SavingsView />
        </div>
      </div>
    </div>
  );
}
