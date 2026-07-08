// Shared icon set. Icons inherit color from `currentColor`, so they always take a brand text
// color (ink / driftwood / fog) — never an accent hue. Stroke icons use a 1.5 weight to match
// the light, editorial type.

type IconProps = React.SVGProps<SVGSVGElement> & { size?: number };

type LogoMarkProps = React.SVGProps<SVGSVGElement> & { height?: number };

// rightmodeler brand mark — the two-bar glyph from public/logo.png, reproduced as a transparent
// vector so it inherits the current ink color (monochrome, per docs/design.md) and stays crisp at
// any size. The viewBox is the exact pixel bounding box of the mark in the source art; height drives
// size and width follows the mark's portrait aspect ratio. Decorative — pair it with the wordmark
// inside a labelled link/heading, so it stays aria-hidden.
export function LogoMark({ height = 20, ...props }: LogoMarkProps) {
  return (
    <svg
      height={height}
      width={(height * 810) / 1007}
      viewBox="0 0 810 1007"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <rect x="0" y="0" width="381" height="1007" />
      <rect x="444" y="352" width="366" height="655" />
    </svg>
  );
}

export function GitHubIcon({ size = 18, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.801 8.207 11.387.6.111.793-.261.793-.577v-2.234C5.662 21.302 4.967 19.16 4.967 19.16c-.546-1.387-1.333-1.756-1.333-1.756-1.09-.744.083-.729.083-.729 1.205.084 1.84 1.237 1.84 1.237 1.07 1.834 2.807 1.304 3.492.998.107-.775.418-1.305.761-1.605-2.665-.304-5.467-1.334-5.467-5.93 0-1.311.47-2.382 1.237-3.222-.124-.303-.536-1.523.117-3.176 0 0 1.008-.322 3.301 1.23A11.51 11.51 0 0 1 12 5.8c1.02.005 2.047.138 3.006.404 2.29-1.552 3.297-1.23 3.297-1.23.653 1.653.241 2.873.118 3.176.768.84 1.235 1.911 1.235 3.222 0 4.608-2.807 5.624-5.48 5.92.431.373.824 1.103.824 2.223v3.293c0 .319.192.688.8.577C20.566 21.8 24 17.302 24 12 24 5.373 18.627 0 12 0Z" />
    </svg>
  );
}

export function LinkedInIcon({ size = 18, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z" />
    </svg>
  );
}

export function CopyIcon({ size = 16, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

export function CheckIcon({ size = 16, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="m20 6-11 11-5-5" />
    </svg>
  );
}

export function ArrowRightIcon({ size = 16, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}
