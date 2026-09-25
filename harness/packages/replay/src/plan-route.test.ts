import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isSingleTurn,
  PlanLoginError,
  PlanRouteUnavailableError,
  stopPlanChildren,
} from "./plan-route.js";
import {
  estimateInputTokens,
  ProviderRequestError,
  type ChatMessage,
  type ProviderAttempt,
} from "./provider.js";
import {
  planStubHarness,
  removePlanStubRoots,
  turn,
} from "./test-utils/plan-cli-stub.js";

const haiku = "anthropic/claude-haiku-4.5";

afterEach(removePlanStubRoots);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("plan route runtime", () => {
  it("accepts only system or developer messages followed by one user message", () => {
    const system: ChatMessage = { role: "system", content: "s" };
    const developer: ChatMessage = { role: "developer", content: "d" };
    const user: ChatMessage = { role: "user", content: "u" };
    const assistant: ChatMessage = { role: "assistant", content: "a" };
    const tool: ChatMessage = {
      role: "tool",
      content: "t",
      tool_call_id: "call-1",
    };

    expect(isSingleTurn([user])).toBe(true);
    expect(isSingleTurn([system, user])).toBe(true);
    expect(isSingleTurn([system, developer, user])).toBe(true);
    expect(isSingleTurn([])).toBe(false);
    expect(isSingleTurn([system])).toBe(false);
    expect(isSingleTurn([user, user])).toBe(false);
    expect(isSingleTurn([system, user, assistant])).toBe(false);
    expect(isSingleTurn([user, assistant, user])).toBe(false);
    expect(isSingleTurn([system, assistant, user])).toBe(false);
    expect(isSingleTurn([system, tool, user])).toBe(false);
    expect(isSingleTurn([user, system])).toBe(false);
  });

  it("withholds API keys and parent Claude Code session variables from the child and names each withheld Anthropic key once", async () => {
    const values = {
      ANTHROPIC_API_KEY: "sk-ant-withheld-value",
      ANTHROPIC_AUTH_TOKEN: "anthropic-token-withheld-value",
      ANTHROPIC_BASE_URL: "https://anthropic.example",
      OPENAI_API_KEY: "sk-openai-withheld-value",
      CODEX_API_KEY: "codex-withheld-value",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "parent-session",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_PID: "4242",
      CLAUDE_EFFORT: "high",
      NODE_OPTIONS: "--no-warnings",
    };
    const harness = await planStubHarness({ env: values });

    await harness.provider.chat(turn(haiku));
    await harness.provider.chat(turn(haiku, "Say plum."));

    const starts = (await harness.records()).filter(
      ({ event }) => event === "start",
    );
    expect(starts.length).toBeGreaterThan(0);
    for (const { envNames } of starts) {
      for (const name of Object.keys(values)) {
        expect(envNames).not.toContain(name);
      }
    }
    expect(harness.warnings).toEqual([
      {
        code: "plan_route_key_withheld",
        message:
          "ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN are set; rightmodeler keeps them away from claude so your plan is used, not a key.",
      },
    ]);
  });

  it("keeps CLAUDE_CODE_OAUTH_TOKEN and CLAUDE_CONFIG_DIR for the child", async () => {
    const harness = await planStubHarness({
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: "plan-token-passed-through",
        CLAUDE_CONFIG_DIR: "/tmp/rightmodeler-claude-config",
      },
    });

    await harness.provider.chat(turn(haiku));

    const [call] = await harness.modelCalls();
    expect(call?.envNames).toEqual(
      expect.arrayContaining([
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
        "CLAUDE_CODE_MAX_RETRIES",
        "DISABLE_AUTOUPDATER",
        "MAX_THINKING_TOKENS",
      ]),
    );
    expect(harness.warnings).toEqual([]);
  });

  it("books list-price cost from the recorded input tokens and the reported output tokens, as an estimate", async () => {
    const harness = await planStubHarness();
    const attempts: ProviderAttempt[] = [];

    const recorded = await harness.provider.chat(
      turn(haiku, "Say lime.", {
        estimatedInputTokens: 1_000,
        onAttempt: (attempt) => {
          attempts.push(attempt);
        },
      }),
    );
    const request = turn(haiku, "Say plum.");
    const estimated = await harness.provider.chat(request);

    expect(recorded.usage.inputTokens).toBeGreaterThan(400);
    expect(recorded.usage.outputTokens).toBeGreaterThan(0);
    expect(recorded.costIsEstimate).toBe(true);
    expect(recorded.costUsd).toBeCloseTo(
      1_000 * 0.000001 + recorded.usage.outputTokens * 0.000005,
      12,
    );
    expect(estimated.costUsd).toBeCloseTo(
      estimateInputTokens(request.messages) * 0.000001 +
        estimated.usage.outputTokens * 0.000005,
      12,
    );
    expect(recorded.servedModel).toBe("claude-haiku-4-5-20251001");
    expect(recorded.substitution).toBeUndefined();
    expect(attempts).toEqual([
      expect.objectContaining({
        outcome: "completed",
        content: recorded.content,
        costUsd: recorded.costUsd,
        costIsEstimate: true,
        latencyMs: 500,
      }),
    ]);
  });

  it("refuses a plan route when CI is set, before running the CLI", async () => {
    const harness = await planStubHarness({ env: { CI: "true" } });

    for (const pending of [
      harness.provider.listModels(),
      harness.provider.knownModels(),
      harness.provider.chat(turn(haiku)),
    ]) {
      const error = await pending.then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(PlanRouteUnavailableError);
      expect(error).toMatchObject({
        message: "Plan routes run only on your own machine, and CI is set.",
        remedy:
          "In continuous integration, use an API route: --base-url <url> and --api-key-env <name>. If this is your own machine, unset CI and rerun.",
      });
    }
    expect(await harness.records()).toEqual([]);
  });

  it("kills a call that outlives its timeout and reports it as a lost request", async () => {
    const harness = await planStubHarness({
      fault: "hang",
      callTimeoutMs: 1_000,
    });
    const attempts: ProviderAttempt[] = [];
    const started = Date.now();

    const error = await harness.provider
      .chat(
        turn(haiku, "Say lime.", { onAttempt: (a) => void attempts.push(a) }),
      )
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(ProviderRequestError);
    expect((error as Error).message).toBe("claude did not answer within 1 s");
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(attempts).toEqual([
      expect.objectContaining({
        outcome: "provider_error",
        costUsd: 0,
        errorDetail: { status: null, bodyExcerpt: "" },
      }),
    ]);
    const [call] = await harness.modelCalls();
    expect(alive(call!.pid)).toBe(false);
  }, 20_000);

  it("stops every running CLI child when rightmodeler exits", async () => {
    const harness = await planStubHarness({
      fault: "hang",
      callTimeoutMs: 60_000,
    });
    const pending = harness.provider.chat(turn(haiku)).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    const call = await vi.waitFor(
      async () => {
        const [started] = await harness.modelCalls();
        if (started === undefined) throw new Error("no model call yet");
        return started;
      },
      { timeout: 10_000, interval: 50 },
    );
    try {
      expect(process.listeners("exit")).toContain(stopPlanChildren);

      stopPlanChildren();

      await vi.waitFor(
        () => {
          if (alive(call.pid)) throw new Error(`${call.pid} is still running`);
        },
        { timeout: 3_000, interval: 50 },
      );
      expect(await pending).toBeInstanceOf(ProviderRequestError);
    } finally {
      if (alive(call.pid)) process.kill(call.pid, "SIGKILL");
      await pending;
    }
  }, 30_000);

  it("never puts account fields or home paths from auth status or initialize into an error or warning", async () => {
    const texts: string[] = [];
    for (const fault of ["logged-out", "api-key-login", "no-models"]) {
      const harness = await planStubHarness({ fault });
      const error = await harness.provider.listModels().then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(
        error instanceof PlanLoginError ||
          error instanceof PlanRouteUnavailableError,
        fault,
      ).toBe(true);
      const { message, remedy } = error as PlanLoginError;
      texts.push(message, remedy);
      texts.push(...harness.warnings.map(({ message }) => message));
    }
    const badModel = await planStubHarness({ fault: "bad-model" });
    const attempts: ProviderAttempt[] = [];
    const error = await badModel.provider
      .chat(
        turn(haiku, "Say lime.", { onAttempt: (a) => void attempts.push(a) }),
      )
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );
    expect(error).toBeInstanceOf(ProviderRequestError);
    texts.push((error as Error).message);
    texts.push(
      ...attempts.map(({ errorDetail }) => errorDetail?.bodyExcerpt ?? ""),
    );
    texts.push(...badModel.warnings.map(({ message }) => message));

    expect(texts.length).toBeGreaterThan(7);
    for (const text of texts) expect(text).not.toContain("SENTINEL");
  });

  it("caps concurrent CLI processes at the route's limit", async () => {
    const harness = await planStubHarness({ fault: "delay:300" });

    await Promise.all(
      ["one", "two", "three", "four", "five"].map((word) =>
        harness.provider.chat(turn(haiku, `Say ${word}.`)),
      ),
    );

    const records = await harness.records();
    const calls = (await harness.modelCalls()).map(({ pid, at }) => {
      const end = records.find(
        (record) => record.event === "end" && record.pid === pid,
      );
      return { start: Date.parse(at), end: Date.parse(end!.at) };
    });
    expect(calls).toHaveLength(5);
    const overlap = Math.max(
      ...calls.map(
        ({ start }) =>
          calls.filter((other) => other.start <= start && start < other.end)
            .length,
      ),
    );
    expect(overlap).toBeLessThanOrEqual(2);
    expect(overlap).toBeGreaterThan(0);
  }, 30_000);
});
