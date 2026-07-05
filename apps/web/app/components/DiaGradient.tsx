"use client";

// Dia Browser's signature gradient — implemented exactly as the reference guide
// (https://www.arlan.me/vault/dia-gradient): a row of N tall, heavily-blurred columns share one
// vertical rainbow gradient, arranged in a symmetric bell curve (short at the edges, tallest in
// the middle). The field is anchored to the floor and RISES on a scaleY(0) → 1 transform
// (transform-origin: bottom) with a spring-like ease, so it unfurls from the floor. One inline
// <svg> — no canvas, no per-frame work. Decorative + aria-hidden.
//
// The one adaptation for the footer: it rises when scrolled into view (rather than on mount) so
// the animation is actually seen at the foot of the page. Reduced-motion fades it in instead.

import { useRef } from "react";
import { useInView, useReducedMotion } from "motion/react";

type Stop = { offset: number; color: string };

// Brand recolor of Dia's stops — same structure (bottom → top), but only rightmodeler's two
// decorative accent hues through a parchment core, matching the hero/CTA gradient palette:
// void-violet floor → light violet → parchment core → ember → transparent ember at the top.
const DIA_STOPS: Stop[] = [
  { offset: 0, color: "#0447ff" }, // void-violet — the floor
  { offset: 0.22, color: "#6f86ff" }, // light violet
  { offset: 0.44, color: "#b3aaff" }, // pale violet
  { offset: 0.58, color: "#ffc4a0" }, // pale ember
  { offset: 0.76, color: "#ff7a45" }, // light ember
  { offset: 0.9, color: "#ff4704" }, // ember-orange
  { offset: 1, color: "#ff470400" }, // transparent ember at the top
];

const VBW = 1271;
const VBH = 599;

// Height curve fitted to the real Dia footer: a gentle power falloff (not a cosine bell), giving
// the flatter, pyramid-like rise of the original.
function bellHeights(n: number, peak: number, valley: number): number[] {
  const out: number[] = [];
  const mid = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const t = mid === 0 ? 0 : Math.abs(i - mid) / mid; // 0 center → 1 edge
    const eased = 1 - Math.pow(t, 1.24); // 1 at center → 0 at edge
    out.push(peak * VBH * (valley + (1 - valley) * eased));
  }
  return out;
}

export function DiaGradient({
  bars = 9,
  blur = 15,
  peak = 0.98,
  valley = 0.55,
  stops = DIA_STOPS,
  riseMs = 1100,
  rise = true,
}: {
  bars?: number;
  blur?: number;
  peak?: number;
  valley?: number;
  stops?: Stop[];
  riseMs?: number;
  rise?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const inView = useInView(ref, { once: true, margin: "0px 0px -8% 0px" });
  // rise=false renders it statically (fully shown) — used when something else (the overscroll
  // spring) provides the reveal motion.
  const shown = rise ? inView : true;

  const heights = bellHeights(bars, peak, valley);
  const colW = VBW / bars;

  return (
    // Outer element is the IntersectionObserver target — never transformed, so its layout box
    // stays full-height and the observer can fire before the inner element has risen.
    <div ref={ref} aria-hidden style={{ height: "100%", width: "100%" }}>
      <div
        style={{
          height: "100%",
          width: "100%",
          transformOrigin: "bottom",
          transform:
            !rise || reduce ? "none" : shown ? "scaleY(1)" : "scaleY(0)",
          opacity: rise && reduce ? (shown ? 1 : 0) : 1,
          transition: !rise
            ? "none"
            : reduce
              ? `opacity ${riseMs}ms ease`
              : `transform ${riseMs}ms cubic-bezier(0.16, 1, 0.3, 1)`,
          willChange: rise ? "transform" : undefined,
        }}
      >
        <svg
          style={{ height: "100%", width: "100%" }}
          viewBox={`0 0 ${VBW} ${VBH}`}
          preserveAspectRatio="none"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            {/* objectBoundingBox units: the gradient maps to each rect's own box, so every bar
                shows the full rainbow over its own height — the way the real Dia footer does it. */}
            <linearGradient id="dia-grad" x1="0" y1="1" x2="0" y2="0">
              {stops.map((s, i) => (
                <stop key={i} offset={s.offset} stopColor={s.color} />
              ))}
            </linearGradient>
            <filter id="dia-blur" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation={blur} />
            </filter>
          </defs>
          {heights.map((h, i) => (
            <g key={i} filter="url(#dia-blur)">
              <rect
                x={i * colW}
                y={VBH - h}
                width={colW * 1.23}
                height={h}
                fill="url(#dia-grad)"
              />
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}
