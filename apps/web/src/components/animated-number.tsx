"use client";

// Number ticker: counts from 0 → value on the strong ease-out curve once on mount. Tabular
// numerals so digits don't jitter. Under reduced-motion it renders the final value immediately.

import { useEffect, useRef, useState } from "react";
import { animate, useReducedMotion } from "motion/react";

export function AnimatedNumber({
  value,
  suffix = "",
  className,
  durationMs = 1200,
}: {
  value: number;
  suffix?: string;
  className?: string;
  durationMs?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  const [display, setDisplay] = useState(reduce ? value : 0);

  useEffect(() => {
    // Under reduced motion the render below shows `value` directly; nothing to animate.
    if (reduce) return;

    const controls = animate(0, value, {
      duration: durationMs / 1000,
      ease: [0.23, 1, 0.32, 1],
      onUpdate: (v) => setDisplay(v),
    });
    return () => controls.stop();
  }, [value, reduce, durationMs]);

  return (
    <span ref={ref} className={`tabular-nums ${className ?? ""}`}>
      {Math.round(reduce ? value : display)}
      {suffix}
    </span>
  );
}
