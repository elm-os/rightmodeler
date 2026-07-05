"use client";

// Hero signature — the Paper Design grain-gradient backdrop, FROZEN to a static frame (speed 0).
// The two decorative accent hues bloom in the corners over a parchment base with grain noise; the
// centre stays light so black ink is legible. No motion. Decorative + aria-hidden.

import { GrainGradient } from "@paper-design/shaders-react";

export function HeroGradient({ className }: { className?: string }) {
  return (
    <div className={className} aria-hidden>
      <GrainGradient
        width="100%"
        height="100%"
        fit="cover"
        colors={["#0447ff", "#ff4704"]}
        colorBack="#fdfcfc"
        softness={0.9}
        intensity={0.42}
        noise={0.34}
        shape="corners"
        speed={0}
        frame={9000}
      />
      {/* Extra static bloom to strengthen the top-right corner only. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(82% 68% at 100% 0%, rgba(4,71,255,0.26) 0%, rgba(4,71,255,0.08) 34%, rgba(4,71,255,0) 62%)",
        }}
      />
    </div>
  );
}
