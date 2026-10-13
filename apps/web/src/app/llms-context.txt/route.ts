import { buildLlmsContext } from "@/lib/llms";

export function GET() {
  return new Response(buildLlmsContext(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
