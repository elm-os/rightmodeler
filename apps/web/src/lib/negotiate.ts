// HTTP content negotiation for the Markdown representation of every page, per acceptmarkdown.com
// (RFC 9110 section 12.5.1, RFC 7763). Pure and import-free on purpose: src/proxy.ts stays a thin
// shell, and scripts/negotiate.test.mjs imports this file directly under Node's type stripping.

// The representations this site can produce, in server-preference order. A tie on both q and
// specificity resolves to the first entry, so a bare `text/*` or `*/*` gets HTML.
export const PRODUCES = ["text/html", "text/markdown"] as const;
export type Representation = (typeof PRODUCES)[number];

// Deprecated pre-registration spelling (RFC 7763 superseded it). Accepting it costs nothing.
const MARKDOWN_ALIASES = new Set(["text/markdown", "text/x-markdown"]);

// Next emits these four itself (base-server.js setVaryHeader, via appendHeader). We write the
// union rather than just "Accept" so the header stays correct whether the platform appends ours
// to Next's or replaces them. Duplicate tokens are legal: Vary is a token set, and Next
// explicitly whitelists multi-value vary in send-response.js. Next-URL is deliberately absent:
// it is only added for interception routes, and this app has none, so listing it would fragment
// the RSC cache for nothing.
export const VARY =
  "Accept, RSC, Next-Router-State-Tree, Next-Router-Prefetch, Next-Router-Segment-Prefetch";

export type AcceptRange = {
  type: string;
  subtype: string;
  q: number;
  // 3 = exact type/subtype, 2 = type/*, 1 = */*. Higher wins regardless of q (RFC 9110 12.5.1).
  specificity: 1 | 2 | 3;
};

// Split an Accept header into ranges, preserving client order. Unparseable entries are dropped
// rather than throwing: a malformed header means "no usable constraint", never a 406.
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

    // Find the parameter literally named q. It is not always first: a client may legitimately
    // send `text/markdown;charset=utf-8;q=0.9`.
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
  // `Accept: text/x-markdown` should reach the markdown representation.
  return (
    mediaType === "text/markdown" &&
    MARKDOWN_ALIASES.has(`${range.type}/${range.subtype}`)
  );
}

// The single most specific range that matches `mediaType`, which is the one whose q counts.
// RFC 9110 12.5.1: a more specific range overrides a less specific one regardless of q, so
// `text/html;q=0, */*;q=1` rejects HTML instead of letting the wildcard rescue it. Among ranges
// of equal specificity the highest q wins (the RFC leaves duplicates open; being generous to the
// client is the safer reading).
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

// The whole proxy decision as a pure function, so the routing logic is unit-testable and
// src/proxy.ts holds nothing but NextResponse plumbing.
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
