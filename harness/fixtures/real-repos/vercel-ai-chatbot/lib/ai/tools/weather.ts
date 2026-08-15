import { tool } from "ai";
import { z } from "zod";

export const weather = tool({
  description: "Look up the weather for a city",
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }) => ({
    city,
    condition: "sunny",
  }),
});
