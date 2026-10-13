// The numbers band's WebGPU backdrop (vgpu). Its CSS washes remain the SSR and no-WebGPU fallback.

import { clock, effect, frame, frameLoop, init, surface } from "vgpu";
import type { Clock, Effect, FrameLoopHandle, Gpu, Surface } from "vgpu";
import type { PaletteName } from "@/components/trace-field-engine";

// Matches the particle engine's crossfade window so the two fade in lockstep.
const PALETTE_FADE_MS = 450;
// Settled-frame time in seconds: the breath term is exactly neutral (sin(2*pi*12/8) = 0).
const FROZEN_T = 12;
// The pass is ~20 ALU ops; 60fps keeps the pointer-following sway silky.
const FPS = 60;
// Pointer smoothing rates, per second.
const POINTER_FOLLOW = 18;
const ENERGY_ATTACK = 14;
const ENERGY_RELEASE = 4;

// Hues by distance from the light; exposure trims perceived weight (deep blue carries more).
const LIGHT_PALETTES: Record<
  PaletteName,
  { core: string; mid: string; far: string; exposure: number }
> = {
  duet: { core: "#ff9e63", mid: "#7a5cff", far: "#b3aaff", exposure: 1 },
  violet: { core: "#5f7bff", mid: "#0447ff", far: "#c9d0ff", exposure: 0.9 },
  ember: { core: "#ffa267", mid: "#ff4704", far: "#ffd4bd", exposure: 1 },
  dawn: { core: "#ff9857", mid: "#b58fd6", far: "#d8c8f2", exposure: 0.95 },
};

type LightColors = {
  core: [number, number, number];
  mid: [number, number, number];
  far: [number, number, number];
  exposure: number;
};

// Colors reach the shader in linear light, so the crossfade lerps in linear space.
function hexToLinear(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [
    Math.pow(((v >> 16) & 255) / 255, 2.2),
    Math.pow(((v >> 8) & 255) / 255, 2.2),
    Math.pow((v & 255) / 255, 2.2),
  ];
}

function toLinear(name: PaletteName): LightColors {
  const p = LIGHT_PALETTES[name];
  return {
    core: hexToLinear(p.core),
    mid: hexToLinear(p.mid),
    far: hexToLinear(p.far),
    exposure: p.exposure,
  };
}

function mixColors(a: LightColors, b: LightColors, k: number): LightColors {
  const mix3 = (
    u: [number, number, number],
    v: [number, number, number],
  ): [number, number, number] => [
    u[0] + (v[0] - u[0]) * k,
    u[1] + (v[1] - u[1]) * k,
    u[2] + (v[2] - u[2]) * k,
  ];
  return {
    core: mix3(a.core, b.core),
    mid: mix3(a.mid, b.mid),
    far: mix3(a.far, b.far),
    exposure: a.exposure + (b.exposure - a.exposure) * k,
  };
}

// No template interpolation: `npx vgpu check` validates this exact string (next build never does).
const LIGHT_WGSL = /* wgsl */ `
struct Params {
  frame: vec4f,   // x,y canvas size in physical px; z time in seconds; w unused
  core: vec4f,    // rgb core hue in linear light; a exposure
  mid: vec4f,     // rgb mid hue in linear light; a unused
  far: vec4f,     // rgb far tint in linear light; a unused
  pointer: vec4f, // x,y smoothed pointer in [-1,1], y up; z pointer energy; w unused
}
@group(0) @binding(0) var<uniform> params: Params;

// #fdfcfc (the page canvas) in linear light. Must match the paper exactly: the
// acceptance test is that far corners are indistinguishable from the page.
const PAPER_LIN = vec3f(0.9829, 0.9742, 0.9742);
// The documented staging: a stage light at the center of the bottom border, just
// outside the panel (top-origin uv, v grows downward).
const LIGHT_UV = vec2f(0.5, 1.02);

// Falloff, in panel-height units so the light has a fixed physical size at every
// aspect ratio. The soft core kills the inverse-square singularity; the wide
// gaussian ambient term carries a faint tint all the way to the corners.
const SOFT_CORE = 0.21;
const I_NEAR = 0.19;
const I_FAR = 0.10;
const SIGMA_FAR = 1.55;
// Tint ceiling: paper always shows through, even at the core.
const W_MAX = 0.82;

// Hue-vs-distance bands, mirroring the CSS stop structure: hot core, saturated
// mid, pale far tint.
const MID_IN = 0.05;
const MID_OUT = 0.55;
const FAR_IN = 0.55;
const FAR_OUT = 1.45;

// Illustration cadence: slow and calm. A breath every 8 seconds, two counter-
// drifting shimmer lobes (roughly 48s and 70s per revolution), and a gentle lean
// toward the pointer.
const BREATH_PERIOD = 8.0;
const BREATH_AMP = 0.035;
const SHIMMER_AMP = 0.015;
const POINTER_SWAY = 0.05;
const POINTER_LIFT = 0.05;

// Dither gain in 1/255 steps: kills quantization banding on the long ramps.
const DITHER_GAIN = 2.0;
// Paper grain: a static two-octave hash modulating the light weight itself, so
// the glow carries a fine tooth (the house grain-gradient signature) while the
// far paper stays clean. Amplitude is a fraction of w, never additive.
const GRAIN_AMP = 0.14;

// Interleaved gradient noise (Jimenez 2014). Deliberately time-independent:
// static hash grain reads as paper; animated grain reads as film flicker.
fn ign(p: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}

// Sine-free 2D hash (Dave Hoskins): stable in f32 at device-pixel coordinates,
// where fract(sin(...)) hashes band on some GPUs.
fn hash12(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn encode_srgb(c: vec3f) -> vec3f {
  return pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.2));
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let res = params.frame.xy;
  let t = params.frame.z;
  let aspect = res.x / res.y;

  // The light leans a few percent of the panel width toward the pointer.
  let sway = params.pointer.x * POINTER_SWAY * params.pointer.z;
  let light = vec2f(LIGHT_UV.x + sway, LIGHT_UV.y);

  // Aspect-corrected offset in panel-height units.
  let p = vec2f((uv.x - light.x) * aspect, uv.y - light.y);
  var d = length(p);

  // Organic shimmer: two low-order angular lobes drifting in opposite
  // directions. No flicker, no lava lamp. p.y <= -0.02 inside the panel, so
  // atan2 is stable.
  let ang = atan2(p.x, -p.y);
  let shimmer = sin(ang * 3.0 + t * 0.13) * 0.6 + sin(ang * 5.0 - t * 0.09) * 0.4;
  d = d * (1.0 + SHIMMER_AMP * shimmer);

  // Breathing, plus a small lift while the pointer is over the panel.
  let breath = 1.0 + BREATH_AMP * sin(t * 6.2831853 / BREATH_PERIOD)
    + POINTER_LIFT * params.pointer.z;

  // Radiance: physically-plausible point term plus wide ambient, in linear HDR.
  let e_near = I_NEAR / (d * d + SOFT_CORE * SOFT_CORE);
  let e_far = I_FAR * exp(-(d * d) / (SIGMA_FAR * SIGMA_FAR));
  let radiance = (e_near + e_far) * breath;

  // Exponential film shoulder saturating toward W_MAX. Never a hard clamp: a
  // min() would leave a flat disc with a visible crease at the core.
  let w = W_MAX * (1.0 - exp(-params.core.a * radiance / W_MAX));

  // Paper grain: two octaves of static hash (2 and 4 device-px cells) etch a
  // fine tooth into the glow. Multiplying w keeps corners and paper clean.
  let cell = floor(uv * res * 0.5);
  let grain = hash12(cell) * 0.62 + hash12(cell * 0.5 + vec2f(37.0, 17.0)) * 0.38;
  let wg = w * (1.0 + GRAIN_AMP * (grain - 0.5));

  // Hue cools with distance, mixed in linear light.
  var tint = mix(params.core.rgb, params.mid.rgb, smoothstep(MID_IN, MID_OUT, d));
  tint = mix(tint, params.far.rgb, smoothstep(FAR_IN, FAR_OUT, d));

  // Light over paper; opaque out. The swapchain view is non-sRGB (WebGPU's
  // preferred canvas formats), so encode manually, then dither in output space
  // right before 8-bit quantization.
  let lin = mix(PAPER_LIN, tint, wg);
  var srgb = encode_srgb(lin) + vec3f((ign(uv * res) - 0.5) * (DITHER_GAIN / 255.0));
  return vec4f(clamp(srgb, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

export type LightWash = {
  setPalette: (name: PaletteName) => void;
  setPointer: (nx: number, ny: number) => void;
  setPointerActive: (active: boolean) => void;
  start: () => void;
  stop: () => void;
  destroy: () => void;
};

export function createLightWash(
  canvas: HTMLCanvasElement,
  options: {
    palette: PaletteName;
    reducedMotion?: boolean;
    /** Fires once, after the first frame is on screen. */
    onReady?: () => void;
  },
): LightWash {
  const reduced = options.reducedMotion ?? false;

  let disposed = false;
  let shouldRun = false;
  let running = false;

  let gpu: Gpu | undefined;
  let canvasSurface: Surface | undefined;
  let fx: Effect | undefined;
  let time: Clock | undefined;
  let loop: FrameLoopHandle | undefined;
  let unsubResize: (() => void) | undefined;

  let paletteFrom = toLinear(options.palette);
  let paletteTo = paletteFrom;
  let paletteStart = -1e9;

  let targetX = 0;
  let targetY = 0;
  let targetEnergy = 0;
  let px = 0;
  let py = 0;
  let energy = 0;

  const fadeK = (now: number) =>
    Math.min(Math.max((now - paletteStart) / PALETTE_FADE_MS, 0), 1);

  const stepPointer = () => {
    const dt = Math.min(time?.deltaTime || 1 / 60, 0.1);
    const kp = 1 - Math.exp(-dt * POINTER_FOLLOW);
    px += (targetX - px) * kp;
    py += (targetY - py) * kp;
    const ke =
      1 -
      Math.exp(-dt * (targetEnergy > energy ? ENERGY_ATTACK : ENERGY_RELEASE));
    energy += (targetEnergy - energy) * ke;
  };

  const applyUniforms = () => {
    const s = canvasSurface;
    const e = fx;
    if (!s || !e) return;
    const cur = mixColors(paletteFrom, paletteTo, fadeK(performance.now()));
    const [w, h] = s.size;
    e.set({
      params: {
        frame: [w, h, reduced ? FROZEN_T : (time?.time ?? 0), 0],
        core: [...cur.core, cur.exposure],
        mid: [...cur.mid, 0],
        far: [...cur.far, 0],
        pointer: [px, py, energy, 0],
      },
    });
  };

  const renderOnce = (): Promise<void> | undefined => {
    const g = gpu;
    const s = canvasSurface;
    const e = fx;
    if (!g || !s || !e) return undefined;
    applyUniforms();
    let done: Promise<void> | undefined;
    frame(g, (f) => {
      f.pass(s, e);
      done = f.done;
    });
    return done;
  };

  const startLoop = () => {
    const g = gpu;
    const s = canvasSurface;
    const e = fx;
    if (!g || !s || !e || running || reduced) return;
    running = true;
    loop = frameLoop(
      g,
      (f) => {
        stepPointer();
        applyUniforms();
        f.pass(s, e);
      },
      { fps: FPS },
    );
  };

  const stopLoop = () => {
    running = false;
    loop?.stop();
    loop = undefined;
  };

  void (async () => {
    let g: Gpu;
    try {
      g = await init();
    } catch {
      // No WebGPU here: the CSS washes stay as the rendering, silently.
      return;
    }
    if (disposed) {
      g.dispose();
      return;
    }
    gpu = g;
    try {
      const s = surface(g, canvas, { dpr: [1, 2] });
      const e = effect(g, LIGHT_WGSL, { label: "light-wash" });
      canvasSurface = s;
      fx = e;
      time = clock(g);
      unsubResize = s.onResize(() => {
        // Resize callbacks land inside a frame boundary, where a synchronous frame() would throw.
        requestAnimationFrame(() => {
          if (!disposed && !running) renderOnce();
        });
      });
      // Await the frame's own done promise, not requestAnimationFrame: rAF never fires
      // in an occluded window, and readiness must not depend on visibility.
      await renderOnce();
      if (!disposed) options.onReady?.();
      if (shouldRun && !reduced) startLoop();
    } catch (err) {
      // A failure after init is a bug worth surfacing; the CSS washes still cover the visuals.
      console.error("light-wash:", err);
      g.dispose();
      gpu = undefined;
    }
  })();

  return {
    // Mirrors TraceField.setPalette: fading from the mid-fade color means rapid clicks never snap.
    setPalette(name) {
      const now = performance.now();
      paletteFrom = mixColors(paletteFrom, paletteTo, fadeK(now));
      paletteTo = toLinear(name);
      paletteStart = reduced || !running ? now - PALETTE_FADE_MS : now;
      if (reduced || !running) renderOnce();
    },
    setPointer(nx, ny) {
      if (reduced) return;
      targetX = Math.max(-1, Math.min(1, nx));
      targetY = Math.max(-1, Math.min(1, ny));
      targetEnergy = 1;
    },
    setPointerActive(active) {
      if (reduced) return;
      targetEnergy = active ? 1 : 0;
    },
    start() {
      shouldRun = true;
      startLoop();
    },
    stop() {
      shouldRun = false;
      stopLoop();
    },
    destroy() {
      disposed = true;
      shouldRun = false;
      stopLoop();
      unsubResize?.();
      unsubResize = undefined;
      fx = undefined;
      canvasSurface = undefined;
      time = undefined;
      gpu?.dispose();
      gpu = undefined;
    },
  };
}
