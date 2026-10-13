// Compatibility redirect: /llms-full.txt is the old name of /llms-context.txt.

export function GET() {
  return new Response("This file moved to /llms-context.txt.\n", {
    status: 308,
    headers: {
      Location: "/llms-context.txt",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
