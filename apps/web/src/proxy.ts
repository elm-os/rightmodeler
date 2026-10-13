// Markdown content negotiation (acceptmarkdown.com). Node.js runtime; must not export `runtime`.

import { NextResponse, type NextRequest } from "next/server";
import { decideProxyAction, VARY } from "@/lib/negotiate";
import { markdownHandlerPath } from "@/lib/markdown-routes";

export function proxy(request: NextRequest) {
  const action = decideProxyAction({
    pathname: request.nextUrl.pathname,
    accept: request.headers.get("accept"),
    method: request.method,
    markdownHandlerPath,
  });

  if (action.type === "reject") {
    return new NextResponse(action.body, {
      status: action.status,
      headers: {
        "content-type": action.contentType,
        vary: VARY,
        // RFC 9110: a 406 is request-specific, so keep it out of shared caches.
        "cache-control": "no-store",
      },
    });
  }

  // Rewrite straight to the final handler path rather than to the .md sibling, so this never
  // depends on proxy -> afterFiles ordering holding on the deploy target.
  const response =
    action.type === "rewrite"
      ? NextResponse.rewrite(new URL(action.destination, request.url))
      : NextResponse.next();

  // Not NextResponse.next({ request: { headers } }): x-middleware-override-headers makes the router
  // drop every request header absent from it, and Next strips rsc / next-router-* inside the proxy.
  // Vary set here never reaches prerendered HTML, which relies on vercel.json (see AGENTS.md).
  response.headers.set("vary", VARY);
  return response;
}

export const config = {
  matcher: [
    {
      // Anything with a dot is skipped: .md siblings, metadata files, public/ assets. Less obvious:
      // /_vercel/ analytics beacons have no dot; opengraph-image would 406 on `Accept: image/*`.
      source: "/((?!_next/|_vercel/|api/|md/|.*\\.|.*opengraph-image).*)",
      // Keeps RSC navigation, prefetch and PPR resume traffic off the proxy, so a Flight response
      // is never negotiated. next-resume comes from routes-manifest ppr.chain.headers.
      missing: [
        { type: "header", key: "rsc" },
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "next-resume" },
        { type: "header", key: "purpose", value: "prefetch" },
        // A bare text/html range always wins the negotiation, so those requests skip the proxy.
        // Matched against the whole header. scripts/negotiate.test.mjs holds it to the negotiator.
        {
          type: "header",
          key: "accept",
          value: "(?:.*,)?\\s*text/html\\s*(?:,.*)?",
        },
      ],
    },
  ],
};
