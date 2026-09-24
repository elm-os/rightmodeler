import { streamText } from "ai";

import { acme } from "./provider.mjs";

export async function summarizeStream(
  article,
  sdk = { streamText },
  abortSignal,
) {
  return sdk.streamText({
    model: acme("acme/large-1"),
    system: "Summarize the article faithfully in two concise sentences.",
    prompt: article,
    abortSignal,
    experimental_telemetry: { isEnabled: true, functionId: "summarize" },
  });
}
