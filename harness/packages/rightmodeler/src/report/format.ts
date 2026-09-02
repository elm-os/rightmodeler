export function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function formatUsdPerCase(value: number | null): string {
  return value === null ? "n/a" : `$${value.toFixed(6)}`;
}

export function formatDeltaPct(value: number | null): string {
  return value === null
    ? "n/a"
    : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

export function formatLatencyMs(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value)} ms`;
}
