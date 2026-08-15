import { streamText } from "ai";

import { weather } from "../../../lib/ai/tools/weather";

export async function POST(request: Request) {
  const { messages } = await request.json();
  const result = streamText({
    model: "acme/chat-large",
    messages,
    tools: { weather },
  });

  return result.toUIMessageStreamResponse();
}
