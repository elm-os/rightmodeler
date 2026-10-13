"use client";

// Dia Browser's signature gradient, built to https://www.arlan.me/vault/dia-gradient.

import { useRef } from "react";
import { useInView } from "@/components/use-in-view";
import { usePrefersReducedMotion } from "@/components/use-prefers-reduced-motion";

type Stop = { offset: number; color: string };

// Offsets run bottom to top: void-violet floor, ember-orange fading out at the top.
const DIA_STOPS: Stop[] = [
  { offset: 0, color: "#0447ff" },
  { offset: 0.22, color: "#6f86ff" },
  { offset: 0.44, color: "#b3aaff" },
  { offset: 0.58, color: "#ffc4a0" },
  { offset: 0.76, color: "#ff7a45" },
  { offset: 0.9, color: "#ff4704" },
  { offset: 1, color: "#ff470400" },
];

const VBW = 1271;
const VBH = 599;

// A power falloff fitted to the real Dia footer, not a cosine bell.
function bellHeights(n: number, peak: number, valley: number): number[] {
  const out: number[] = [];
  const mid = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const t = mid === 0 ? 0 : Math.abs(i - mid) / mid;
    const eased = 1 - Math.pow(t, 1.24);
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
  const reduce = usePrefersReducedMotion();
  const inView = useInView(ref, {
    once: true,
    rootMargin: "0px 0px -8% 0px",
  });
  // rise=false shows it statically: the overscroll spring provides the motion instead.
  const shown = rise ? inView : true;

  const heights = bellHeights(bars, peak, valley);
  const colW = VBW / bars;

  return (
    // The observer target: never transform it, or it cannot intersect before the inner one rises.
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
            {/* objectBoundingBox units: every bar shows the full gradient over its own height. */}
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
