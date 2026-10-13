// Node.js runtime: React Email rendering isn't Edge-safe.

import { readFormFeedback } from "@/lib/feedback";
import { handleFeedback } from "@/lib/handle-feedback";

export async function POST(request: Request) {
  return handleFeedback(request, readFormFeedback);
}
