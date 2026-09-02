"use client";

// Number ticker: counts from 0 → value on the strong ease-out curve once on mount. Tabular
// numerals so digits don't jitter. Under reduced-motion it renders the final value immediately.
//
// The final value is what renders, on the server and on every React pass. Branching the rendered
// output on a client-only motion preference would server-render a 0:
// a reader without JavaScript saw "0%" where the proof number belongs. The count-up is driven
// imperatively against the DOM node instead, which keeps it out of the render path entirely.

import { useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "@/components/use-prefers-reduced-motion";

// cubic-bezier(0.23, 1, 0.32, 1), the --ease-out-strong token: bisect x(u) = t, return y(u).
function easeOutStrong(t: number): number {
  const bez = (a: number, b: number, u: number) =>
    3 * (1 - u) ** 2 * u * a + 3 * (1 - u) * u ** 2 * b + u ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const u = (lo + hi) / 2;
    if (bez(0.23, 0.32, u) < t) lo = u;
    else hi = u;
  }
  return bez(1, 1, (lo + hi) / 2);
}

export function AnimatedNumber({
  value,
  suffix = "",
  decimals = 0,
  className,
  durationMs = 1200,
}: {
  value: number;
  suffix?: string;
  decimals?: number;
  className?: string;
  durationMs?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = usePrefersReducedMotion();
  const formatted = `${value.toFixed(decimals)}${suffix}`;

  useEffect(() => {
    if (reduce) return;
    const node = ref.current;
    if (!node) return;

    const start = performance.now();
    let raf = requestAnimationFrame(function step(now) {
      const t = Math.min((now - start) / durationMs, 1);
      node.textContent =
        t < 1
          ? `${(value * easeOutStrong(t)).toFixed(decimals)}${suffix}`
          : formatted;
      if (t < 1) raf = requestAnimationFrame(step);
    });
    return () => {
      cancelAnimationFrame(raf);
      // Any later render restores the same text React already believes is there.
      node.textContent = formatted;
    };
  }, [value, reduce, durationMs, decimals, suffix, formatted]);

  return (
    <span ref={ref} className={`tabular-nums ${className ?? ""}`}>
      {formatted}
    </span>
  );
}
