// Compatibility redirect for the former, overstated /llms-full.txt name. The underlying bundle is
// a curated overview and full blog archive, now served at the accurately named /llms-context.txt.

export function GET() {
  return new Response("This file moved to /llms-context.txt.\n", {
    status: 308,
    headers: {
      Location: "/llms-context.txt",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
