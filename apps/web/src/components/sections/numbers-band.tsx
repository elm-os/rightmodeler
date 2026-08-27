"use client";

// Numbers band: the proof section. Four numbers drive one WebGL field of particles
// (trace-field-engine) that settles into a different etched plate per stat: a braided
// river delta (many formats, one schema), descending terraces (cost stepping down), a
// planetary ring (quality holding), and a suspension bridge (speed and throughput).
// The answer to Stripe's morphing stats section, in the house voice: ink chrome on
// paper, accent hues confined to the illustration.
//
// Rules honored here: the stat buttons, indicator, and palette control stay strictly
// monochrome (accents are decorative only); the format count comes from the
// product-facts registry; the graphic pauses off-screen and under reduced motion
// swaps plates with a quiet crossfade instead of flight. The rotation pattern (one
// slow advance per beat, paused on hover or focus, none under reduced motion) is
// TestimonialBand's, at the same calm cadence.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";
import { Reveal } from "@/components/reveal";
import {
  createTraceField,
  PALETTES,
  type PaletteName,
  type ShapeMask,
  type TraceField,
} from "@/components/trace-field-engine";
import { TRACE_SOURCES } from "@/lib/product-facts";

const EASE: [number, number, number, number] = [0.23, 1, 0.32, 1];
const ROTATE_MS = 9000;
const PALETTE_ORDER: PaletteName[] = ["duet", "violet", "ember", "dawn"];

// The four etched plates the particles settle into, one per stat: a braided river
// delta, descending terraces, a planetary ring, a suspension bridge.
const PLATES = ["delta", "terraces", "ring", "bridge"] as const;

// Decode the plates into pixel masks for the engine's density sampler. Any failure
// returns null and the engine falls back to procedural silhouettes.
async function loadPlates(): Promise<ShapeMask[] | null> {
  try {
    return await Promise.all(
      PLATES.map(async (name) => {
        const res = await fetch(`/numbers/${name}.jpg`);
        if (!res.ok) throw new Error(`${name}: ${res.status}`);
        const bitmap = await createImageBitmap(await res.blob());
        const c = document.createElement("canvas");
        c.width = bitmap.width;
        c.height = bitmap.height;
        const ctx = c.getContext("2d");
        if (!ctx) throw new Error("2d context unavailable");
        ctx.drawImage(bitmap, 0, 0);
        const img = ctx.getImageData(0, 0, c.width, c.height);
        bitmap.close();
        return { data: img.data, width: img.width, height: img.height };
      }),
    );
  } catch {
    return null;
  }
}

// The three percentage figures are quoted verbatim from the B:Side engagement
// write-up (content/case-studies.ts BSIDE); the captions carry the projected versus
// measured hedges inline.
const STATS: { value: string; caption: string }[] = [
  {
    value: `${TRACE_SOURCES.length}`,
    caption: "trace formats autodetected into one per-step schema",
  },
  {
    value: "70.8%",
    caption: "lower inference cost projected at B:Side",
  },
  {
    value: "100%",
    caption: "quality held, measured on the acceptance benchmark",
  },
  {
    value: "53.3%",
    caption: "faster responses on the benchmarked workloads",
  },
];

// Monochrome glyphs for the palette menu: two moons for the duet, a full disc for
// violet, a radiant disc for ember, a horizon for dawn. Ink strokes only.
function PaletteIcon({ name }: { name: PaletteName }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    "aria-hidden": true,
  } as const;
  if (name === "duet") {
    return (
      <svg {...common}>
        <circle cx="6" cy="8" r="4" />
        <circle
          cx="10.5"
          cy="8"
          r="4"
          fill="currentColor"
          stroke="none"
          opacity="0.25"
        />
      </svg>
    );
  }
  if (name === "violet") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="4.2" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (name === "ember") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="2.6" />
        <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M4.2 9.4a3.8 3.8 0 0 1 7.6 0" />
      <path d="M1.8 12h12.4" />
    </svg>
  );
}

export function NumbersBand() {
  const reduce = useReducedMotion();
  const sectionRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fieldRef = useRef<TraceField | null>(null);
  const inView = useInView(sectionRef, { margin: "160px 0px 160px 0px" });
  const [active, setActive] = useState(0);
  const [palette, setPalette] = useState<PaletteName>("duet");
  const [menuOpen, setMenuOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [canvasDim, setCanvasDim] = useState(false);
  const dimTimer = useRef<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  // The engine mounts once the plates decode; until then only the wash shows. It
  // then lives for the component's lifetime, and visibility only starts and stops
  // its clock. Reduced motion renders settled frames instead of running a loop.
  const [fieldReady, setFieldReady] = useState(false);
  const stateRef = useRef({ active, palette });
  useEffect(() => {
    stateRef.current = { active, palette };
  }, [active, palette]);
  useEffect(() => {
    let cancelled = false;
    let field: TraceField | null = null;
    loadPlates().then((masks) => {
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      field = createTraceField(canvas, {
        palette: stateRef.current.palette,
        reducedMotion: reduce ?? false,
        initialShape: stateRef.current.active,
        masks: masks ?? undefined,
      });
      fieldRef.current = field;
      setFieldReady(true);
    });
    return () => {
      cancelled = true;
      fieldRef.current = null;
      if (dimTimer.current !== null) window.clearTimeout(dimTimer.current);
      field?.destroy();
    };
    // The engine is deliberately not rebuilt when `reduce` flips mid-visit; the
    // preference is read once per mount, which matches how the OS setting behaves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    if (inView) field.start();
    else field.stop();
  }, [inView, fieldReady]);

  const selectStat = useCallback(
    (index: number) => {
      setActive(index);
      const field = fieldRef.current;
      if (!field) return;
      if (reduce) {
        // No flight: a quiet dip while the settled diagram swaps. Rapid clicks
        // retarget the same pending swap instead of stacking timers, and the ref
        // read inside the callback keeps an unmounted engine out of reach.
        if (dimTimer.current !== null) window.clearTimeout(dimTimer.current);
        setCanvasDim(true);
        dimTimer.current = window.setTimeout(() => {
          dimTimer.current = null;
          fieldRef.current?.setShape(index);
          setCanvasDim(false);
        }, 160);
      } else {
        field.setShape(index);
      }
    },
    [reduce],
  );

  // One slow advance per beat, TestimonialBand's cadence exactly: a manual stat
  // click resets the clock through `active`; hover, focus, or leaving the viewport
  // holds it; reduced motion turns it off.
  useEffect(() => {
    if (reduce || paused || !inView) return;
    const timer = window.setTimeout(() => {
      const next = (active + 1) % STATS.length;
      setActive(next);
      fieldRef.current?.setShape(next);
    }, ROTATE_MS);
    return () => window.clearTimeout(timer);
  }, [active, paused, inView, reduce]);

  const choosePalette = useCallback((name: PaletteName) => {
    setPalette(name);
    fieldRef.current?.setPalette(name);
    setMenuOpen(false);
    menuButtonRef.current?.focus();
  }, []);

  // Escape and outside-click close the palette menu.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (
        !menuRef.current?.contains(e.target as Node) &&
        !menuButtonRef.current?.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [menuOpen]);

  return (
    <section
      ref={sectionRef}
      className="bg-parchment-white"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setPaused(false);
        }
      }}
    >
      <div className="px-4 py-16 sm:px-6 sm:py-24">
        <Reveal>
          <p className="font-mono text-caption uppercase text-fog">
            The numbers
          </p>
          <h2 className="mt-4 max-w-2xl font-display text-heading text-balance text-midnight-ink sm:text-heading-lg">
            What the replays showed
          </h2>
        </Reveal>

        {/* The stat menu: all four numbers stay readable; the active one is ink and
            carries a sliding hairline overhead, the way a ledger rules its columns. */}
        <Reveal delay={0.06}>
          <div className="mt-10 grid grid-cols-2 gap-x-4 gap-y-6 sm:mt-12 lg:grid-cols-4">
            {STATS.map((stat, i) => {
              const isActive = i === active;
              return (
                <button
                  key={stat.value}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => selectStat(i)}
                  className="group relative pt-4 text-left transition-transform duration-150 ease-out active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-4 focus-visible:ring-offset-parchment-white"
                >
                  <span
                    aria-hidden
                    className="absolute inset-x-0 top-0 h-px bg-ash-border"
                  />
                  {isActive && (
                    <motion.span
                      aria-hidden
                      layoutId="numbers-band-indicator"
                      transition={
                        reduce
                          ? { duration: 0 }
                          : { duration: 0.26, ease: EASE }
                      }
                      className="absolute inset-x-0 top-0 h-px bg-midnight-ink"
                    />
                  )}
                  <span
                    className={`block font-display text-heading tabular-nums transition-colors duration-200 ease-out ${
                      isActive
                        ? "text-midnight-ink"
                        : "text-fog group-hover:text-driftwood"
                    }`}
                  >
                    {stat.value}
                  </span>
                  <span
                    className={`mt-1 block max-w-52 text-body transition-colors duration-200 ease-out ${
                      isActive ? "text-driftwood" : "text-fog"
                    }`}
                  >
                    {stat.caption}
                  </span>
                </button>
              );
            })}
          </div>
        </Reveal>

        {/* The trace field. One soft bloom rises from the floor of the panel behind
            the particles, the way the reference section stages its scene. One wash
            layer per palette, and only opacity crossfades between them: gradients
            are not interpolable in CSS, so swapping one background would snap while
            the particles fade. Decorative throughout, so aria-hidden. */}
        <Reveal delay={0.12}>
          <div className="relative mt-10 overflow-hidden rounded-2xl border border-ash-border">
            {PALETTE_ORDER.map((name) => {
              const [washA, washB] = PALETTES[name].wash;
              return (
                <div
                  key={name}
                  aria-hidden
                  className={`absolute inset-0 transition-opacity duration-500 ease-out ${
                    name === palette ? "opacity-[0.15]" : "opacity-0"
                  }`}
                  style={{
                    background: `radial-gradient(95% 85% at 50% 104%, ${washA} 0%, transparent 64%), radial-gradient(52% 44% at 72% 102%, ${washB} 0%, transparent 62%)`,
                  }}
                />
              );
            })}
            <canvas
              ref={canvasRef}
              aria-hidden
              className="relative block h-[380px] w-full transition-opacity duration-150 ease-out sm:h-[440px] lg:h-[500px]"
              style={{ opacity: canvasDim ? 0 : 1 }}
              onPointerMove={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                fieldRef.current?.setPointer(
                  ((e.clientX - r.left) / r.width) * 2 - 1,
                  (1 - (e.clientY - r.top) / r.height) * 2 - 1,
                );
              }}
            />

            {/* Palette control, top right like the section it answers. Monochrome
                chrome: the accents live in the illustration alone. */}
            <div className="absolute right-3 top-3">
              <button
                ref={menuButtonRef}
                type="button"
                aria-expanded={menuOpen}
                aria-controls={menuId}
                aria-label={`Illustration palette: ${PALETTES[palette].label}. Choose a palette`}
                onClick={() => setMenuOpen((v) => !v)}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-ash-border bg-parchment-white/90 text-driftwood backdrop-blur-sm transition-[background-color,color,transform] duration-150 ease-out hover:bg-warm-sand hover:text-midnight-ink active:scale-[0.93] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40"
              >
                <PaletteIcon name={palette} />
              </button>
              {menuOpen && (
                <motion.div
                  ref={menuRef}
                  id={menuId}
                  role="group"
                  aria-label="Illustration palette"
                  initial={
                    reduce ? { opacity: 0 } : { opacity: 0, scale: 0.95 }
                  }
                  animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1 }}
                  transition={{ duration: 0.18, ease: EASE }}
                  style={{ transformOrigin: "top right" }}
                  className="absolute right-0 top-10 w-36 rounded-xl border border-ash-border bg-parchment-white p-1 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
                >
                  {PALETTE_ORDER.map((name) => {
                    const isActive = name === palette;
                    return (
                      <button
                        key={name}
                        type="button"
                        aria-pressed={isActive}
                        onClick={() => choosePalette(name)}
                        className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-body transition-colors duration-150 ease-out hover:bg-warm-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 ${
                          isActive
                            ? "font-medium text-midnight-ink"
                            : "text-driftwood"
                        }`}
                      >
                        <PaletteIcon name={name} />
                        {PALETTES[name].label}
                      </button>
                    );
                  })}
                </motion.div>
              )}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
