import { generateText } from "ai";

export async function staleExample(prompt: string) {
  return generateText({ model: "acme/large-1", prompt });
}
