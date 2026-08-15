import { generateObject } from "ai";
import { z } from "zod";

const contactSchema = z.object({
  name: z.string(),
  topic: z.string(),
  urgency: z.enum(["low", "normal", "high"]),
});

export async function extractContact(message: string) {
  return generateObject({
    model: "acme/large-1",
    schema: contactSchema,
    prompt: `Extract the contact request: ${message}`,
  });
}
