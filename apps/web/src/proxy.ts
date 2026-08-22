// Markdown content negotiation, per acceptmarkdown.com. Next 16 renamed this file convention from
// middleware to proxy; it runs on the Node.js runtime and must not export `runtime`.
//
// All logic lives in @/lib/negotiate so it can be unit-tested; this file is plumbing only.

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

  // Deliberately NOT NextResponse.next({ request: { headers } }): that emits
  // x-middleware-override-headers, and the router then deletes every request header absent from
  // that list. Next strips rsc / next-router-* from request.headers inside the proxy, so the
  // clone would be missing them and they would be dropped upstream.
  // Carries Vary on the Markdown branch and the 406. It does NOT reach a prerendered HTML
  // response: under next start in 16.3.0-preview.5 those are served from the incremental cache
  // with their stored headers, and anything set here is dropped. Vary for the HTML branch comes
  // from next.config.ts headers() instead, which the platform router applies from
  // routes-manifest.json. Setting it in both places is deliberate belt and braces.
  response.headers.set("vary", VARY);
  return response;
}

export const config = {
  matcher: [
    {
      // Every routable page. Excluded: Next internals; Vercel analytics beacons (@vercel/analytics
      // posts to /_vercel/insights/view, which has no dot and would otherwise be proxied on every
      // pageview); the markdown handler itself; and any path containing a dot, which covers the
      // .md siblings plus robots.txt, sitemap.xml, manifest.webmanifest, llms*.txt, humans.txt,
      // and every asset under public/.
      source: "/((?!_next/|_vercel/|api/|.*\\.).*)",
      // Keep RSC navigation, prefetch, and PPR resume traffic off the proxy entirely: same
      // behaviour as before this file existed, no extra invocations, and no chance of
      // negotiating a Flight response. next-resume comes from routes-manifest ppr.chain.headers.
      missing: [
        { type: "header", key: "rsc" },
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "next-resume" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
