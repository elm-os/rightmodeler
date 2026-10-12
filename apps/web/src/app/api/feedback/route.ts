// POST /api/feedback — the feedback form backend. Validates the submitted email and message and
// sends the team a real notification via Resend (no fake success; the client only shows a
// confirmation after this responds ok). Mirrors api/waitlist/route.ts: Node.js runtime (React
// Email rendering isn't Edge-safe), dynamic because it reads the request body — fine under Cache
// Components. The work is shared with api/feedback/agent/route.ts through lib/handle-feedback.ts.

import { readFormFeedback } from "@/lib/feedback";
import { handleFeedback } from "@/lib/handle-feedback";

export async function POST(request: Request) {
  return handleFeedback(request, readFormFeedback);
}
