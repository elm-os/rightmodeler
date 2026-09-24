import { summarize } from "./summarize.js";

export async function summarizeAll(texts: string[]): Promise<string[]> {
  return Promise.all(texts.map(summarize));
}
