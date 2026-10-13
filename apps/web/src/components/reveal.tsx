"use client";

// data-reveal is the hook for the <noscript> rule in app/layout.tsx: keep both.

import { useEffect, useRef, type ReactNode } from "react";
import { useInView } from "@/components/use-in-view";
import { usePrefersReducedMotion } from "@/components/use-prefers-reduced-motion";

export function Reveal({
  children,
  delay = 0,
  y = 8,
  className,
  lcp = false,
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
  // For the page's largest text: the same entrance as keyframes from 0.01 (reveal-lcp in
  // app/globals.css), which Chrome counts as painted at once. Default y and delay only.
  lcp?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = usePrefersReducedMotion();
  const shown = useInView(ref, { once: true, rootMargin: "-64px" });
  useEffect(() => {
    const el = ref.current;
    if (!lcp || !el) return;
    return () => {
      // Hidden by Next mid-entrance: a CSS animation would otherwise replay on return.
      if (el.dataset.shown === "" && el.getClientRects().length === 0)
        el.dataset.shown = "done";
    };
  }, [lcp]);
  if (lcp)
    return (
      <div
        ref={ref}
        data-reveal
        data-shown={shown ? "" : undefined}
        className={`reveal-lcp ${className ?? ""}`}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget)
            event.currentTarget.dataset.shown = "done";
        }}
      >
        {children}
      </div>
    );
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
