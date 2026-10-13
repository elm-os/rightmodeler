// The published skill (skills/rightmodeler/SKILL.md) names this URL and its fields: moving or
// renaming either breaks installed copies. Node.js runtime: React Email rendering isn't Edge-safe.

import { readAgentFeedback } from "@/lib/feedback";
import { handleFeedback } from "@/lib/handle-feedback";

export async function POST(request: Request) {
  return handleFeedback(request, readAgentFeedback);
}
