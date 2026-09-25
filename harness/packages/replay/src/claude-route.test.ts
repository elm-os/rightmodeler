import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PlanLoginError, PlanRouteUnavailableError } from "./plan-route.js";
import {
  BlockedError,
  ProviderRequestError,
  type ProviderAttempt,
} from "./provider.js";
import {
  planPriceList,
  planStubHarness,
  removePlanStubRoots,
  turn,
  type PlanStubHarness,
} from "./test-utils/plan-cli-stub.js";

const haiku = "anthropic/claude-haiku-4.5";
const keyRemedy =
  "Remove the setting that supplies it (an API key helper, an env block in Claude Code settings, or a cloud provider variable), or use an API route with --base-url <url> and --api-key-env <name>.";
const loginRemedy =
  "Run claude auth login, then rerun; finished calls are kept.";
const isolation = [
  "--tools",
  "",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--setting-sources",
  "",
  "--no-session-persistence",
];
const settings = ["--settings", '{"switchModelsOnFlag":false}'];
const stream = ["--output-format", "stream-json", "--verbose"];

afterEach(removePlanStubRoots);

async function rejection(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => {
      throw new Error("expected a rejection");
    },
    (reason: unknown) => reason,
  );
}

async function modelCallCount(harness: PlanStubHarness): Promise<number> {
  return (await harness.modelCalls()).length;
}

describe("claude-login adapter", () => {
  it("sends the system prompt through a file and the one user turn on stdin, then ends stdin", async () => {
    const harness = await planStubHarness({ callTimeoutMs: 10_000 });
    const user = "Summarize: the city opened two cooling centers.";

    const response = await harness.provider.chat({
      model: haiku,
      messages: [
        { role: "system", content: "SYSTEM-MARK-ONE" },
        { role: "developer", content: "DEVELOPER-MARK-TWO" },
        { role: "user", content: user },
      ],
    });

    const [call] = await harness.modelCalls();
    expect(call?.stdin).toBe(user);
    expect(call?.argv).not.toContain("SYSTEM-MARK-ONE");
    expect(call?.argv?.join(" ")).not.toContain("DEVELOPER-MARK-TWO");
    const file = call!.argv![call!.argv!.indexOf("--system-prompt-file") + 1]!;
    expect(basename(file)).toBe("system.txt");
    expect(response.content).toBe(
      `Deterministic reply ${createHash("sha256").update(user).digest("hex").slice(0, 12)}`,
    );
  });

  it("runs claude in an empty temporary directory and removes it afterwards", async () => {
    const harness = await planStubHarness();

    await harness.provider.chat(turn(haiku));

    const starts = (await harness.records()).filter(
      ({ event }) => event === "start",
    );
    expect(starts.map(({ argv }) => argv?.[0])).toEqual([
      "--version",
      "auth",
      "-p",
      "-p",
    ]);
    for (const { cwd } of starts) {
      expect(basename(cwd!)).toMatch(/^rightmodeler-plan-/u);
      expect(cwd).not.toBe(process.cwd());
      expect(existsSync(cwd!)).toBe(false);
    }
    const [call] = await harness.modelCalls();
    const file = call!.argv![call!.argv!.indexOf("--system-prompt-file") + 1]!;
    expect(basename(dirname(file))).toBe(basename(call!.cwd!));
  });

  it("passes the isolation flags: no tools, no settings, no MCP, no slash commands, no session file, one turn, no model switch", async () => {
    const harness = await planStubHarness();

    await harness.provider.chat(turn(haiku));

    const starts = (await harness.records()).filter(
      ({ event, argv }) => event === "start" && argv?.[0] === "-p",
    );
    expect(starts[0]?.argv).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      ...stream,
      ...isolation,
      ...settings,
    ]);
    const file = starts[1]!.argv![4]!;
    expect(basename(file)).toBe("system.txt");
    expect(basename(dirname(file))).toBe(basename(starts[1]!.cwd!));
    expect(starts[1]?.argv).toEqual([
      "-p",
      "--model",
      "claude-haiku-4-5-20251001",
      "--system-prompt-file",
      file,
      ...isolation,
      "--max-turns",
      "1",
      ...settings,
      ...stream,
    ]);
    const auth = (await harness.records()).find(
      ({ argv }) => argv?.[0] === "auth",
    );
    expect(auth?.argv).toEqual(["auth", "status", "--json"]);
  });

  it("stops a call at once when claude reports an API key source", async () => {
    const harness = await planStubHarness({
      fault: "api-key-source",
      callTimeoutMs: 5_000,
    });
    await harness.provider.listModels();
    const started = Date.now();

    const error = await rejection(harness.provider.chat(turn(haiku)));

    expect(error).toBeInstanceOf(PlanLoginError);
    expect(error).toMatchObject({
      message:
        "claude reported that the call would be paid by ANTHROPIC_API_KEY, not your plan, so rightmodeler stopped it.",
      remedy: keyRemedy,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("records a model substitution when modelUsage or the init names another model", async () => {
    const harness = await planStubHarness({ fault: "served:claude-opus-5-5" });

    const response = await harness.provider.chat(turn(haiku));

    expect(response.servedModel).toBe("claude-opus-5-5");
    expect(response.substitution).toEqual({
      kind: "model",
      evidence:
        "claude served claude-opus-5-5 for requested claude-haiku-4-5-20251001",
    });
  });

  it("records a request substitution when claude took more than one turn or called a tool", async () => {
    const turns = await planStubHarness({ fault: "turns:2" });
    const tool = await planStubHarness({ fault: "tool-use" });

    expect((await turns.provider.chat(turn(haiku))).substitution).toEqual({
      kind: "request",
      evidence: "claude took 2 turns",
    });
    expect((await tool.provider.chat(turn(haiku))).substitution).toEqual({
      kind: "request",
      evidence: "claude called a tool",
    });
  });

  it("reports a failed call from is_error even when subtype says success", async () => {
    const harness = await planStubHarness({ fault: "bad-model" });
    const attempts: ProviderAttempt[] = [];

    const error = await rejection(
      harness.provider.chat(
        turn(haiku, "Say lime.", { onAttempt: (a) => void attempts.push(a) }),
      ),
    );

    const text =
      "There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it. Run --model to pick a different model.";
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect((error as Error).message).toBe(`claude reported 404: ${text}`);
    expect(attempts).toEqual([
      expect.objectContaining({
        outcome: "provider_error",
        errorDetail: { status: 404, bodyExcerpt: text },
      }),
    ]);
  });

  it("maps a rejected rate-limit event to a usage limit with its reset time and stops later calls without spawning", async () => {
    const harness = await planStubHarness({ fault: "usage-limit-after:1" });

    await harness.provider.chat(turn(haiku));
    const limited = await rejection(
      harness.provider.chat(turn(haiku, "Say plum.")),
    );
    const later = await rejection(
      harness.provider.chat(turn(haiku, "Say fig.")),
    );

    expect(limited).toBeInstanceOf(BlockedError);
    expect(limited).toMatchObject({
      kind: "usage-limit",
      providerId: "claude-login",
      resetsAt: new Date(1790758800 * 1000).toISOString(),
      message: `claude-login reached its plan's usage limit (resets ${new Date(1790758800 * 1000).toISOString()}): rejected`,
    });
    expect(later).toBe(limited);
    expect(await modelCallCount(harness)).toBe(2);
  });

  it("maps credits_required and overage to a usage limit", async () => {
    const credits = await planStubHarness({ fault: "credits-required" });
    const overage = await planStubHarness({ fault: "overage" });

    expect(await rejection(credits.provider.chat(turn(haiku)))).toMatchObject({
      kind: "usage-limit",
      resetsAt: new Date(1790758800 * 1000).toISOString(),
      message: expect.stringMatching(/: credits_required$/u),
    });
    expect(await rejection(overage.provider.chat(turn(haiku)))).toMatchObject({
      kind: "usage-limit",
      message: expect.stringMatching(/: overage$/u),
    });
  });

  it("warns once when the plan is near its limit", async () => {
    const harness = await planStubHarness({ fault: "near-limit" });

    for (const word of ["lime", "plum", "fig"]) {
      await harness.provider.chat(turn(haiku, `Say ${word}.`));
    }

    expect(harness.warnings).toEqual([
      {
        code: "plan_usage_warning",
        message: `claude reports your plan at 65% of its usage limit, resetting at ${new Date(1790758800 * 1000).toISOString()}; rightmodeler stops at the limit, and a rerun after the reset continues.`,
      },
    ]);
  });

  it("maps an authentication failure during a call to a plan login error", async () => {
    const harness = await planStubHarness({ fault: "auth-failed" });

    const error = await rejection(harness.provider.chat(turn(haiku)));
    const later = await rejection(
      harness.provider.chat(turn(haiku, "Say plum.")),
    );

    expect(error).toBeInstanceOf(PlanLoginError);
    expect(error).toMatchObject({
      message:
        "claude stopped accepting its login during the run (authentication_failed).",
      remedy: loginRemedy,
    });
    expect(later).toBe(error);
    expect(await modelCallCount(harness)).toBe(1);
  });

  it("refuses before any model call when claude is missing, older than 2.1.282, not signed in, or signed in with a key", async () => {
    const empty = join((await planStubHarness()).root, "empty-path");
    await mkdir(empty);
    const cases = [
      {
        harness: await planStubHarness({
          path: [empty, dirname(process.execPath)].join(delimiter),
        }),
        type: PlanRouteUnavailableError,
        message: "claude is not installed or not on PATH.",
        remedy:
          "Install Claude Code and sign in with claude auth login, or use an API route with --base-url <url> and --api-key-env <name>.",
      },
      {
        harness: await planStubHarness({ fault: "old-version" }),
        type: PlanRouteUnavailableError,
        message:
          "claude 2.1.281 is older than 2.1.282, the version rightmodeler's isolation settings were verified on.",
        remedy: "Update with claude update, then rerun.",
      },
      {
        harness: await planStubHarness({ fault: "logged-out" }),
        type: PlanLoginError,
        message: "claude is not signed in on this machine.",
        remedy: loginRemedy,
      },
      {
        harness: await planStubHarness({ fault: "api-key-login" }),
        type: PlanLoginError,
        message:
          "claude would use ANTHROPIC_API_KEY instead of your Claude plan login.",
        remedy: keyRemedy,
      },
    ];
    for (const { harness, type, message, remedy } of cases) {
      for (const pending of [
        harness.provider.listModels(),
        harness.provider.chat(turn(haiku)),
      ]) {
        const error = await rejection(pending);
        expect(error, message).toBeInstanceOf(type);
        expect(error).toMatchObject({ message, remedy });
      }
      expect(await modelCallCount(harness)).toBe(0);
    }
  });

  it("refuses a claude whose initialize answer has no model list", async () => {
    const harness = await planStubHarness({ fault: "no-models" });

    const error = await rejection(harness.provider.listModels());

    expect(error).toBeInstanceOf(PlanRouteUnavailableError);
    expect(error).toMatchObject({
      message:
        "claude's initialize answer has no model list, so this claude version changed a shape rightmodeler relies on.",
      remedy: "Update with claude update, then rerun.",
    });
  });

  it("lists callable models from initialize, priced from the price list, without a model call", async () => {
    const harness = await planStubHarness();

    const callable = await harness.provider.listModels();
    const known = await harness.provider.knownModels();

    expect(callable.map(({ id }) => id)).toEqual([
      "anthropic/claude-opus-5.5",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-haiku-4.5",
      "anthropic/claude-opus-5",
      "anthropic/claude-opus-4.8",
      "anthropic/claude-opus-4.7",
      "anthropic/claude-opus-4.6",
      "anthropic/claude-sonnet-4.6",
    ]);
    for (const entry of callable) {
      expect(entry).toMatchObject({
        family: "anthropic",
        supportsTools: false,
        supportsStructuredOutput: false,
      });
      expect(entry.pricing).not.toBeNull();
    }
    expect(known).toHaveLength(17);
    expect(harness.warnings).toEqual([]);
    expect(await modelCallCount(harness)).toBe(0);

    const catalog = JSON.parse(await readFile(planPriceList, "utf8")) as {
      data: Array<{ id: string }>;
    };
    const trimmed = join(harness.root, "prices.json");
    await writeFile(
      trimmed,
      JSON.stringify({
        ...catalog,
        data: catalog.data.filter(
          ({ id }) => id !== "anthropic/claude-sonnet-4.6",
        ),
      }),
    );
    const unpriced = await planStubHarness({ priceList: trimmed });

    expect(
      (await unpriced.provider.listModels()).map(({ id }) => id),
    ).not.toContain("anthropic/claude-sonnet-4.6");
    expect(unpriced.warnings).toEqual([
      {
        code: "plan_model_unpriced",
        message: `claude lists claude-sonnet-4-6 but the price list ${trimmed} has no price for it; it is left out.`,
      },
    ]);
  });

  it("joins dated and dashed claude ids to the price list's dotted ids", async () => {
    const harness = await planStubHarness();

    expect((await harness.provider.listModels()).map(({ id }) => id)).toEqual(
      expect.arrayContaining([haiku, "anthropic/claude-opus-5.5"]),
    );
    await harness.provider.chat(turn("anthropic/claude-opus-5.5"));
    await harness.provider.chat(turn(haiku));

    expect(
      (await harness.modelCalls()).map(
        ({ argv }) => argv![argv!.indexOf("--model") + 1],
      ),
    ).toEqual(["claude-opus-5-5", "claude-haiku-4-5-20251001"]);
    expect(harness.warnings).toEqual([]);
  });

  it("leaves out Fable and 1M-context models", async () => {
    const plain = await planStubHarness();
    const withMillion = await planStubHarness({ fault: "with-1m" });

    for (const harness of [plain, withMillion]) {
      const ids = (await harness.provider.listModels()).map(({ id }) => id);
      expect(ids.filter((id) => /fable|\[1m\]/u.test(id))).toEqual([]);
      expect(ids).toContain("anthropic/claude-opus-4.6");
      expect(harness.warnings).toEqual([]);
    }
  });
});
