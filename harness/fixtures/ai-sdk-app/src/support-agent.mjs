import { generateText, isStepCount, tool } from "ai";
import { z } from "zod";

import { acme } from "./provider.mjs";

export async function supportAgent(
  question,
  sdk = { generateText, isStepCount },
) {
  return sdk.generateText({
    model: acme("acme/large-1"),
    system: "Answer the customer's order question using the lookup tool.",
    prompt: question,
    tools: {
      lookup_order: tool({
        description: "Look up the shipping status of an order.",
        inputSchema: z.object({ orderId: z.string() }),
        execute: async ({ orderId }) => ({ orderId, status: "ships Tuesday" }),
      }),
    },
    stopWhen: sdk.isStepCount(3),
    experimental_telemetry: { isEnabled: true, functionId: "support-agent" },
  });
}
