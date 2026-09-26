import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createClaudeLoginProvider } from "../claude-route.js";
import type { PlanProvider } from "../plan-route.js";
import type { ChatRequest } from "../provider.js";

export const planPriceList = fileURLToPath(
  new URL(
    "../../../../fixtures/catalogs/plan-route-prices.json",
    import.meta.url,
  ),
);
const fakeBin = fileURLToPath(
  new URL("../../../../fixtures/plan-cli-stub/bin", import.meta.url),
);
const roots: string[] = [];

export interface StubRecord {
  readonly event: "start" | "end";
  readonly pid: number;
  readonly at: string;
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly stdin?: string;
  readonly envNames?: readonly string[];
  readonly outcome?: string;
  readonly outputSchema?: unknown;
}

export const verdictFormat = {
  type: "json_schema",
  json_schema: {
    name: "verdict",
    strict: true,
    schema: {
      type: "object",
      properties: {
        verdict: {
          type: "string",
          enum: ["equivalent", "minor_drift", "divergent"],
        },
        score: { type: "number", minimum: 0, maximum: 1 },
        justification: { type: "string" },
      },
      required: ["verdict", "score", "justification"],
      additionalProperties: false,
    },
  },
};

export interface PlanStubHarness {
  readonly root: string;
  readonly provider: PlanProvider;
  readonly warnings: Array<{ code: string; message: string }>;
  records(): Promise<StubRecord[]>;
  modelCalls(): Promise<StubRecord[]>;
}

export async function removePlanStubRoots(): Promise<void> {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
}

export async function planStubHarness(
  options: {
    readonly fault?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly path?: string;
    readonly priceList?: string;
    readonly callTimeoutMs?: number;
  } = {},
): Promise<PlanStubHarness> {
  const root = await mkdtemp(join(tmpdir(), "rightmodeler-stub-harness-"));
  roots.push(root);
  const recordPath = join(root, "record.jsonl");
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CI;
  delete env.PLAN_STUB_FAULT;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  Object.assign(env, {
    PATH: options.path ?? [fakeBin, dirname(process.execPath)].join(delimiter),
    PLAN_STUB_RECORD: recordPath,
    PLAN_STUB_STATE: join(root, "state"),
    ...(options.fault === undefined ? {} : { PLAN_STUB_FAULT: options.fault }),
    ...options.env,
  });
  const warnings: Array<{ code: string; message: string }> = [];
  const provider = createClaudeLoginProvider({
    priceList: options.priceList ?? planPriceList,
    env,
    callTimeoutMs: options.callTimeoutMs ?? 30_000,
    warning: (code, message) => warnings.push({ code, message }),
  });
  async function records(): Promise<StubRecord[]> {
    let text: string;
    try {
      text = await readFile(recordPath, "utf8");
    } catch {
      return [];
    }
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as StubRecord);
  }
  return {
    root,
    provider,
    warnings,
    records,
    modelCalls: async () =>
      (await records()).filter(
        ({ event, argv }) => event === "start" && argv?.includes("--model"),
      ),
  };
}

export function turn(
  model: string,
  user = "Say lime.",
  extra: Partial<ChatRequest> = {},
): ChatRequest {
  return {
    model,
    messages: [
      { role: "system", content: "You are a terse assistant." },
      { role: "user", content: user },
    ],
    ...extra,
  };
}
