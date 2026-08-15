import { generateText } from "ai";

export async function summarize(article: string) {
  return generateText({
    model: "acme/large-1",
    system: "Summarize the article faithfully in two concise sentences.",
    prompt: article,
  });
}
