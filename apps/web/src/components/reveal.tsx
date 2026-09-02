"use client";

// Scroll-into-view reveal: an observer triggers a small opacity + translateY(8px) CSS transition
// on the strong ease-out curve, once. Stagger by passing an incremental `delay`. Under
// reduced-motion it becomes opacity-only (no movement).
//
// data-reveal is the hook the <noscript> rule in app/layout.tsx targets. The observer needs
// JavaScript, so without it every revealed element would sit at opacity:0 forever and a
// no-JS reader would see a blank page.

import { useRef, type ReactNode } from "react";
import { useInView } from "@/components/use-in-view";
import { usePrefersReducedMotion } from "@/components/use-prefers-reduced-motion";

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
  const ref = useRef<HTMLDivElement>(null);
  const reduce = usePrefersReducedMotion();
  const shown = useInView(ref, { once: true, rootMargin: "-64px" });
  const timing = `500ms var(--ease-out-strong) ${Math.round(delay * 1000)}ms`;
  return (
    <div
      ref={ref}
      data-reveal
      className={className}
      style={{
        opacity: shown ? 1 : 0,
        transform: reduce || shown ? "none" : `translateY(${y}px)`,
        transition: reduce
          ? `opacity ${timing}`
          : `opacity ${timing}, transform ${timing}`,
      }}
    >
      {children}
    </div>
  );
}
