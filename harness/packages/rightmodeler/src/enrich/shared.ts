export const codeownersPaths = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
] as const;

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
