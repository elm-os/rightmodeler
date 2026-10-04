export type PaletteName = "duet" | "violet" | "ember" | "dawn";

// Illustration-only accent recipes (docs/design.md: accents never touch UI chrome).
// Kept separate so palette controls do not load the particle engine.
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
