import { complete } from "./llm.js";

export async function summarize(text: string): Promise<string> {
  return complete(`Summarize: ${text}`);
}
