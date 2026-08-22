"use client";

// Number ticker: counts from 0 → value on the strong ease-out curve once on mount. Tabular
// numerals so digits don't jitter. Under reduced-motion it renders the final value immediately.
//
// The final value is what renders, on the server and on every React pass. useReducedMotion()
// returns null on the server, so branching the rendered output on it used to server-render a 0:
// a reader without JavaScript saw "0%" where the proof number belongs. The count-up is driven
// imperatively against the DOM node instead, which keeps it out of the render path entirely.

import { useEffect, useRef } from "react";
import { animate, useReducedMotion } from "motion/react";

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
  const reduce = useReducedMotion();
  const formatted = `${value.toFixed(decimals)}${suffix}`;

  useEffect(() => {
    if (reduce) return;
    const node = ref.current;
    if (!node) return;

    const controls = animate(0, value, {
      duration: durationMs / 1000,
      ease: [0.23, 1, 0.32, 1],
      onUpdate: (v) => {
        node.textContent = `${v.toFixed(decimals)}${suffix}`;
      },
    });
    return () => {
      controls.stop();
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
