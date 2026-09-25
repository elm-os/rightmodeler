import { blendedPrice, compareText } from "@rightmodeler/core";
import { describe, expect, it } from "vitest";

import { createProvider } from "./provider.js";

const liveRequested = process.env.RIGHTMODELER_LIVE_DIRECT_KEYS === "1";
if (!liveRequested) {
  console.warn(
    "[direct keys live] SKIPPED: set RIGHTMODELER_LIVE_DIRECT_KEYS=1",
  );
}

const vendors = [
  {
    vendor: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
  {
    vendor: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
  },
] as const;

describe.skipIf(!liveRequested)("direct keys live", () => {
  for (const { vendor, baseUrl, apiKeyEnv } of vendors) {
    const keySet = Boolean(process.env[apiKeyEnv]);
    if (liveRequested && !keySet) {
      console.warn(`[direct keys live] ${vendor} SKIPPED: set ${apiKeyEnv}`);
    }

    it.skipIf(!keySet)(
      `lists, prices and answers through a direct ${vendor} key`,
      async () => {
        const provider = createProvider({
          providerId: `${vendor}-direct`,
          baseUrl,
          apiKeyEnv,
          catalogReference: "https://ai-gateway.vercel.sh/v1/models",
          warning: (code, message) =>
            console.warn(`[direct keys live] ${vendor} ${code}: ${message}`),
        });
        const catalog = await provider.listModels();
        const priced = catalog.filter(({ pricing }) => pricing !== null);

        expect(catalog.length).toBeGreaterThan(0);
        expect([...new Set(catalog.map(({ family }) => family))]).toEqual([
          vendor,
        ]);
        expect(priced.length).toBeGreaterThan(0);
        if (vendor === "anthropic") {
          expect(
            catalog.filter(
              ({ supportsStructuredOutput }) => supportsStructuredOutput,
            ),
          ).toEqual([]);
        }

        const cheapest = [...priced].sort(
          (left, right) =>
            blendedPrice(left)! - blendedPrice(right)! ||
            compareText(left.id, right.id),
        )[0]!;
        const response = await provider.chat({
          model: cheapest.id,
          messages: [{ role: "user", content: "Reply with ok." }],
          maxOutputTokens: 16,
        });
        console.warn(
          `[direct keys live] ${vendor}: ${catalog.length} models, ${priced.length} priced, chat ${cheapest.id}, finish ${response.finishReason ?? "none"}, costUsd ${response.costUsd}`,
        );

        expect(response.substitution).toBeUndefined();
        expect(response.costIsEstimate).toBe(true);
        expect(response.usage.outputTokens).toBeGreaterThan(0);
        expect(response.costUsd).toBeLessThanOrEqual(0.005);
      },
    );
  }
});
