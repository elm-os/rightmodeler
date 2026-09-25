import { readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { blendedPrice, compareText } from "@rightmodeler/core";
import { judgeExecution } from "@rightmodeler/kernel";
import { describe, expect, it } from "vitest";

import { createClaudeLoginProvider } from "./claude-route.js";
import type { ProviderAttempt } from "./provider.js";

const liveRequested = process.env.RIGHTMODELER_LIVE_CLAUDE === "1";
if (!liveRequested) {
  console.warn("[claude live] SKIPPED: set RIGHTMODELER_LIVE_CLAUDE=1");
}

const dummyKey = "sk-ant-dummy-not-a-key";
const projects = join(homedir(), ".claude", "projects");
const history = join(homedir(), ".claude", "history.jsonl");

async function entryNames(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

async function nestedNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { recursive: true })).map(String);
  } catch {
    return [];
  }
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

describe.skipIf(!liveRequested)("claude-login live", () => {
  it("lists, answers, withholds a key, skips the default prompt, judges, and leaves no session file", async () => {
    const projectsBefore = new Set(await entryNames(projects));
    const tempBefore = new Set(await entryNames(tmpdir()));
    const historyBefore = await sizeOf(history);
    const hadKey = Object.hasOwn(process.env, "ANTHROPIC_API_KEY");
    const previousKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = dummyKey;
    const warnings: Array<{ code: string; message: string }> = [];
    try {
      const provider = createClaudeLoginProvider({
        priceList: "https://ai-gateway.vercel.sh/v1/models",
        warning: (code, message) => warnings.push({ code, message }),
      });
      const usageWarning = (): string => {
        const warning = warnings.find(
          ({ code }) => code === "plan_usage_warning",
        );
        if (warning === undefined) return "none";
        const utilization = Number(/at (\d+)% of/u.exec(warning.message)?.[1]);
        if (!(utilization < 80)) throw new Error(warning.message);
        return `${utilization}%`;
      };

      const callable = await provider.listModels();
      const known = new Set((await provider.knownModels()).map(({ id }) => id));
      expect(callable.length).toBeGreaterThan(0);
      for (const entry of callable) {
        expect(entry.family).toBe("anthropic");
        expect(entry.id).not.toContain("fable");
        expect(entry.pricing).not.toBeNull();
        expect(known.has(entry.id)).toBe(true);
      }
      const cheapest = [...callable].sort(
        (left, right) =>
          blendedPrice(left)! - blendedPrice(right)! ||
          compareText(left.id, right.id),
      )[0]!;

      const attempts: ProviderAttempt[] = [];
      const answer = await provider.chat({
        model: cheapest.id,
        messages: [
          {
            role: "system",
            content: "You are a terse assistant. Reply with one word.",
          },
          { role: "user", content: "Say lime." },
        ],
        onAttempt: (attempt) => {
          attempts.push(attempt);
        },
      });
      usageWarning();
      expect(answer.content.trim().length).toBeGreaterThan(0);
      expect(answer.substitution).toBeUndefined();
      expect(answer.servedModel).toEqual(expect.any(String));
      expect(answer.costIsEstimate).toBe(true);
      expect(attempts[0]?.latencyMs).toBeGreaterThan(0);
      const withheld = warnings.filter(
        ({ code }) => code === "plan_route_key_withheld",
      );
      expect(withheld).toHaveLength(1);
      expect(withheld[0]!.message).toContain("ANTHROPIC_API_KEY");
      expect(withheld[0]!.message).not.toContain(dummyKey);

      const bare = await provider.chat({
        model: cheapest.id,
        messages: [{ role: "user", content: "Say ok." }],
      });
      usageWarning();
      expect(bare.usage.inputTokens).toBeLessThan(1_500);

      const judged = await judgeExecution({
        chat: (request) =>
          provider.chat({ model: request.model, messages: request.messages }),
        judgeModel: cheapest.id,
        supportsStructuredOutput: false,
        task: "Name the fruit the user asked for.",
        reference: "Lime.",
        candidate: "lime",
      });
      expect(["equivalent", "minor_drift", "divergent"]).toContain(
        judged.verdict,
      );

      expect(
        (await entryNames(projects)).filter(
          (name) => !projectsBefore.has(name),
        ),
      ).toEqual([]);
      expect(
        (await nestedNames(projects)).filter((name) =>
          name.includes("rightmodeler-plan"),
        ),
      ).toEqual([]);
      expect(await sizeOf(history)).toBe(historyBefore);
      expect(
        (await entryNames(tmpdir())).filter(
          (name) =>
            name.startsWith("rightmodeler-plan-") && !tempBefore.has(name),
        ),
      ).toEqual([]);
      console.warn(
        `[claude live] model=${cheapest.id} input=${answer.usage.inputTokens} output=${answer.usage.outputTokens} noSystemInput=${bare.usage.inputTokens} verdict=${judged.verdict} usageWarning=${usageWarning()}`,
      );
    } finally {
      if (hadKey) process.env.ANTHROPIC_API_KEY = previousKey;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  }, 300_000);
});
