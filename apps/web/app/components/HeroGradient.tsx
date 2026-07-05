"use client";

// Hero signature — a Paper Design grain-gradient backdrop. The two decorative accent hues bloom
// softly over a parchment base with grain noise (echoing the paper identity). Tuned LIGHT so black
// ink stays legible; the hero section adds a parchment veil behind the text. Decorative + aria-hidden.
// Under reduced-motion the shader freezes to a static frame.

import { GrainGradient } from "@paper-design/shaders-react";
import { useReducedMotion } from "motion/react";

export function HeroGradient({ className }: { className?: string }) {
  const reduce = useReducedMotion();
  return (
    <div className={className} aria-hidden>
      <GrainGradient
        width="100%"
        height="100%"
        fit="cover"
        colors={["#0447ff", "#ff4704"]}
        colorBack="#fdfcfc"
        softness={0.9}
        intensity={0.34}
        noise={0.34}
        shape="corners"
        speed={reduce ? 0 : 0.3}
        frame={reduce ? 9000 : 0}
      />
    </div>
  );
}
