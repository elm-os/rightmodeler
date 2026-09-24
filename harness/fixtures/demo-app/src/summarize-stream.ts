import { streamText } from "ai";

export function summarizeStream(article: string) {
  return streamText({
    model: "acme/large-1",
    system: "Summarize the article faithfully in two concise sentences.",
    prompt: article,
    experimental_telemetry: { isEnabled: true, functionId: "summarize" },
  });
}
