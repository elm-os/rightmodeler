// The trace field: a bespoke WebGL1 particle engine for the numbers band. One cloud of
// "trace" particles reorganizes into a diagram per stat: confluence (many formats, one
// schema), descent (cost stepping down), ring (quality holding), slipstream (speed).
// No dependencies, ~one draw call per layer (lines then points).
//
// Why hand-rolled: Stripe's stats scene, which this band answers, is itself raw WebGL
// (custom GLSL, no three.js in that scene), and this repo's rule is minimum code over
// speculative dependencies. All motion is closed-form on the GPU: the vertex shader
// evaluates position(progress, time) twice, once at now and once a beat earlier, and
// draws the segment between the two, so comet trails fall out of the math with zero
// per-frame CPU work. On a retarget mid-flight the CPU mirrors the same math once to
// snapshot current positions, which keeps every transition interruptible.
//
// Coordinates: x in [-aspect, aspect], y in [-1, 1], y up. The canvas is transparent;
// the section supplies the paper wash behind it.

export type PaletteName = "duet" | "violet" | "ember" | "dawn";
export type ShapeName = "confluence" | "descent" | "ring" | "slipstream";

export const SHAPE_ORDER: ShapeName[] = [
  "confluence",
  "descent",
  "ring",
  "slipstream",
];

// Illustration-only accent recipes (docs/design.md: accents never touch UI chrome).
// Stops run along the gradient axis; wash tints the CSS backdrop behind the canvas.
export const PALETTES: Record<
  PaletteName,
  { label: string; stops: [string, string, string]; wash: [string, string] }
> = {
  duet: {
    label: "Duet",
    stops: ["#0447ff", "#7a5cff", "#ff4704"],
    wash: ["#0447ff", "#ff4704"],
  },
  violet: {
    label: "Violet",
    stops: ["#0447ff", "#5f7bff", "#a5b6ff"],
    wash: ["#0447ff", "#6f86ff"],
  },
  ember: {
    label: "Ember",
    stops: ["#e63c00", "#ff6a2e", "#ffb488"],
    wash: ["#ff4704", "#ff7a45"],
  },
  dawn: {
    label: "Dawn",
    stops: ["#6f5ae8", "#b58fd6", "#ff8c52"],
    wash: ["#b3aaff", "#ffc4a0"],
  },
};

// Motion constants, tuned against the harness. The morph is deliberately slower than
// UI motion (it is illustration, not interface): a 1.5s flight with a third of the
// window spent on per-particle stagger reads as one coherent wave.
const MORPH_MS = 1500;
const STAGGER_SPAN = 0.42;
const TRAIL_SECONDS = 0.085; // two-time evaluation gap while in flight
const PALETTE_FADE_MS = 450;
const MAX_DPR = 2;

// --- tiny deterministic rng ------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- shape generators ------------------------------------------------------------
// Each returns, per particle: position, unit-tangent angle, and an assembly order in
// [0, 1) that choreographs how the shape gathers (its own entrance direction).

type ShapePoint = {
  x: number;
  y: number;
  tangent: number;
  order: number;
};

function cubic(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const u = 1 - t;
  return (
    u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
  );
}

function cubicTangent(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const u = 1 - t;
  return 3 * u * u * (p1 - p0) + 6 * u * t * (p2 - p1) + 3 * t * t * (p3 - p2);
}

// Ten tributaries braid into one bright spine: the autodetected formats becoming one
// per-step schema. Assembly sweeps left to right, the way a trace flows in.
function confluence(n: number, a: number, rand: () => number): ShapePoint[] {
  const pts: ShapePoint[] = [];
  const streams = 10;
  const joinX = -0.06 * a;
  const spineEndX = 0.88 * a;
  const sourceX = -0.92 * a;
  const spineShare = 0.42;
  const ys: number[] = [];
  for (let i = 0; i < streams; i++) {
    const t = i / (streams - 1);
    ys.push((t - 0.5) * 1.62 + (rand() - 0.5) * 0.05);
  }
  // The spine carries a slow meander so the braid reads as a river, not a ruler.
  const meander = (s: number) => Math.sin(s * 2.6 + 0.4) * 0.05;
  for (let i = 0; i < n; i++) {
    const onSpine = rand() < spineShare;
    if (onSpine) {
      const s = rand();
      const x = joinX + (spineEndX - joinX) * s;
      const decay = Math.exp(-s * 2.6);
      const braid =
        Math.sin(s * 17 + rand() * Math.PI * 2) * 0.04 * (0.3 + decay);
      const y = meander(s) + braid + (rand() - 0.5) * 0.045 * (0.35 + decay);
      const slope =
        (meander(s + 0.01) - meander(s)) / ((spineEndX - joinX) * 0.01);
      pts.push({
        x,
        y,
        tangent: Math.atan2(slope + (rand() - 0.5) * 0.1, 1),
        order: 0.55 + s * 0.45,
      });
    } else {
      const lane = Math.floor(rand() * streams);
      const y0 = ys[lane];
      // Streams release before the join at staggered depths, so the mouth is a soft
      // interleave rather than a knot.
      const release = 0.9 + rand() * 0.1;
      const s = Math.pow(rand(), 0.8) * release;
      const joinXi = joinX + (rand() - 0.5) * 0.06 * a;
      const p1x = sourceX + (joinXi - sourceX) * 0.5;
      const p2x = sourceX + (joinXi - sourceX) * 0.85;
      const x = cubic(sourceX, p1x, p2x, joinXi, s);
      const y =
        cubic(y0, y0 * 0.96, y0 * 0.28, meander(0), s) + (rand() - 0.5) * 0.03;
      const dx = cubicTangent(sourceX, p1x, p2x, joinXi, s);
      const dy = cubicTangent(y0, y0 * 0.96, y0 * 0.28, meander(0), s);
      pts.push({
        x,
        y,
        tangent: Math.atan2(dy, dx),
        order: s * 0.55,
      });
    }
  }
  return pts;
}

// The bill stepping down: a five-tread staircase, one tread per approved step, the
// first drop the steepest, the way the savings actually land. Dense horizontal treads,
// sparse vertical falls, and a settled pool at the foot. Assembly walks down the stairs.
function descent(n: number, a: number, rand: () => number): ShapePoint[] {
  const pts: ShapePoint[] = [];
  const x0 = -0.84 * a;
  const x1 = 0.8 * a;
  const treads = 5;
  // Cumulative heights: a steep first saving, then diminishing returns.
  const drops = [0, 0.42, 0.68, 0.85, 0.96];
  const yTop = 0.58;
  const ySpan = 1.14;
  const treadW = (x1 - x0) / treads;
  const poolShare = 0.12;
  const fallShare = 0.1;
  for (let i = 0; i < n; i++) {
    const roll = rand();
    if (roll < poolShare) {
      // the landing: a loose sediment mound settling under the last tread
      const spread = (rand() + rand() + rand()) / 3 - 0.5;
      const depth = Math.pow(rand(), 1.7);
      pts.push({
        x: x1 - treadW * 0.55 + spread * treadW * 1.5,
        y:
          yTop -
          ySpan * drops[treads - 1] -
          0.045 -
          depth * 0.12 * (1 - Math.abs(spread)),
        tangent: (rand() - 0.5) * 0.5,
        order: 0.88 + rand() * 0.12,
      });
      continue;
    }
    if (roll < poolShare + fallShare) {
      // a fall between two treads
      const step = 1 + Math.floor(rand() * (treads - 1));
      const yA = yTop - ySpan * drops[step - 1];
      const yB = yTop - ySpan * drops[step];
      const v = rand();
      pts.push({
        x: x0 + treadW * step + (rand() - 0.5) * 0.014 * a,
        y: yA + (yB - yA) * v,
        tangent: -Math.PI / 2,
        order: ((step - 1) / treads) * 0.85 + 0.09,
      });
      continue;
    }
    // a tread
    const step = Math.floor(rand() * treads);
    const u = rand();
    pts.push({
      x: x0 + treadW * (step + u) + (rand() - 0.5) * 0.01 * a,
      y: yTop - ySpan * drops[step] + (rand() - 0.5) * 0.035,
      tangent: (rand() - 0.5) * 0.06,
      order: ((step + u) / treads) * 0.85,
    });
  }
  return pts;
}

// Quality holding at the benchmark: one complete, unbroken circle, with a faint inner
// echo and a little dust. Points are spaced by arc length so the rim reads evenly, and
// assembly sweeps around the circumference like a gauge closing to full.
function ring(n: number, a: number, rand: () => number): ShapePoint[] {
  const pts: ShapePoint[] = [];
  const cx = 0;
  const cy = 0.03;
  const R = 0.6;
  const stretch = 1.35;
  // Uniform-by-arc-length lookup for the ellipse (x = stretch R cos, y = R sin).
  const STEPS = 512;
  const cum = new Float32Array(STEPS + 1);
  for (let i = 1; i <= STEPS; i++) {
    const t0 = ((i - 1) / STEPS) * Math.PI * 2;
    const t1 = (i / STEPS) * Math.PI * 2;
    const dx = stretch * R * (Math.cos(t1) - Math.cos(t0));
    const dy = R * (Math.sin(t1) - Math.sin(t0));
    cum[i] = cum[i - 1] + Math.hypot(dx, dy);
  }
  const total = cum[STEPS];
  const angleAt = (s: number) => {
    const target = s * total;
    let lo = 0;
    let hi = STEPS;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const seg = Math.max(lo, 1);
    const frac =
      (target - cum[seg - 1]) / Math.max(cum[seg] - cum[seg - 1], 1e-6);
    return ((seg - 1 + frac) / STEPS) * Math.PI * 2;
  };
  const place = (radius: number, jitter: number) => {
    const ang = angleAt(rand());
    const r = radius + (rand() - 0.5) * jitter;
    // tangent of the ellipse, not the circle, so strokes hug the rim
    const tx = -stretch * Math.sin(ang);
    const ty = Math.cos(ang);
    return {
      x: cx + Math.cos(ang) * r * stretch,
      y: cy + Math.sin(ang) * r,
      tangent: Math.atan2(ty, tx),
      order: ((ang / (Math.PI * 2) + 0.25) % 1) * 0.9,
    };
  };
  for (let i = 0; i < n; i++) {
    const roll = rand();
    if (roll < 0.9) {
      // one complete rim, nothing broken about it
      pts.push(place(R, 0.02));
    } else {
      const ang = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * 0.4;
      pts.push({
        x: cx + Math.cos(ang) * r * stretch,
        y: cy + Math.sin(ang) * r,
        tangent: rand() * Math.PI * 2,
        order: rand(),
      });
    }
  }
  return pts;
}

// Right-sized and faster: lanes of comet streaks all surging one way, bright tight
// heads and long dissolving tails. Lanes launch in a loose stagger, heads first.
function slipstream(n: number, a: number, rand: () => number): ShapePoint[] {
  const pts: ShapePoint[] = [];
  const lanes = 13;
  const laneY: number[] = [];
  const laneHead: number[] = [];
  const laneLen: number[] = [];
  const laneOrd: number[] = [];
  for (let i = 0; i < lanes; i++) {
    const t = i / (lanes - 1);
    const centered = 1 - Math.abs(t - 0.5) * 2;
    laneY.push((t - 0.5) * 1.56 + (rand() - 0.5) * 0.05);
    laneHead.push((0.3 + rand() * 0.55) * a * (0.62 + centered * 0.38));
    laneLen.push((0.75 + rand() * 0.5) * a);
    laneOrd.push(rand());
  }
  for (let i = 0; i < n; i++) {
    const lane = Math.floor(rand() * lanes);
    if (rand() < 0.18) {
      // the comet head: a tight bright cluster just behind the leading edge
      const r = Math.pow(rand(), 1.6) * 0.05 * a;
      pts.push({
        x: laneHead[lane] - r,
        y: laneY[lane] + (rand() - 0.5) * 0.022,
        tangent: (rand() - 0.5) * 0.04,
        order: laneOrd[lane] * 0.35,
      });
      continue;
    }
    const back = Math.pow(rand(), 2.4);
    const x = laneHead[lane] - 0.05 * a - back * laneLen[lane];
    const y = laneY[lane] + (rand() - 0.5) * 0.02 * (0.5 + back * 2.4);
    pts.push({
      x,
      y,
      tangent: (rand() - 0.5) * 0.05,
      order: laneOrd[lane] * 0.35 + back * 0.65,
    });
  }
  return pts;
}

// Loose paper dust: the pre-entrance state the intro gathers from.
function scatter(n: number, a: number, rand: () => number): ShapePoint[] {
  const pts: ShapePoint[] = [];
  for (let i = 0; i < n; i++) {
    pts.push({
      x: (rand() * 2 - 1) * a * 0.96,
      y: (rand() * 2 - 1) * 0.92,
      tangent: rand() * Math.PI * 2,
      order: rand(),
    });
  }
  return pts;
}

const GENERATORS = [confluence, descent, ring, slipstream, scatter];
const SCATTER_INDEX = 4;

// --- shared math, mirrored between GLSL and the JS snapshot ----------------------

function easeInOutCubic(p: number): number {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

// Per-shape ambient drift so a settled diagram keeps breathing. Mirrored in GLSL;
// change one, change both. `tang` is the structural tangent angle.
function ambientJs(
  shape: number,
  x: number,
  y: number,
  tang: number,
  seed: number,
  t: number,
): [number, number] {
  const ph = seed * 6.2832;
  if (shape === 0) {
    // confluence: creep along the flow
    const c = Math.cos(tang);
    const s = Math.sin(tang);
    const w = Math.sin(t * 0.7 + ph) * 0.008;
    return [c * w + Math.sin(t * 0.53 + ph * 2) * 0.0035, s * w];
  }
  if (shape === 1) {
    // descent: slow slide downhill
    const w = Math.sin(t * 0.6 + ph) * 0.007;
    return [w * 0.6, -Math.abs(w) * 0.5 + Math.sin(t * 0.41 + ph) * 0.004];
  }
  if (shape === 2) {
    // ring: lockstep orbit plus a faint breath
    const ang = Math.atan2(y - 0.03, x / 1.35);
    const wob = Math.sin(t * 0.32 + ph) * 0.004;
    const orbit = t * 0.06 + wob;
    const r = Math.hypot(x / 1.35, y - 0.03);
    const nx = Math.cos(ang + orbit * 0.13) * r * 1.35;
    const ny = 0.03 + Math.sin(ang + orbit * 0.13) * r;
    return [nx - x + wob * Math.cos(ang), ny - y + wob * Math.sin(ang)];
  }
  if (shape === 3) {
    // slipstream: perpetual surge
    const w = Math.sin(t * 1.1 + ph) * 0.5 + 0.5;
    return [w * 0.02 + Math.sin(t * 0.9 + ph * 3) * 0.004, 0];
  }
  // scatter: aimless drift
  return [Math.sin(t * 0.4 + ph) * 0.01, Math.cos(t * 0.31 + ph * 2) * 0.01];
}

type FlightUniforms = {
  progress: number;
  fromShape: number;
  toShape: number;
  fromAmbientK: number;
  focusX: number;
  focusY: number;
};

// Head position at (progress, time) for one particle: the JS twin of the GLSL below,
// used once per retarget to snapshot an in-flight cloud.
function positionJs(
  fx: number,
  fy: number,
  fTang: number,
  tx: number,
  ty: number,
  tTang: number,
  tOrder: number,
  seed: number,
  u: FlightUniforms,
  time: number,
): { x: number; y: number; tang: number } {
  const window = 1 - STAGGER_SPAN;
  const p = Math.min(
    Math.max((u.progress - tOrder * STAGGER_SPAN) / window, 0),
    1,
  );
  const e = easeInOutCubic(p);
  let x = fx + (tx - fx) * e;
  let y = fy + (ty - fy) * e;
  const dx = tx - fx;
  const dy = ty - fy;
  const dist = Math.hypot(dx, dy);
  if (dist > 1e-5) {
    const arc = Math.sin(e * Math.PI);
    const side = seed < 0.5 ? -1 : 1;
    const px = (-dy / dist) * side;
    const py = (dx / dist) * side;
    const amp = 0.26 * arc * Math.min(dist, 1.1) * (0.35 + seed * 0.65);
    x += px * amp;
    y += py * amp;
    x += (u.focusX - (fx + tx) * 0.5) * arc * 0.16;
    y += (u.focusY - (fy + ty) * 0.5) * arc * 0.16;
  }
  const [ax0, ay0] = ambientJs(u.fromShape, x, y, fTang, seed, time);
  const [ax1, ay1] = ambientJs(u.toShape, x, y, tTang, seed, time);
  x += ax0 * (1 - e) * u.fromAmbientK + ax1 * e;
  y += ay0 * (1 - e) * u.fromAmbientK + ay1 * e;
  const c0 = Math.cos(fTang);
  const s0 = Math.sin(fTang);
  const c1 = Math.cos(tTang);
  const s1 = Math.sin(tTang);
  const tc = c0 + (c1 - c0) * e;
  const ts = s0 + (s1 - s0) * e;
  return { x, y, tang: Math.atan2(ts, tc) };
}

// --- GLSL ------------------------------------------------------------------------

// Vertex chunk. highp is mandatory in WebGL1 vertex shaders and required here: the
// order+tangent packing in a_*.w needs ~20 mantissa bits, far beyond fp16 mediump.
const SHARED_GLSL = `
precision highp float;

attribute vec4 a_from;   // xyz unused z, w packs floor(order*1023) + tangent01
attribute vec4 a_to;
attribute vec4 a_meta;   // seed, sizeScale, alphaScale, endFlag (0 head / 1 tail)

uniform vec2  u_scale;     // 1/aspect, 1 (plus zoom)
uniform vec2  u_shift;     // parallax
uniform float u_progress;
uniform float u_progressPrev;
uniform float u_time;
uniform float u_timePrev;
uniform float u_fromShape;
uniform float u_toShape;
uniform float u_fromAmbientK; // 0 while a_from is a snapshot with ambient baked in
uniform vec2  u_focus;
uniform float u_stroke;    // structural stroke length
uniform float u_alpha;     // global fade
uniform vec3  u_colA;
uniform vec3  u_colB;
uniform vec3  u_colC;
uniform vec2  u_gradDir;
uniform float u_pixelScale; // dpr for point sizing

varying vec4 v_color;

float easeInOut(float p) {
  return p < 0.5 ? 4.0 * p * p * p : 1.0 - pow(-2.0 * p + 2.0, 3.0) / 2.0;
}

vec2 ambient(float shape, vec2 pos, float tang, float seed, float t) {
  float ph = seed * 6.2832;
  if (shape < 0.5) {
    float w = sin(t * 0.7 + ph) * 0.008;
    return vec2(cos(tang) * w + sin(t * 0.53 + ph * 2.0) * 0.0035, sin(tang) * w);
  } else if (shape < 1.5) {
    float w = sin(t * 0.6 + ph) * 0.007;
    return vec2(w * 0.6, -abs(w) * 0.5 + sin(t * 0.41 + ph) * 0.004);
  } else if (shape < 2.5) {
    float ang = atan(pos.y - 0.03, pos.x / 1.35);
    float wob = sin(t * 0.32 + ph) * 0.004;
    float orbit = t * 0.06 + wob;
    float r = length(vec2(pos.x / 1.35, pos.y - 0.03));
    vec2 np = vec2(cos(ang + orbit * 0.13) * r * 1.35, 0.03 + sin(ang + orbit * 0.13) * r);
    return np - pos + wob * vec2(cos(ang), sin(ang));
  } else if (shape < 3.5) {
    float w = sin(t * 1.1 + ph) * 0.5 + 0.5;
    return vec2(w * 0.02 + sin(t * 0.9 + ph * 3.0) * 0.004, 0.0);
  }
  return vec2(sin(t * 0.4 + ph) * 0.01, cos(t * 0.31 + ph * 2.0) * 0.01);
}

// order in x, tangent in y
vec2 unpack(float w) {
  return vec2(floor(w) / 1023.0, fract(w) * 6.2832);
}

vec3 flight(float progress, float t) {
  vec2 f = a_from.xy;
  vec2 to = a_to.xy;
  vec2 fw = unpack(a_from.w);
  vec2 tw = unpack(a_to.w);
  float seed = a_meta.x;

  float p = clamp((progress - tw.x * ${STAGGER_SPAN.toFixed(3)}) / ${(1 - STAGGER_SPAN).toFixed(3)}, 0.0, 1.0);
  float e = easeInOut(p);
  vec2 pos = mix(f, to, e);

  vec2 d = to - f;
  float dist = length(d);
  if (dist > 1e-5) {
    float arc = sin(e * 3.14159);
    float side = seed < 0.5 ? -1.0 : 1.0;
    vec2 perp = vec2(-d.y, d.x) / dist * side;
    float amp = 0.26 * arc * min(dist, 1.1) * (0.35 + seed * 0.65);
    pos += perp * amp;
    pos += (u_focus - (f + to) * 0.5) * arc * 0.16;
  }

  // Both ambients read the same pre-ambient position (the JS mirror does the same),
  // and the from-side is dropped entirely when a_from already has ambient baked in.
  vec2 amb0 = ambient(u_fromShape, pos, fw.y, seed, t);
  vec2 amb1 = ambient(u_toShape, pos, tw.y, seed, t);
  pos += amb0 * (1.0 - e) * u_fromAmbientK + amb1 * e;

  vec2 tanv = normalize(mix(vec2(cos(fw.y), sin(fw.y)), vec2(cos(tw.y), sin(tw.y)), e) + vec2(1e-4));
  return vec3(pos, atan(tanv.y, tanv.x));
}

vec4 shade(vec2 pos, float seed, float alphaScale) {
  float g = clamp(dot(pos, u_gradDir) * 0.34 + 0.5 + (seed - 0.5) * 0.22, 0.0, 1.0);
  vec3 col = g < 0.5 ? mix(u_colA, u_colB, g * 2.0) : mix(u_colB, u_colC, g * 2.0 - 1.0);
  return vec4(col, alphaScale);
}
`;

const LINE_VERT = `${SHARED_GLSL}
void main() {
  vec3 head = flight(u_progress, u_time);
  vec3 back = flight(u_progressPrev, u_timePrev);
  vec2 motion = head.xy - back.xy;
  float speed = length(motion);
  // Structural stroke along the local tangent while settled; the comet trail takes
  // over as soon as the particle is actually moving.
  float strokeK = 1.0 - clamp(speed * 26.0, 0.0, 1.0);
  vec2 stroke = vec2(cos(head.z), sin(head.z)) * u_stroke * (0.7 + a_meta.x * 0.5) * strokeK;
  vec2 trail = motion * (1.7 + a_meta.x * 1.2);
  float trailLen = length(trail);
  if (trailLen > 0.34) trail *= 0.34 / trailLen;
  vec2 tail = head.xy - stroke - trail;

  vec2 pos = mix(head.xy, tail, a_meta.w);
  gl_Position = vec4((pos + u_shift) * u_scale, 0.0, 1.0);

  vec4 c = shade(head.xy, a_meta.x, a_meta.z);
  float endFade = 1.0 - a_meta.w * 0.92;
  v_color = vec4(c.rgb, c.a * endFade * 0.5 * u_alpha);
}
`;

const POINT_VERT = `${SHARED_GLSL}
void main() {
  vec3 head = flight(u_progress, u_time);
  gl_Position = vec4((head.xy + u_shift) * u_scale, 0.0, 1.0);
  gl_PointSize = (1.6 + a_meta.y * 2.1) * u_pixelScale;
  vec4 c = shade(head.xy, a_meta.x, a_meta.z);
  v_color = vec4(c.rgb, c.a * 0.92 * u_alpha);
}
`;

const LINE_FRAG = `
precision mediump float;
varying vec4 v_color;
void main() {
  gl_FragColor = vec4(v_color.rgb * v_color.a, v_color.a);
}
`;

const POINT_FRAG = `
precision mediump float;
varying vec4 v_color;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.32, d) * v_color.a;
  gl_FragColor = vec4(v_color.rgb * a, a);
}
`;

// --- engine ----------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    // Surfacing the log matters more than gracefulness here: a silent blank canvas is
    // the one failure mode this component must never ship.
    console.error("trace-field shader:", gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

function link(gl: WebGLRenderingContext, vert: string, frag: string) {
  const v = compile(gl, gl.VERTEX_SHADER, vert);
  const f = compile(gl, gl.FRAGMENT_SHADER, frag);
  if (!v || !f) return null;
  const p = gl.createProgram();
  if (!p) return null;
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error("trace-field link:", gl.getProgramInfoLog(p));
    return null;
  }
  return p;
}

export type TraceField = {
  setShape: (index: number) => void;
  setPalette: (name: PaletteName) => void;
  setPointer: (nx: number, ny: number) => void;
  start: () => void;
  stop: () => void;
  destroy: () => void;
  /** Render one settled frame (reduced-motion path). */
  renderStatic: () => void;
};

export function createTraceField(
  canvas: HTMLCanvasElement,
  options: {
    palette?: PaletteName;
    reducedMotion?: boolean;
    /** Start on this shape without the scatter intro (reduced motion). */
    initialShape?: number;
  } = {},
): TraceField | null {
  const glMaybe = canvas.getContext("webgl", {
    alpha: true,
    antialias: true,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    powerPreference: "low-power",
  });
  if (!glMaybe) return null;
  const gl = glMaybe;

  const reduced = options.reducedMotion ?? false;

  // Particle count scales with rendered area, clamped for phones and 5K monitors alike.
  const rect = canvas.getBoundingClientRect();
  const area = Math.max(rect.width * rect.height, 1);
  const count = Math.round(Math.min(1500, Math.max(520, area / 700)));
  let aspect = Math.max(rect.width / Math.max(rect.height, 1), 0.1);

  const rand = mulberry32(0x5eed);

  // Static per-particle meta, shared by every shape.
  const seeds = new Float32Array(count);
  const sizes = new Float32Array(count);
  const alphas = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    seeds[i] = rand();
    const big = rand();
    sizes[i] = big < 0.08 ? 1.3 + rand() * 0.9 : 0.25 + rand() * 0.75;
    alphas[i] = 0.45 + rand() * 0.55;
  }

  // Shape target data: vec4 per particle (x, y, 0, packed order+tangent).
  let genAspect = aspect;
  function buildShapes(forAspect: number): Float32Array[] {
    return GENERATORS.map((gen, gi) => {
      const pts = gen(count, forAspect, mulberry32(0xfeed + gi * 7919));
      const arr = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        const p = pts[i];
        const tang01 =
          (((p.tangent % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) /
          (Math.PI * 2);
        arr[i * 4] = p.x;
        arr[i * 4 + 1] = p.y;
        arr[i * 4 + 2] = 0;
        arr[i * 4 + 3] = Math.round(p.order * 1023) + Math.min(tang01, 0.9995);
      }
      return arr;
    });
  }
  let shapeData = buildShapes(genAspect);

  // CPU mirrors of the GPU buffers. The line pass reads two copies of each particle
  // (head + tail flag in meta.w); the point pass reads the head copies with a doubled
  // stride. Keeping these arrays current is what makes context restoration a plain
  // re-upload.
  const fromArr = new Float32Array(count * 8);
  const toArr = new Float32Array(count * 8);
  const metaArr = new Float32Array(count * 8);
  for (let i = 0; i < count; i++) {
    for (const half of [0, 1]) {
      const o = (i * 2 + half) * 4;
      metaArr[o] = seeds[i];
      metaArr[o + 1] = sizes[i];
      metaArr[o + 2] = alphas[i];
      metaArr[o + 3] = half;
    }
  }

  function fillDoubled(dst: Float32Array, src: Float32Array) {
    for (let i = 0; i < count; i++) {
      for (const half of [0, 1]) {
        dst.set(src.subarray(i * 4, i * 4 + 4), (i * 2 + half) * 4);
      }
    }
  }

  let fromShape = SCATTER_INDEX;
  let toShape = options.initialShape ?? 0;
  fillDoubled(fromArr, shapeData[fromShape]);
  fillDoubled(toArr, shapeData[toShape]);

  const UNIFORM_NAMES = [
    "u_scale",
    "u_shift",
    "u_progress",
    "u_progressPrev",
    "u_time",
    "u_timePrev",
    "u_fromShape",
    "u_toShape",
    "u_fromAmbientK",
    "u_focus",
    "u_stroke",
    "u_alpha",
    "u_colA",
    "u_colB",
    "u_colC",
    "u_gradDir",
    "u_pixelScale",
  ] as const;
  type UniformMap = Record<
    (typeof UNIFORM_NAMES)[number],
    WebGLUniformLocation | null
  >;

  type Pass = {
    program: WebGLProgram;
    u: UniformMap;
    attr: { from: number; to: number; meta: number };
  };
  type GlRes = {
    line: Pass;
    point: Pass;
    fromBuf: WebGLBuffer | null;
    toBuf: WebGLBuffer | null;
    metaBuf: WebGLBuffer | null;
  };
  let res: GlRes | null = null;
  let contextLost = false;

  function makePass(vert: string, frag: string): Pass | null {
    const program = link(gl, vert, frag);
    if (!program) return null;
    const u = Object.fromEntries(
      UNIFORM_NAMES.map((n) => [n, gl.getUniformLocation(program, n)]),
    ) as UniformMap;
    return {
      program,
      u,
      attr: {
        from: gl.getAttribLocation(program, "a_from"),
        to: gl.getAttribLocation(program, "a_to"),
        meta: gl.getAttribLocation(program, "a_meta"),
      },
    };
  }

  // Builds every GL-side resource from current CPU state. Runs once at creation and
  // again after webglcontextrestored, so a driver reset never leaves a blank panel.
  function initGL(): boolean {
    const line = makePass(LINE_VERT, LINE_FRAG);
    const point = makePass(POINT_VERT, POINT_FRAG);
    if (!line || !point) return false;
    const fromBuf = gl.createBuffer();
    const toBuf = gl.createBuffer();
    const metaBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, metaBuf);
    gl.bufferData(gl.ARRAY_BUFFER, metaArr, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, fromBuf);
    gl.bufferData(gl.ARRAY_BUFFER, fromArr, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, toBuf);
    gl.bufferData(gl.ARRAY_BUFFER, toArr, gl.DYNAMIC_DRAW);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    res = { line, point, fromBuf, toBuf, metaBuf };
    return true;
  }

  if (!initGL()) return null;

  // Palette state, CPU-lerped over the fade window.
  let paletteFrom = PALETTES[options.palette ?? "duet"].stops.map(hexToRgb);
  let paletteTo = paletteFrom;
  let paletteStart = -1e9;

  // Morph clock. progressAt(t) is what both GPU passes and the JS snapshot use, so
  // trails and retargets always agree with what is on screen.
  let morphStart = 0;
  let intro = !reduced;
  // 1 while a_from holds settled base geometry; 0 while it holds an on-screen
  // snapshot whose ambient displacement is already baked into the positions.
  let fromAmbientK = 1;
  let globalAlpha = reduced ? 1 : 0;
  let lastDrawT = 0;
  let pointerX = 0;
  let pointerY = 0;
  let pointerCurX = 0;
  let pointerCurY = 0;
  let dpr = 1;
  let raf = 0;
  let running = false;
  let now = 0;

  function progressAt(t: number): number {
    const dur = intro ? MORPH_MS * 1.35 : MORPH_MS;
    return Math.min(Math.max((t - morphStart) / dur, 0), 1);
  }

  function resize(t: number) {
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const w = Math.round(r.width * dpr);
    const h = Math.round(r.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    aspect = r.width / Math.max(r.height, 1);
    // Rotation or a drastic reflow reshapes the diagrams themselves. The old
    // geometry (and any in-flight snapshot of it) is meaningless in the new frame,
    // so the flight lands immediately rather than flying to remapped targets.
    if (Math.abs(aspect - genAspect) > 0.25) {
      genAspect = aspect;
      shapeData = buildShapes(genAspect);
      intro = false;
      morphStart = t - MORPH_MS * 2;
      fromAmbientK = 1;
      fromShape = toShape;
      uploadFrom(shapeData[fromShape]);
      uploadTo(toShape);
    }
    gl.viewport(0, 0, w, h);
  }

  function bindPass(pass: Pass, stride: number) {
    if (!res) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, res.fromBuf);
    gl.enableVertexAttribArray(pass.attr.from);
    gl.vertexAttribPointer(pass.attr.from, 4, gl.FLOAT, false, stride, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, res.toBuf);
    gl.enableVertexAttribArray(pass.attr.to);
    gl.vertexAttribPointer(pass.attr.to, 4, gl.FLOAT, false, stride, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, res.metaBuf);
    gl.enableVertexAttribArray(pass.attr.meta);
    gl.vertexAttribPointer(pass.attr.meta, 4, gl.FLOAT, false, stride, 0);
  }

  function setSharedUniforms(
    u: UniformMap,
    t: number,
    progress: number,
    progressPrev: number,
    tPrev: number,
    colors: [number, number, number][],
  ) {
    gl.uniform2f(u.u_scale, 1 / aspect, 1);
    gl.uniform2f(u.u_shift, pointerCurX * 0.05, pointerCurY * 0.035);
    gl.uniform1f(u.u_progress, progress);
    gl.uniform1f(u.u_progressPrev, progressPrev);
    gl.uniform1f(u.u_time, t);
    gl.uniform1f(u.u_timePrev, tPrev);
    gl.uniform1f(u.u_fromShape, fromShape);
    gl.uniform1f(u.u_toShape, toShape);
    gl.uniform1f(u.u_fromAmbientK, fromAmbientK);
    gl.uniform2f(u.u_focus, 0, 0.04);
    gl.uniform1f(u.u_stroke, 0.038);
    gl.uniform1f(u.u_alpha, globalAlpha);
    gl.uniform3f(u.u_colA, colors[0][0], colors[0][1], colors[0][2]);
    gl.uniform3f(u.u_colB, colors[1][0], colors[1][1], colors[1][2]);
    gl.uniform3f(u.u_colC, colors[2][0], colors[2][1], colors[2][2]);
    gl.uniform2f(u.u_gradDir, 0.94, -0.34);
    gl.uniform1f(u.u_pixelScale, dpr);
  }

  function draw(t: number) {
    if (!res || contextLost) return;
    resize(t);
    const frameDt = lastDrawT ? Math.min(t - lastDrawT, 100) : 16;
    lastDrawT = t;
    const progress = progressAt(t);
    const tSec = t / 1000;
    const dt = TRAIL_SECONDS;
    const progressPrev = progressAt(t - dt * 1000);

    const fadeK = Math.min(
      Math.max((t - paletteStart) / PALETTE_FADE_MS, 0),
      1,
    );
    const colors = paletteFrom.map((c, i) => [
      c[0] + (paletteTo[i][0] - c[0]) * fadeK,
      c[1] + (paletteTo[i][1] - c[1]) * fadeK,
      c[2] + (paletteTo[i][2] - c[2]) * fadeK,
    ]) as [number, number, number][];

    if (intro && progress >= 1) intro = false;
    // The fade-in rides its own clock, so an early retarget can neither freeze it
    // below 1 nor pop it to 1 in a single frame.
    if (globalAlpha < 1) globalAlpha = Math.min(1, globalAlpha + frameDt / 650);

    pointerCurX += (pointerX - pointerCurX) * 0.06;
    pointerCurY += (pointerY - pointerCurY) * 0.06;

    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(res.line.program);
    setSharedUniforms(
      res.line.u,
      tSec,
      progress,
      progressPrev,
      tSec - dt,
      colors,
    );
    bindPass(res.line, 0);
    gl.drawArrays(gl.LINES, 0, count * 2);

    gl.useProgram(res.point.program);
    setSharedUniforms(
      res.point.u,
      tSec,
      progress,
      progressPrev,
      tSec - dt,
      colors,
    );
    bindPass(res.point, 32);
    gl.drawArrays(gl.POINTS, 0, count);
  }

  function frame(t: number) {
    now = t;
    draw(t);
    if (running) raf = requestAnimationFrame(frame);
  }

  // Snapshot the in-flight cloud into the from-buffer so a retarget mid-morph
  // continues from exactly what is on screen. Must be called BEFORE any state that
  // feeds progressAt or the ambient blend (intro, fromShape, fromAmbientK) changes.
  function snapshot(t: number) {
    const u: FlightUniforms = {
      progress: progressAt(t),
      fromShape,
      toShape,
      fromAmbientK,
      focusX: 0,
      focusY: 0.04,
    };
    const from = shapeData[fromShape];
    const to = shapeData[toShape];
    const tSec = t / 1000;
    const out = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const fw = from[i * 4 + 3];
      const tw = to[i * 4 + 3];
      const fTang = (fw % 1) * Math.PI * 2;
      const tOrder = Math.floor(tw) / 1023;
      const tTang = (tw % 1) * Math.PI * 2;
      const p = positionJs(
        from[i * 4],
        from[i * 4 + 1],
        fTang,
        to[i * 4],
        to[i * 4 + 1],
        tTang,
        tOrder,
        seeds[i],
        u,
        tSec,
      );
      const tang01 =
        (((p.tang % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) /
        (Math.PI * 2);
      out[i * 4] = p.x;
      out[i * 4 + 1] = p.y;
      out[i * 4 + 3] = Math.floor(fw) + Math.min(tang01, 0.9995);
    }
    return out;
  }

  function uploadFrom(data: Float32Array) {
    fillDoubled(fromArr, data);
    if (!res || contextLost) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, res.fromBuf);
    gl.bufferData(gl.ARRAY_BUFFER, fromArr, gl.DYNAMIC_DRAW);
  }

  function uploadTo(index: number) {
    fillDoubled(toArr, shapeData[index]);
    if (!res || contextLost) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, res.toBuf);
    gl.bufferData(gl.ARRAY_BUFFER, toArr, gl.DYNAMIC_DRAW);
  }

  // Context loss handling. preventDefault opts into restoration; the restored
  // handler rebuilds every GPU resource from the CPU mirrors, honoring this file's
  // own rule that a silent blank canvas must never ship.
  const onContextLost = (e: Event) => {
    e.preventDefault();
    contextLost = true;
    res = null;
  };
  const onContextRestored = () => {
    contextLost = false;
    if (initGL()) {
      draw(performance.now());
    }
  };
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);

  // Under reduced motion no loop runs, so a static frame must be re-rendered
  // whenever layout resizes the canvas; otherwise the last frame stretches.
  let ro: ResizeObserver | null = null;
  if (reduced && typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => draw(performance.now()));
    ro.observe(canvas);
  }

  const field: TraceField = {
    setShape(index) {
      const target = Math.max(0, Math.min(GENERATORS.length - 2, index));
      if (target === toShape && !intro) return;
      const t = now || performance.now();
      if (reduced) {
        fromShape = target;
        toShape = target;
        fromAmbientK = 1;
        uploadFrom(shapeData[target]);
        uploadTo(target);
        morphStart = t - MORPH_MS * 2;
        draw(performance.now());
        return;
      }
      const progress = progressAt(t);
      if (progress >= 1) {
        // settled: previous target becomes the origin, base geometry + live ambient
        fromShape = toShape;
        fromAmbientK = 1;
        uploadFrom(shapeData[fromShape]);
      } else {
        // In flight: freeze the current cloud as the origin. The snapshot must see
        // the intro flag and ambient scale exactly as the last drawn frame did.
        const snap = snapshot(t);
        intro = false;
        uploadFrom(snap);
        fromShape = toShape;
        fromAmbientK = 0;
      }
      toShape = target;
      uploadTo(target);
      morphStart = t;
    },
    setPalette(name) {
      const t = now || performance.now();
      const fadeK = Math.min(
        Math.max((t - paletteStart) / PALETTE_FADE_MS, 0),
        1,
      );
      paletteFrom = paletteFrom.map((c, i) => [
        c[0] + (paletteTo[i][0] - c[0]) * fadeK,
        c[1] + (paletteTo[i][1] - c[1]) * fadeK,
        c[2] + (paletteTo[i][2] - c[2]) * fadeK,
      ]) as [number, number, number][];
      paletteTo = PALETTES[name].stops.map(hexToRgb);
      // Animated when the loop runs; instant when a static frame is all we draw.
      paletteStart = reduced || !running ? t - PALETTE_FADE_MS : t;
      if (reduced || !running) draw(performance.now());
    },
    setPointer(nx, ny) {
      pointerX = nx;
      pointerY = ny;
    },
    start() {
      if (running || reduced) return;
      running = true;
      if (!morphStart) morphStart = performance.now();
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
    },
    renderStatic() {
      draw(performance.now());
    },
    destroy() {
      running = false;
      cancelAnimationFrame(raf);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      ro?.disconnect();
      if (res) {
        gl.deleteBuffer(res.fromBuf);
        gl.deleteBuffer(res.toBuf);
        gl.deleteBuffer(res.metaBuf);
        gl.deleteProgram(res.line.program);
        gl.deleteProgram(res.point.program);
        res = null;
      }
    },
  };

  if (reduced) {
    fromShape = toShape;
    uploadFrom(shapeData[toShape]);
    morphStart = -1e9;
    globalAlpha = 1;
    // First static frame once layout settles.
    requestAnimationFrame(() => field.renderStatic());
  }

  return field;
}
