import { generateText } from "ai";

import { acme } from "./provider.mjs";

export async function triage(ticket, sdk = { generateText }) {
  return sdk.generateText({
    model: acme("acme/max-1"),
    system: "Classify the ticket as billing, shipping, or technical.",
    prompt: ticket,
    experimental_telemetry: { isEnabled: true, functionId: "triage" },
  });
}
