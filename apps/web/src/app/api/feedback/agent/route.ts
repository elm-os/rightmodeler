// POST /api/feedback/agent: feedback a coding agent sends for its user, after the user has seen
// the text and said yes. JSON in, JSON out, with the contract of the form's route
// (api/feedback/route.ts): ok only after Resend takes the email, 400 with the reason for bad
// input. Only `message` is required; rightmodeler has no accounts, so no email is asked for. The
// published skill (skills/rightmodeler/SKILL.md) names this URL and these fields, so moving or
// renaming either breaks installed copies. Node.js runtime (React Email rendering isn't
// Edge-safe), dynamic because it reads the request body, which is fine under Cache Components.

import { readAgentFeedback } from "@/lib/feedback";
import { handleFeedback } from "@/lib/handle-feedback";

export async function POST(request: Request) {
  return handleFeedback(request, readAgentFeedback);
}
