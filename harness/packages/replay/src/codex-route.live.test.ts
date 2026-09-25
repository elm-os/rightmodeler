import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { blendedPrice, compareText } from "@rightmodeler/core";
import { judgeExecution } from "@rightmodeler/kernel";
import { describe, expect, it } from "vitest";

import { createCodexLoginProvider } from "./codex-route.js";
import type { ProviderAttempt } from "./provider.js";

const liveRequested = process.env.RIGHTMODELER_LIVE_CODEX === "1";
if (!liveRequested) {
  console.warn("[codex live] SKIPPED: set RIGHTMODELER_LIVE_CODEX=1");
}

const dummyKey = "sk-dummy-not-a-key";
const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const sessions = join(codexHome, "sessions");

async function entryNames(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

async function sessionFiles(): Promise<Array<{ mtimeMs: number }>> {
  const files: Array<{ mtimeMs: number }> = [];
  for (const name of await readdir(sessions, { recursive: true }).catch(
    () => [],
  )) {
    const info = await stat(join(sessions, String(name)));
    if (info.isFile()) files.push({ mtimeMs: info.mtimeMs });
  }
  return files;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe.skipIf(!liveRequested)("codex-login live", () => {
  it("lists, answers, withholds the key, skips the default instructions, judges with two concurrent calls, and writes no rollout", async () => {
    const markerDir = await mkdtemp(join(tmpdir(), "rightmodeler-live-mark-"));
    const marker = join(markerDir, "marker");
    await writeFile(marker, "");
    const markedAt = (await stat(marker)).mtimeMs;
    const sessionCount = (await sessionFiles()).length;
    const tempBefore = new Set(await entryNames(tmpdir()));
    const globalInstructions =
      (await exists(join(codexHome, "AGENTS.md"))) ||
      (await exists(join(codexHome, "AGENTS.override.md")));
    const hadKey = Object.hasOwn(process.env, "CODEX_API_KEY");
    const previousKey = process.env.CODEX_API_KEY;
    process.env.CODEX_API_KEY = dummyKey;
    const warnings: Array<{ code: string; message: string }> = [];
    try {
      const provider = createCodexLoginProvider({
        priceList: "https://ai-gateway.vercel.sh/v1/models",
        warning: (code, message) => warnings.push({ code, message }),
      });

      const callable = await provider.listModels();
      const known = new Set((await provider.knownModels()).map(({ id }) => id));
      expect(callable.length).toBeGreaterThan(0);
      for (const entry of callable) {
        expect(entry.family).toBe("openai");
        expect(entry.pricing).not.toBeNull();
        expect(entry.id).not.toMatch(/gpt-reserve|codex-auto-review/u);
        expect(entry.contextLength).toBeLessThanOrEqual(272_000);
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
      expect(answer.content.trim().length).toBeGreaterThan(0);
      expect(answer.substitution).toBeUndefined();
      expect(answer.servedModel).toBeUndefined();
      expect(answer.costIsEstimate).toBe(true);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ outcome: "completed" });
      expect(attempts[0]).not.toHaveProperty("latencyMs");
      const withheld = warnings.filter(
        ({ code }) => code === "plan_route_key_withheld",
      );
      expect(withheld).toHaveLength(1);
      expect(withheld[0]!.message).toContain("CODEX_API_KEY");
      expect(withheld[0]!.message).not.toContain(dummyKey);
      expect(
        warnings.filter(({ code }) => code === "codex_global_instructions"),
      ).toHaveLength(globalInstructions ? 1 : 0);

      const bare = await provider.chat({
        model: cheapest.id,
        messages: [{ role: "user", content: "Say ok." }],
      });
      expect(bare.usage.inputTokens).toBeLessThan(3_000);

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

      const after = await sessionFiles();
      expect(after.filter(({ mtimeMs }) => mtimeMs > markedAt)).toEqual([]);
      expect(after).toHaveLength(sessionCount);
      expect(
        (await entryNames(tmpdir())).filter(
          (name) =>
            name.startsWith("rightmodeler-plan-") && !tempBefore.has(name),
        ),
      ).toEqual([]);
      console.warn(
        `[codex live] ${JSON.stringify({
          model: cheapest.id,
          inputTokens: [answer.usage.inputTokens, bare.usage.inputTokens],
          outputTokens: [answer.usage.outputTokens, bare.usage.outputTokens],
          verdict: judged.verdict,
          warnings: warnings.map(({ code }) => code),
        })}`,
      );
    } finally {
      if (hadKey) process.env.CODEX_API_KEY = previousKey;
      else delete process.env.CODEX_API_KEY;
      await rm(markerDir, { recursive: true, force: true });
    }
  }, 300_000);
});
