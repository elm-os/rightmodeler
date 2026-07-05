"use client";

// Scroll-into-view reveal: a small opacity + translateY(8px) entrance on the strong ease-out
// curve, fired once. Stagger by passing an incremental `delay`. Under reduced-motion it
// becomes opacity-only (no movement). Emil bar: transform/opacity only, sub-500ms, ease-out.

import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

export function Reveal({
  children,
  delay = 0,
  y = 8,
  className,
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y }}
      whileInView={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-64px" }}
      transition={{ duration: 0.5, ease: [0.23, 1, 0.32, 1], delay }}
    >
      {children}
    </motion.div>
  );
}
