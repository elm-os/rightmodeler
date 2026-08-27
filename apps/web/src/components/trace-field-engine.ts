// The trace field: a bespoke WebGL1 particle engine for the numbers band. One cloud of
// particles settles into a different etched plate per stat: a braided river delta
// (many formats, one schema), descending terraces (cost stepping down), a planetary
// ring (quality holding), and a suspension bridge (speed and throughput). The resting
// positions are density-sampled from fine line-art images, the same technique Stripe's
// stats scene uses (their dot-generation worker samples an image mask); the flight
// between plates is closed-form on the GPU and untouched by where the dots land.
//
// Why hand-rolled: Stripe's scene is likewise raw WebGL (custom GLSL, no three.js in
// that scene), and this repo's rule is minimum code over speculative dependencies.
// The vertex shader evaluates position(progress, time) twice, once at now and once a
// beat earlier, and draws the segment between the two, so comet trails during flight
// cost zero per-frame CPU. On a retarget mid-flight the CPU mirrors the same math
// once to snapshot current positions, keeping every transition interruptible.
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

/** Decoded pixels of one etched plate, used to place resting particles. */
export type ShapeMask = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

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

// Motion constants. The flight is deliberately slower than UI motion (it is
// illustration, not interface): a 1.5s glide with a large stagger window reads as
// one coherent wave. The flight math is settled; the rest states around it change
// freely, the flight itself does not.
const MORPH_MS = 900;
const STAGGER_SPAN = 0.3;
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

// --- shape data ------------------------------------------------------------------
// Every shape is N particles of (x, y, packed w) where w carries the assembly order
// (8 bits), a brightness level (2 bits: 0 anchors the darkest ink, 3 is paper dust)
// and the local ink darkness (fraction): w = (order256 * 4 + level) + darkness.

type ShapePoint = {
  x: number;
  y: number;
  order: number; // 0..1, assembly choreography
  level: number; // 0..3 brightness tier
  darkness: number; // 0..1 local ink density
};

function pack(p: ShapePoint): number {
  const orderQ = Math.max(0, Math.min(255, Math.round(p.order * 255)));
  const level = Math.max(0, Math.min(3, p.level | 0));
  return orderQ * 4 + level + Math.min(Math.max(p.darkness, 0), 0.999);
}

type OrderMode = "x" | "diag" | "angle" | "centerOut";
const MASK_ORDER: OrderMode[] = ["x", "diag", "angle", "centerOut"];
// Contrast exponent per plate: high values favor the darkest strokes (the delta is
// uniformly detailed and needs hierarchy), low values lift thin light threads (the
// ring is drawn in fine hairlines).
const MASK_GAMMA = [1.6, 1.6, 1.45, 1.7];
// Pre-blur radius per plate (pixels). Blurring the weight map turns "uniform fine
// detail" into "density of detail", so a uniformly busy drawing like the delta
// resolves into its main channels instead of noise.
const MASK_BLUR = [1, 0, 0, 0];

// Density-sample one etched plate. Weight follows ink density, so particles trace
// the drawing's strokes; a flatter-weighted tail slice becomes the paper dust
// around the drawing.
function maskShape(
  mask: ShapeMask,
  n: number,
  aspect: number,
  rand: () => number,
  orderMode: OrderMode,
  gamma: number,
  blur: number,
): ShapePoint[] {
  const { data, width, height } = mask;
  const px = width * height;
  const weight = new Float32Array(px);
  let peak = 0;
  for (let i = 0; i < px; i++) {
    const o = i * 4;
    const lum =
      (data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114) / 255;
    const w = 1 - lum;
    weight[i] = w < 0.08 ? 0 : w;
    if (w > peak) peak = w;
  }
  if (blur > 0) {
    // separable box blur, horizontal then vertical
    const tmp = new Float32Array(px);
    const span = blur * 2 + 1;
    for (let y = 0; y < height; y++) {
      let accRow = 0;
      const row = y * width;
      for (let x = -blur; x <= blur; x++) {
        accRow += weight[row + Math.min(Math.max(x, 0), width - 1)];
      }
      for (let x = 0; x < width; x++) {
        tmp[row + x] = accRow / span;
        const drop = row + Math.max(x - blur, 0);
        const add = row + Math.min(x + blur + 1, width - 1);
        accRow += weight[add] - weight[drop];
      }
    }
    for (let x = 0; x < width; x++) {
      let accCol = 0;
      for (let y = -blur; y <= blur; y++) {
        accCol += tmp[Math.min(Math.max(y, 0), height - 1) * width + x];
      }
      for (let y = 0; y < height; y++) {
        weight[y * width + x] = accCol / span;
        const drop = Math.max(y - blur, 0) * width + x;
        const add = Math.min(y + blur + 1, height - 1) * width + x;
        accCol += tmp[add] - tmp[drop];
      }
    }
    peak = 0;
    for (let i = 0; i < px; i++) if (weight[i] > peak) peak = weight[i];
  }
  // Normalize before the contrast curve so plates drawn in light hairlines carry
  // the same presence as plates drawn in heavy ink.
  const inv = peak > 0 ? 1 / peak : 1;
  for (let i = 0; i < px; i++) {
    if (weight[i] > 0) weight[i] = Math.pow(weight[i] * inv, gamma);
  }
  const cdf = new Float32Array(px);
  let acc = 0;
  for (let i = 0; i < px; i++) {
    acc += weight[i];
    cdf[i] = acc;
  }

  const imgAspect = width / height;
  // Fit the plate inside the viewport, height-first. Wide canvases keep a paper
  // margin; narrow (phone) canvases may crop a few percent of the plate's own
  // baked-in margins so the drawing keeps its presence.
  const scaleY = Math.min((1.06 * aspect) / imgAspect, 0.9);
  const pick = (r: number) => {
    const target = r * acc;
    let lo = 0;
    let hi = px - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const cx = width / 2;
  const cy = height / 2;
  const orderOf = (ix: number, iy: number): number => {
    if (orderMode === "x") return ix / width;
    if (orderMode === "diag") return (ix / width + iy / height) / 2;
    if (orderMode === "angle") {
      const ang = Math.atan2(iy - cy, ix - cx);
      return (ang / (Math.PI * 2) + 0.75) % 1;
    }
    return Math.abs(ix - cx) / cx; // centerOut
  };

  const dustShare = 0.08;
  const hits = new Uint8Array(px);
  const pts: ShapePoint[] = [];
  for (let i = 0; i < n; i++) {
    const dust = i >= n * (1 - dustShare);
    let idx = pick(rand());
    // spread repeated hits off the very same pixel so strokes read as even grain
    if (hits[idx] >= 2) idx = pick(rand());
    hits[idx] += 1;
    if (dust) {
      // flat-ish resample: a soft aura instead of strokes
      for (let tries = 0; tries < 24; tries++) {
        const cand = Math.floor(rand() * px);
        if (weight[cand] > 0) {
          idx = cand;
          break;
        }
      }
    }
    const iy = Math.floor(idx / width);
    const ix = idx % width;
    const jx = ix + (rand() - 0.5) * 0.9;
    const jy = iy + (rand() - 0.5) * 0.9;
    const x = ((jx / width) * 2 - 1) * scaleY * imgAspect;
    const y = (1 - (jy / height) * 2) * scaleY;
    const dark = Math.min(weight[idx], 1);
    const roll = rand();
    const level = dust
      ? 3
      : roll < 0.07 && dark > 0.45
        ? 0
        : roll < 0.72
          ? 1
          : 2;
    pts.push({
      x,
      y,
      order: Math.min(0.999, orderOf(ix, iy) * 0.94 + rand() * 0.06),
      level,
      darkness: dust ? dark * 0.4 : dark,
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
      order: rand(),
      level: rand() < 0.75 ? 2 : 3,
      darkness: 0.3 + rand() * 0.4,
    });
  }
  return pts;
}

// Procedural fallbacks, one silhouette per stat, used only when the plates fail to
// load or decode. Deliberately simple: a stream fan, a falling glide, a rim, and
// speed lanes.
function fallbackShape(
  which: number,
  n: number,
  a: number,
  rand: () => number,
): ShapePoint[] {
  const pts: ShapePoint[] = [];
  for (let i = 0; i < n; i++) {
    const u = rand();
    let x = 0;
    let y = 0;
    let order = u;
    if (which === 0) {
      const lane = Math.floor(rand() * 10);
      const y0 = (lane / 9 - 0.5) * 1.5;
      x = -0.9 * a + u * 1.8 * a;
      const k = Math.min(1, Math.max(0, (x / a + 0.9) / 0.85));
      y = y0 * (1 - k * k) + (rand() - 0.5) * 0.05;
      order = u;
    } else if (which === 1) {
      x = -0.85 * a + u * 1.7 * a;
      y = 0.55 - Math.pow(u, 1.3) * 1.1 + (rand() - 0.5) * 0.06;
    } else if (which === 2) {
      const ang = rand() * Math.PI * 2;
      x = Math.cos(ang) * 1.35 * 0.6;
      y = 0.03 + Math.sin(ang) * 0.6;
      order = ((ang / (Math.PI * 2) + 0.25) % 1) * 0.9;
    } else {
      const lane = Math.floor(rand() * 14);
      const yl = (lane / 13 - 0.5) * 1.5;
      const back = Math.pow(rand(), 2);
      x = (0.65 - back * 1.4) * a;
      y = yl + (rand() - 0.5) * 0.03;
      order = back;
    }
    pts.push({
      x,
      y,
      order: Math.min(0.999, order),
      level: rand() < 0.06 ? 0 : rand() < 0.8 ? 1 : 2,
      darkness: 0.5 + rand() * 0.4,
    });
  }
  return pts;
}

const SCATTER_INDEX = 4;
const SHAPE_COUNT = 5;

// --- shared math, mirrored between GLSL and the JS snapshot ----------------------

function flightEase(p: number): number {
  return 1 - Math.pow(1 - p, 3);
}

// One near-still ambient for every plate: the rest states are drawings, so they
// breathe rather than move. Mirrored in GLSL; change one, change both.
function ambientJs(seed: number, t: number): [number, number] {
  const ph = seed * 6.2832;
  return [
    Math.sin(t * 0.32 + ph) * 0.0045 + Math.sin(t * 0.11 + ph * 2.3) * 0.002,
    Math.cos(t * 0.27 + ph * 1.7) * 0.004,
  ];
}

type FlightUniforms = {
  progress: number;
  fromAmbientK: number;
  focusX: number;
  focusY: number;
  pointerX: number;
  pointerY: number;
  pointerK: number;
};

// Head position at (progress, time) for one particle: the JS twin of the GLSL
// below, used once per retarget to snapshot an in-flight cloud.
function positionJs(
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  tOrder: number,
  seed: number,
  u: FlightUniforms,
  time: number,
): { x: number; y: number } {
  const window = 1 - STAGGER_SPAN;
  const p = Math.min(
    Math.max((u.progress - tOrder * STAGGER_SPAN) / window, 0),
    1,
  );
  const e = flightEase(p);
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
  const [ax, ay] = ambientJs(seed, time);
  x += ax * (1 - e) * u.fromAmbientK + ax * e;
  y += ay * (1 - e) * u.fromAmbientK + ay * e;
  const rx = x - u.pointerX;
  const ry = y - u.pointerY;
  const pd = Math.hypot(rx, ry);
  const t01 = Math.min(Math.max(pd / 0.38, 0), 1);
  const fall = 1 - t01 * t01 * (3 - 2 * t01);
  const push = ((fall * fall * 0.03) / Math.max(pd, 0.04)) * u.pointerK;
  x += rx * push;
  y += ry * push;
  return { x, y };
}

// --- GLSL ------------------------------------------------------------------------

// Vertex chunk. highp is mandatory in WebGL1 vertex shaders and required here: the
// order+level packing in a_*.w needs far more mantissa than fp16 mediump offers.
const SHARED_GLSL = `
precision highp float;

attribute vec4 a_from;   // xy position, w packs order*4*255 + level + darkness
attribute vec4 a_to;
attribute vec4 a_meta;   // seed, sizeScale, alphaScale, endFlag (0 head / 1 tail)

uniform vec2  u_scale;     // 1/aspect, 1
uniform vec2  u_pointer;   // spring-smoothed cursor, world coords
uniform float u_pointerK;  // hover activation, eased in and out
uniform float u_progress;
uniform float u_progressPrev;
uniform float u_time;
uniform float u_timePrev;
uniform float u_fromAmbientK; // 0 while a_from is a snapshot with ambient baked in
uniform vec2  u_focus;
uniform float u_alpha;     // global fade
uniform vec3  u_colA;
uniform vec3  u_colB;
uniform vec3  u_colC;
uniform vec2  u_gradDir;
uniform float u_pixelScale; // dpr for point sizing

varying vec4 v_color;

float flightEase(float p) {
  return 1.0 - pow(1.0 - p, 3.0);
}

vec2 ambient(float seed, float t) {
  float ph = seed * 6.2832;
  return vec2(
    sin(t * 0.32 + ph) * 0.0045 + sin(t * 0.11 + ph * 2.3) * 0.002,
    cos(t * 0.27 + ph * 1.7) * 0.004
  );
}

// order in x, level in y, darkness in z
vec3 unpack(float w) {
  float i = floor(w);
  return vec3(floor(i / 4.0) / 255.0, mod(i, 4.0), fract(w));
}

// The settled flight math: mix + perpendicular swirl + a soft gather toward the
// focus. Returns position and the particle's eased arrival e.
vec3 flight(float progress, float t) {
  vec2 f = a_from.xy;
  vec2 to = a_to.xy;
  vec3 tw = unpack(a_to.w);
  float seed = a_meta.x;

  float p = clamp((progress - tw.x * ${STAGGER_SPAN.toFixed(3)}) / ${(1 - STAGGER_SPAN).toFixed(3)}, 0.0, 1.0);
  float e = flightEase(p);
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

  vec2 amb = ambient(seed, t);
  pos += amb * (1.0 - e) * u_fromAmbientK + amb * e;

  // Cursor proximity: particles yield away from the sprung pointer, a few pixels
  // at most, with a soft squared falloff. The spring lives on the CPU, so the
  // motion never tracks the mouse raw (raw tracking reads as artificial).
  vec2 dp = pos - u_pointer;
  float pd = length(dp);
  float fall = 1.0 - smoothstep(0.0, 0.38, pd);
  pos += dp / max(pd, 0.04) * fall * fall * 0.03 * u_pointerK;
  return vec3(pos, e);
}

float levelAlpha(float level) {
  return level < 0.5 ? 1.0 : level < 1.5 ? 0.86 : level < 2.5 ? 0.58 : 0.3;
}

float levelSize(float level) {
  return level < 0.5 ? 1.8 : level < 1.5 ? 1.0 : level < 2.5 ? 0.8 : 0.62;
}

vec4 shade(vec2 pos, float seed, float alphaScale) {
  float g = clamp(dot(pos, u_gradDir) * 0.34 + 0.5 + (seed - 0.5) * 0.22, 0.0, 1.0);
  vec3 col = g < 0.5 ? mix(u_colA, u_colB, g * 2.0) : mix(u_colB, u_colC, g * 2.0 - 1.0);
  return vec4(col, alphaScale);
}
`;

// Comet streaks, alive only while a particle is actually flying. At rest this pass
// contributes nothing: the settled plate is carried by the dots alone.
const STREAK_VERT = `${SHARED_GLSL}
void main() {
  vec3 head = flight(u_progress, u_time);
  vec3 back = flight(u_progressPrev, u_timePrev);
  vec2 motion = head.xy - back.xy;
  float speed = length(motion);
  float flying = smoothstep(0.0035, 0.014, speed);
  vec2 trail = motion * (1.7 + a_meta.x * 1.2);
  float trailLen = length(trail);
  if (trailLen > 0.34) trail *= 0.34 / trailLen;
  vec2 tail = head.xy - trail;

  vec2 pos = mix(head.xy, tail, a_meta.w);
  gl_Position = vec4(pos * u_scale, 0.0, 1.0);

  vec3 fw = unpack(a_from.w);
  vec3 tw = unpack(a_to.w);
  float lvlA = mix(levelAlpha(fw.y), levelAlpha(tw.y), head.z);
  vec4 c = shade(head.xy, a_meta.x, a_meta.z);
  float endFade = 1.0 - a_meta.w * 0.92;
  v_color = vec4(c.rgb, c.a * endFade * 0.5 * lvlA * flying * u_alpha);
}
`;

const POINT_VERT = `${SHARED_GLSL}
void main() {
  vec3 head = flight(u_progress, u_time);
  gl_Position = vec4(head.xy * u_scale, 0.0, 1.0);

  vec3 fw = unpack(a_from.w);
  vec3 tw = unpack(a_to.w);
  float e = head.z;
  float lvlS = mix(levelSize(fw.y), levelSize(tw.y), e);
  float lvlA = mix(levelAlpha(fw.y), levelAlpha(tw.y), e);
  float dark = mix(fw.z, tw.z, e);

  gl_PointSize = (1.3 + a_meta.y * 1.3) * lvlS * u_pixelScale;

  // Denser ink reads brighter; a faint slow twinkle keeps the plate alive.
  float twinkle = 0.9 + 0.1 * sin(u_time * 1.35 + a_meta.x * 41.0);
  vec4 c = shade(head.xy, a_meta.x, a_meta.z);
  float alpha = c.a * lvlA * (0.55 + dark * 0.45) * twinkle * u_alpha;
  v_color = vec4(c.rgb, alpha);
}
`;

const STREAK_FRAG = `
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
  float a = smoothstep(0.5, 0.4, d) * v_color.a;
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
  setPointerActive: (active: boolean) => void;
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
    /** The four etched plates. Falls back to procedural silhouettes if absent. */
    masks?: ShapeMask[];
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
  const masks =
    options.masks && options.masks.length === 4 ? options.masks : null;

  // Particle count scales with rendered area, clamped for phones and 5K monitors
  // alike. The plates want density: they are drawings made of dots.
  const rect = canvas.getBoundingClientRect();
  const area = Math.max(rect.width * rect.height, 1);
  // One density for every size: the phone ratio, where dots overlap along the
  // plate strokes into continuous ink. Desktop simply gets more particles.
  const count = Math.round(Math.min(12000, Math.max(1200, area / 50)));
  let aspect = Math.max(rect.width / Math.max(rect.height, 1), 0.1);

  const rand = mulberry32(0x5eed);

  // Static per-particle meta, shared by every shape.
  const seeds = new Float32Array(count);
  const sizes = new Float32Array(count);
  const alphas = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    seeds[i] = rand();
    const big = rand();
    sizes[i] = big < 0.07 ? 1.4 + rand() * 0.9 : 0.3 + rand() * 0.7;
    alphas[i] = 0.62 + rand() * 0.38;
  }

  let genAspect = aspect;
  function buildShapes(forAspect: number): Float32Array[] {
    const out: Float32Array[] = [];
    for (let s = 0; s < SHAPE_COUNT; s++) {
      const r = mulberry32(0xfeed + s * 7919);
      let pts: ShapePoint[];
      if (s === SCATTER_INDEX) {
        pts = scatter(count, forAspect, r);
      } else if (masks) {
        pts = maskShape(
          masks[s],
          count,
          forAspect,
          r,
          MASK_ORDER[s],
          MASK_GAMMA[s],
          MASK_BLUR[s],
        );
      } else {
        pts = fallbackShape(s, count, forAspect, r);
      }
      const arr = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        const p = pts[i];
        arr[i * 4] = p.x;
        arr[i * 4 + 1] = p.y;
        arr[i * 4 + 2] = 0;
        arr[i * 4 + 3] = pack(p);
      }
      out.push(arr);
    }
    return out;
  }
  let shapeData = buildShapes(genAspect);

  // CPU mirrors of the GPU buffers. The streak pass reads two copies of each
  // particle (head + tail flag in meta.w); the point pass reads the head copies
  // with a doubled stride. Keeping these arrays current is what makes context
  // restoration a plain re-upload.
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
    "u_pointer",
    "u_pointerK",
    "u_progress",
    "u_progressPrev",
    "u_time",
    "u_timePrev",
    "u_fromAmbientK",
    "u_focus",
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
    streak: Pass;
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
    const streak = makePass(STREAK_VERT, STREAK_FRAG);
    const point = makePass(POINT_VERT, POINT_FRAG);
    if (!streak || !point) return false;
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
    res = { streak, point, fromBuf, toBuf, metaBuf };
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
  // Cursor spring (Emil: never tie visuals to the raw mouse; interpolate with
  // spring physics so the yield is alive and interruptible). Near-critical
  // damping, a whisker under, so the settle has a breath of life.
  let pointerTX = 0;
  let pointerTY = 0;
  let pointerActive = false;
  let pointerPX = 0;
  let pointerPY = 0;
  let pointerVX = 0;
  let pointerVY = 0;
  let pointerK = 0;
  let dpr = 1;
  let pixelScale = 1;
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
    // Dots on a wide canvas are relatively smaller than the same dots on a
    // phone; a modest boost keeps the perceived weight consistent.
    pixelScale = dpr * (r.width > 900 ? 1.1 : 1);
    const w = Math.round(r.width * dpr);
    const h = Math.round(r.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    aspect = r.width / Math.max(r.height, 1);
    // Rotation or a drastic reflow reshapes the plates themselves. The old geometry
    // (and any in-flight snapshot of it) is meaningless in the new frame, so the
    // flight lands immediately rather than flying to remapped targets.
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
    gl.uniform2f(u.u_pointer, pointerPX, pointerPY);
    gl.uniform1f(u.u_pointerK, pointerK);
    gl.uniform1f(u.u_progress, progress);
    gl.uniform1f(u.u_progressPrev, progressPrev);
    gl.uniform1f(u.u_time, t);
    gl.uniform1f(u.u_timePrev, tPrev);
    gl.uniform1f(u.u_fromAmbientK, fromAmbientK);
    gl.uniform2f(u.u_focus, 0, 0.04);
    gl.uniform1f(u.u_alpha, globalAlpha);
    gl.uniform3f(u.u_colA, colors[0][0], colors[0][1], colors[0][2]);
    gl.uniform3f(u.u_colB, colors[1][0], colors[1][1], colors[1][2]);
    gl.uniform3f(u.u_colC, colors[2][0], colors[2][1], colors[2][2]);
    gl.uniform2f(u.u_gradDir, 0.94, -0.34);
    gl.uniform1f(u.u_pixelScale, pixelScale);
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
    if (globalAlpha < 1) globalAlpha = Math.min(1, globalAlpha + frameDt / 500);

    const dtS = Math.min(frameDt, 50) / 1000;
    // Stiff, critically damped cursor spring: the yield reads as immediate
    // (bulk of the motion lands within ~100ms) while still gliding, never
    // snapping or overshooting.
    const STIFF = 170;
    const DAMP = 26;
    pointerVX += (pointerTX * aspect - pointerPX) * STIFF * dtS;
    pointerVY += (pointerTY - pointerPY) * STIFF * dtS;
    pointerVX *= Math.max(0, 1 - DAMP * dtS);
    pointerVY *= Math.max(0, 1 - DAMP * dtS);
    pointerPX += pointerVX * dtS;
    pointerPY += pointerVY * dtS;
    // activation rises quicker than it falls, so leaving never snaps
    pointerK +=
      ((pointerActive ? 1 : 0) - pointerK) *
      Math.min(1, (pointerActive ? 18 : 6) * dtS);

    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(res.streak.program);
    setSharedUniforms(
      res.streak.u,
      tSec,
      progress,
      progressPrev,
      tSec - dt,
      colors,
    );
    bindPass(res.streak, 0);
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
  // feeds progressAt or the ambient blend (intro, fromAmbientK) changes.
  function snapshot(t: number) {
    const u: FlightUniforms = {
      progress: progressAt(t),
      fromAmbientK,
      focusX: 0,
      focusY: 0.04,
      pointerX: pointerPX,
      pointerY: pointerPY,
      pointerK,
    };
    const from = shapeData[fromShape];
    const to = shapeData[toShape];
    const tSec = t / 1000;
    const out = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const tw = to[i * 4 + 3];
      const tOrder = Math.floor(tw / 4) / 255;
      const p = positionJs(
        from[i * 4],
        from[i * 4 + 1],
        to[i * 4],
        to[i * 4 + 1],
        tOrder,
        seeds[i],
        u,
        tSec,
      );
      out[i * 4] = p.x;
      out[i * 4 + 1] = p.y;
      // Carry the destination's packed order/level/darkness: it is what the eye has
      // been converging toward, and the from-side ambient is gated off anyway.
      out[i * 4 + 3] = tw;
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
      const target = Math.max(0, Math.min(SHAPE_COUNT - 2, index));
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
      pointerTX = nx;
      pointerTY = ny;
      pointerActive = true;
    },
    setPointerActive(active) {
      pointerActive = active;
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
        gl.deleteProgram(res.streak.program);
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
