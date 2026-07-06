"use client";

// Number ticker: counts from 0 → value on the strong ease-out curve when scrolled into view,
// once. Tabular numerals so digits don't jitter. Under reduced-motion it renders the final
// value immediately.

import { useEffect, useRef, useState } from "react";
import { animate, useInView, useReducedMotion } from "motion/react";

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
  const inView = useInView(ref, { once: true, margin: "-80px" });
  const reduce = useReducedMotion();
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    // Reduced motion renders the final value via the derivation below, so the effect
    // only drives the count-up animation.
    if (!inView || reduce) return;
    const controls = animate(0, value, {
      duration: durationMs / 1000,
      ease: [0.23, 1, 0.32, 1],
      onUpdate: (v) => setDisplay(v),
    });
    return () => controls.stop();
  }, [inView, value, reduce, durationMs]);

  return (
    <span ref={ref} className={`tabular-nums ${className ?? ""}`}>
      {Math.round(inView && reduce ? value : display)}
      {suffix}
    </span>
  );
}
