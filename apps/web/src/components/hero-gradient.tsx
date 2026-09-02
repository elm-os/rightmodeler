"use client";

// Hero signature — a Paper Design grain-gradient backdrop. The two decorative accent hues bloom
// softly over a parchment base with grain noise (echoing the paper identity). Tuned LIGHT so black
// ink stays legible; the hero section adds a parchment veil behind the text. Decorative + aria-hidden.
// Under reduced-motion the shader freezes to a static frame.
// The shader loads client-side only, and its clock stops outside a 160 px viewport margin.

import dynamic from "next/dynamic";
import { useRef } from "react";
import { useInView } from "@/components/use-in-view";
import { usePrefersReducedMotion } from "@/components/use-prefers-reduced-motion";

const HeroGradientShader = dynamic(
  () =>
    import("@/components/hero-gradient-shader").then(
      (m) => m.HeroGradientShader,
    ),
  { ssr: false },
);

export function HeroGradient({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = usePrefersReducedMotion();
  const inView = useInView(ref, { rootMargin: "160px" });
  return (
    <div ref={ref} className={className} aria-hidden>
      <HeroGradientShader
        speed={inView && !reduce ? 0.3 : 0}
        frame={reduce ? 9000 : 0}
      />
    </div>
  );
}
