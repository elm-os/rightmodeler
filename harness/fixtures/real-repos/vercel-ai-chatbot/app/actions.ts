"use server";

import { generateText } from "ai";

export async function summarize(document: string) {
  const result = await generateText({
    model: "acme/chat-large",
    prompt: `Summarize: ${document}`,
  });

  return result.text;
}
