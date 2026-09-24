import { generateText } from "ai";

import { acme } from "./provider.mjs";

export async function summarize(article, sdk = { generateText }) {
  return sdk.generateText({
    model: acme("acme/large-1"),
    system: "Summarize the article faithfully in two concise sentences.",
    prompt: article,
    experimental_telemetry: { isEnabled: true, functionId: "summarize" },
  });
}
