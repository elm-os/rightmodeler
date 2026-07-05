# rightmodeler — Design System

The single source of truth for how rightmodeler looks and feels. Read this before
building or changing any UI, and derive every color, type, spacing, and motion
decision from the tokens below rather than inventing values inline.

**Identity.** Warm, paper-toned, editorial. A restrained monochrome interface on a
near-white canvas, with typography — not color — carrying the personality. Two
accent hues exist for decoration and illustration only; the working UI is
strictly black-on-paper. Hierarchy comes from surface contrast, weight, and
scale, never from semantic color-coding.

**Theme.** Light only. There is no dark variant by design — `color-scheme` is
pinned to `light`.

---

## How it's wired

Tokens are implemented as **Tailwind v4** theme variables. There is no
`tailwind.config.js`; the system lives in CSS.

| Concern                    | Where                                           |
| -------------------------- | ----------------------------------------------- |
| Color / type / font tokens | `apps/web/app/globals.css` (`@theme` + `:root`) |
| Font loading               | `apps/web/app/layout.tsx` (`next/font/google`)  |
| This document              | `docs/design.md`                                |

Because tokens are declared in `@theme`, each one generates a matching Tailwind
utility automatically — `--color-warm-sand` → `bg-warm-sand` / `text-warm-sand`
/ `border-warm-sand`, `--text-heading` → `text-heading`, `--font-display` →
`font-display`, and so on. **Use the utilities.** Reach for raw `var(--token)`
only in hand-written CSS (e.g. a keyframe or a custom easing).

---

## Color

Nine tokens. Every one is a Tailwind color utility (`bg-`, `text-`, `border-`).

| Token / utility   | Hex       | Role                                                         | Semantic             |
| ----------------- | --------- | ------------------------------------------------------------ | -------------------- |
| `parchment-white` | `#fdfcfc` | Page canvas — dominant background                            | Background (canvas)  |
| `warm-sand`       | `#f5f3f1` | Card surfaces, feature tiles, section backgrounds            | Background (surface) |
| `ash-border`      | `#e5e5e5` | Hairline borders on buttons, inputs, cards, dividers         | Border               |
| `midnight-ink`    | `#000000` | Primary text, headlines, filled buttons, icon fills          | Text (primary)       |
| `driftwood`       | `#777169` | Secondary body text, muted links, icon strokes               | Text (secondary)     |
| `fog`             | `#a59f97` | Tertiary / helper text, light icon strokes                   | Text (tertiary)      |
| `silver-mist`     | `#b1b0b0` | Subtle background washes, mid-level dividers                 | Divider (mid)        |
| `void-violet`     | `#0447ff` | **Decorative accent — illustration/gradient fills only**     | —                    |
| `ember-orange`    | `#ff4704` | **Decorative accent — paired with Void Violet in gradients** | —                    |

### Rules

- **Elevation = surface contrast.** `parchment-white → warm-sand` is the primary
  elevation signal. Shadows, if used at all, stay as sub-pixel hairlines. Prefer
  a `warm-sand` surface with an `ash-border` hairline over a drop shadow.
- **UI is monochrome.** Buttons, links, focus, hover, and every other interactive
  state use only ink / driftwood / fog / borders. The accent hues **never** touch
  a button, link, or any interactive state — they are reserved for decorative
  illustration and gradients.
- **No semantic color-coding.** No green/red/blue for success/error/info.
  Communicate state through copy, weight, iconography, and surface — not hue.
- Opacity modifiers work on the concrete colors (e.g. `bg-midnight-ink/5` for a
  faint wash), which is preferable to introducing a new gray.

---

## Typography

Four roles, four faces. The two "Waldenburg" faces are licensed (Milieu
Grotesque) and are **not** committed to the repo; each font stack leads with the
licensed name and falls back to a free Google substitute, so dropping real font
files in later is a no-op for consuming code.

| Role            | Utility                 | Licensed face      | Loaded substitute | Use for                                      |
| --------------- | ----------------------- | ------------------ | ----------------- | -------------------------------------------- |
| Display         | `font-display`          | Waldenburg (300)   | **DM Sans**       | Headlines & section titles ≥ 32px            |
| Wordmark        | `wordmark`              | WaldenburgFH (700) | **Space Grotesk** | The logo / brand mark, nothing else          |
| Functional / UI | `font-sans` _(default)_ | Inter              | **Inter**         | Nav, buttons, body, labels, inputs, captions |
| Monospace       | `font-mono`             | Geist Mono         | **Geist Mono**    | Code, API references, technical labels       |

> Substitute alternates if you ever swap: Display → Figtree (300); Mono →
> JetBrains Mono / IBM Plex Mono (400). Fonts load as variable fonts via
> `next/font/google`, so all needed weights are available without extra config.

### Type scale

Each size **carries its own line-height and letter-spacing** (and weight, for the
display sizes) baked into the token. Apply the semantic utility and you get the
whole spec — you never need a `leading-*` or `tracking-[…]` utility.

| Utility           | Size | Line height | Tracking | Weight  |
| ----------------- | ---- | ----------- | -------- | ------- |
| `text-caption`    | 10px | 1.4         | 0.1px    | 400     |
| `text-body`       | 16px | 1.5         | 0.16px   | 400     |
| `text-subheading` | 18px | 1.44        | 0.18px   | 400     |
| `text-heading-sm` | 20px | 1.4         | 0.2px    | 400     |
| `text-heading`    | 32px | 1.17        | −0.64px  | **300** |
| `text-heading-lg` | 36px | 1.13        | −0.72px  | **300** |
| `text-display`    | 48px | 1.08        | −0.96px  | **300** |

Example — the hero headline:

```tsx
<h1 className="font-display text-heading text-balance sm:text-display">…</h1>
```

`font-display` selects the face; `text-heading` / `text-display` supply size,
leading, tracking, and the 300 weight. Nothing else is needed.

### Rules

- **Display face is exclusive to headlines ≥ 32px.** Never set Inter or a heavier
  weight there; the light 300 weight is the point.
- **Wordmark face is exclusive to the logo.** Never body copy, labels, or buttons.
  Use the `wordmark` utility (it fixes family, 700 weight, 14px, and the 0.05em
  tracking in one place).
- **Inter carries the UI**, 400 for body and 500 for emphasis/nav. Keep UI text
  between 10px and 20px.
- **Never hand-set leading or tracking.** They live in the type tokens. Do not use
  `leading-*` utilities or ad-hoc `tracking-[…]` values. If a rare case genuinely
  needs a tracking utility, only `tracking-normal`, `tracking-tight`, or
  `tracking-tighter` are allowed (mirrors the repo rule in `AGENTS.md`).

---

## Layout & surface

- **Canvas** is `parchment-white`; **surfaces** (cards, tiles, sections) are
  `warm-sand`, separated from the canvas by an `ash-border` hairline.
- Keep radii modest and consistent; let the paper tones and hairlines do the work
  rather than heavy shadows or borders.
- Build to a quality floor: responsive to mobile, visible keyboard focus, and
  `prefers-reduced-motion` respected (see below).

---

## Motion & interaction

Motion craft follows Emil Kowalski's design-engineering philosophy (the
`emil-design-eng` and `review-animations` skills). The personality here is calm
and editorial, so motion is **crisp, fast, and sparing** — a professional tool,
not a playful one.

### Easing

Built-in Tailwind easing utilities (`ease-out`, `ease-in-out`) are fine for small
hovers and color fades. For deliberate or signature motion, use the stronger
custom curves (raw vars, for hand-written CSS):

```css
--ease-out-strong: cubic-bezier(0.23, 1, 0.32, 1); /* enter/exit */
--ease-in-out-strong: cubic-bezier(0.77, 0, 0.175, 1); /* on-screen movement */
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1); /* iOS-like drawer */
```

**Never use `ease-in` on UI** — it delays the moment the user is watching most and
feels sluggish.

### Decision framework

1. **Should it animate at all?** Keyboard-initiated or 100+/day actions get **no**
   animation. Occasional (modals, drawers, toasts) get standard motion.
   Rare/first-time moments can afford delight.
2. **What's the purpose?** Every animation answers spatial consistency, state
   indication, feedback, explanation, or preventing a jarring change. "It looks
   cool" on a frequently-seen element is a cut.
3. **Easing:** entering/exiting → `ease-out` (or the strong curve); on-screen
   movement → `ease-in-out`; hover/color → `ease`; constant motion → `linear`.
4. **Duration:** press feedback 100–160ms · tooltips 125–200ms · dropdowns
   150–250ms · modals/drawers 200–500ms. **Keep UI motion under 300ms.**

### Non-negotiables

- Animate **`transform` and `opacity` only** (GPU); never `width`/`height`/
  `margin`/`padding`/`top`/`left`.
- **Never animate from `scale(0)`** — start at `scale(0.95)` + `opacity: 0`.
  Nothing in the real world appears from nothing.
- **Buttons feel pressed:** `transform: scale(0.97)` on `:active`.
- **Popovers are origin-aware:** scale from the trigger, not center (modals stay
  centered).
- Rapidly-triggered motion (toasts, toggles, drags) uses **transitions/springs**
  (interruptible), not keyframes (restart from zero).
- **Asymmetric timing:** slow the deliberate phase, snap the response.
- Gate hover motion behind `@media (hover: hover) and (pointer: fine)`.

### Reduced motion

Honor `prefers-reduced-motion: reduce` per component — **gentler, not zero**. Keep
opacity/color transitions that aid comprehension; drop movement and position
animation.

```css
@media (prefers-reduced-motion: reduce) {
  .thing {
    transition: opacity 150ms ease;
  } /* no transform-based motion */
}
```

---

## Component patterns (monochrome)

- **Primary button** — `bg-midnight-ink` fill, white/`parchment-white` label,
  `scale(0.97)` on `:active`, ~150ms `transition-transform`.
- **Secondary button** — `warm-sand` (or transparent) surface, `ash-border`
  hairline, `midnight-ink` label; hover deepens the surface, not the hue.
- **Link** — `midnight-ink` or `driftwood`, hover → `midnight-ink`; underline or
  weight for affordance. No accent color, ever.
- **Input** — `parchment-white`/`warm-sand` field, `ash-border` hairline, ink
  text, `fog` placeholder; focus uses an ink/darker-border ring, not a colored one.
- **Card / tile** — `warm-sand` surface on the `parchment-white` canvas with an
  `ash-border` hairline; elevation reads from the surface step, not a shadow.

---

## Working with the design skills

For any non-trivial UI work, lean on the installed skills:

- **`frontend-design`** — visual direction, typography, avoiding templated
  defaults. Use when creating or reshaping a screen.
- **`emil-design-eng`** — interaction and motion craft, component polish, the
  invisible details. Use when building interactive components or animations.
- **`review-animations`** — audit motion code against the craft bar above.
- **`animation-vocabulary`** — name a motion effect you can describe but can't name.

---

## Adding the licensed Waldenburg fonts later

The stacks are already ordered `Waldenburg → DM Sans` and `WaldenburgFH → Space
Grotesk`, so once you have licensed files:

1. Add the font files under `apps/web/app/fonts/`.
2. Load them with `next/font/local`, exposing `--font-waldenburg` /
   `--font-waldenburg-fh`, and add those variables to the `<html>` className in
   `layout.tsx`.
3. Point the leading entry of `--font-display` / `--font-wordmark` in
   `globals.css` at those variables (replacing the bare `"Waldenburg"` /
   `"WaldenburgFH"` family names).

No consuming component changes — the utilities stay the same.

---

## Quick reference — do / don't

| Do                                                           | Don't                                         |
| ------------------------------------------------------------ | --------------------------------------------- |
| `bg-parchment-white`, `bg-warm-sand`, `border-ash-border`    | Reach for `stone-*` / `neutral-*` grays       |
| `text-midnight-ink` / `text-driftwood` / `text-fog`          | Color-code state (green/red/blue)             |
| `font-display` + `text-heading`/`text-display` for headlines | Use Inter or a heavy weight for display       |
| The `wordmark` utility for the logo                          | Use the wordmark face anywhere else           |
| Semantic `text-*` tokens (leading + tracking baked in)       | `leading-*` or `tracking-[…]` utilities       |
| Accents only in decorative illustration                      | Accent hues on buttons, links, or state       |
| GPU-only, sub-300ms, `ease-out` motion                       | `ease-in`, `scale(0)`, animating layout props |
