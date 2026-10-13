// Import-free on purpose: scripts/negotiate.test.mjs loads this file under Node's type stripping.

// Server-preference order: a tie on q and specificity goes to the first, so a bare `*/*` gets HTML.
export const PRODUCES = ["text/html", "text/markdown"] as const;
export type Representation = (typeof PRODUCES)[number];

// Deprecated pre-registration spelling (RFC 7763 superseded it). Accepting it costs nothing.
const MARKDOWN_ALIASES = new Set(["text/markdown", "text/x-markdown"]);

// Accept plus the four Next emits itself, so the header holds whether the platform appends ours or
// replaces Next's (duplicates are legal). No Next-URL: Next adds it only for interception routes.
export const VARY =
  "Accept, RSC, Next-Router-State-Tree, Next-Router-Prefetch, Next-Router-Segment-Prefetch";

export type AcceptRange = {
  type: string;
  subtype: string;
  q: number;
  // 3 = exact type/subtype, 2 = type/*, 1 = */*. Higher wins regardless of q (RFC 9110 12.5.1).
  specificity: 1 | 2 | 3;
};

export function parseAccept(header: string | null | undefined): AcceptRange[] {
  if (!header) return [];
  const ranges: AcceptRange[] = [];

  for (const entry of header.split(",")) {
    const parts = entry.split(";");
    const mediaType = (parts[0] ?? "").trim().toLowerCase();
    const slash = mediaType.indexOf("/");
    if (slash <= 0 || slash === mediaType.length - 1) continue;

    const type = mediaType.slice(0, slash);
    const subtype = mediaType.slice(slash + 1);
    if (type.includes(" ") || subtype.includes(" ")) continue;

    // q is not always the first parameter: `text/markdown;charset=utf-8;q=0.9` is legal.
    let q = 1;
    for (const param of parts.slice(1)) {
      const eq = param.indexOf("=");
      if (eq < 0) continue;
      if (param.slice(0, eq).trim().toLowerCase() !== "q") continue;
      const parsed = Number(param.slice(eq + 1).trim());
      // A malformed q is treated as absent (1), never as a rejection.
      q = Number.isNaN(parsed) ? 1 : Math.min(1, Math.max(0, parsed));
    }

    const specificity = type === "*" ? 1 : subtype === "*" ? 2 : 3;
    ranges.push({ type, subtype, q, specificity });
  }

  return ranges;
}

function rangeMatches(range: AcceptRange, mediaType: string): boolean {
  if (range.type === "*") return true;
  const [type, subtype] = mediaType.split("/");
  if (range.type !== type) return false;
  if (range.subtype === "*") return true;
  if (range.subtype === subtype) return true;
  return (
    mediaType === "text/markdown" &&
    MARKDOWN_ALIASES.has(`${range.type}/${range.subtype}`)
  );
}

// RFC 9110 12.5.1: the most specific matching range decides whatever its q, so `text/html;q=0, */*`
// rejects HTML. Among equally specific ranges the highest q wins (the RFC leaves duplicates open).
export function matchRange(
  mediaType: string,
  ranges: AcceptRange[],
): AcceptRange | null {
  let best: AcceptRange | null = null;
  for (const range of ranges) {
    if (!rangeMatches(range, mediaType)) continue;
    if (
      best === null ||
      range.specificity > best.specificity ||
      (range.specificity === best.specificity && range.q > best.q)
    ) {
      best = range;
    }
  }
  return best;
}

export type Decision = Representation | "not-acceptable";

export function selectRepresentation(
  header: string | null | undefined,
): Decision {
  const ranges = parseAccept(header);
  // Missing, empty, or entirely unparseable: no constraint. Serve the default, never 406.
  if (ranges.length === 0) return PRODUCES[0];

  let chosen: Representation | null = null;
  let chosenQ = 0;
  let chosenSpecificity = 0;

  for (const candidate of PRODUCES) {
    const match = matchRange(candidate, ranges);
    if (match === null) continue;
    if (match.q <= 0) continue; // explicit rejection
    if (
      chosen === null ||
      match.q > chosenQ ||
      (match.q === chosenQ && match.specificity > chosenSpecificity)
    ) {
      chosen = candidate;
      chosenQ = match.q;
      chosenSpecificity = match.specificity;
    }
  }

  return chosen ?? "not-acceptable";
}

export const NOT_ACCEPTABLE_BODY = `406 Not Acceptable

This resource is available as:
  text/html
  text/markdown

Your Accept header requested none of these, or rejected all of them with q=0.
Markdown is also available at <path>.md regardless of Accept.
`;

export type ProxyAction =
  | { type: "pass" }
  | { type: "rewrite"; destination: string }
  | { type: "reject"; status: 406; body: string; contentType: string };

export function decideProxyAction(input: {
  pathname: string;
  accept: string | null | undefined;
  method: string;
  markdownHandlerPath: (pathname: string) => string;
}): ProxyAction {
  // Never negotiate a write. Defence in depth behind the matcher.
  if (input.method !== "GET" && input.method !== "HEAD")
    return { type: "pass" };

  const decision = selectRepresentation(input.accept);

  if (decision === "not-acceptable") {
    return {
      type: "reject",
      status: 406,
      body: NOT_ACCEPTABLE_BODY,
      contentType: "text/plain; charset=utf-8",
    };
  }

  if (decision === "text/markdown") {
    return {
      type: "rewrite",
      destination: input.markdownHandlerPath(input.pathname),
    };
  }

  return { type: "pass" };
}
