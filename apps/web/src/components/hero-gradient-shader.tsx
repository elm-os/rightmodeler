"use client";

import { GrainGradient } from "@paper-design/shaders-react";

export function HeroGradientShader({
  speed,
  frame,
}: {
  speed: number;
  frame: number;
}) {
  return (
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
      speed={speed}
      frame={frame}
    />
  );
}
