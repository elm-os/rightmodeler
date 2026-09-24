import { generateObject } from "ai";
import { z } from "zod";

import { acme } from "./provider.mjs";

export async function extractOrder(ticket, sdk = { generateObject }) {
  return sdk.generateObject({
    model: acme("acme/large-1"),
    system: "Extract the customer, order id, and urgency from the ticket.",
    prompt: ticket,
    schema: z.object({
      customer: z.string(),
      orderId: z.string(),
      urgency: z.enum(["low", "normal", "high"]),
    }),
    experimental_telemetry: { isEnabled: true, functionId: "extract-order" },
  });
}
