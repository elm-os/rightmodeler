import { PassThrough, Readable, Writable } from "node:stream";

import type { PlanLoginStatus } from "@rightmodeler/replay";
import { describe, expect, it } from "vitest";

import type { DiscoveredTrace } from "./data/discover.js";
import { promptForModelRoute, promptForTracePath } from "./guidance.js";
import type { ModelRoute } from "./pipeline.js";
import { promptAnswers } from "./test-utils/prompt-answers.js";

const candidates: DiscoveredTrace[] = [
  {
    path: "/repo/new.jsonl",
    format: "codex",
    approximateRecords: 12,
    modifiedAt: new Date("2026-08-15T12:00:00.000Z"),
  },
  {
    path: "/repo/old.jsonl",
    format: "openai-jsonl",
    approximateRecords: 4,
    modifiedAt: new Date("2026-08-14T12:00:00.000Z"),
  },
];

async function prompt(
  answer: string,
  available: readonly DiscoveredTrace[] = candidates,
): Promise<{ selected: string | undefined; output: string }> {
  let output = "";
  const selected = await promptForTracePath({
    candidates: available,
    repo: "/repo",
    homeDir: "/home/example",
    now: new Date("2026-08-15T13:00:00.000Z"),
    input: Readable.from([answer]),
    output: new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    }),
  });
  return { selected, output };
}

describe("interactive trace guidance", () => {
  it("accepts the newest candidate when enter leaves the answer empty", async () => {
    const result = await prompt("\n");

    expect(result.selected).toBe("/repo/new.jsonl");
    expect(result.output).toContain(
      "1. Codex session, about 12 model calls, 1 hour ago, ./new.jsonl",
    );
    expect(result.output).toContain("Choose a trace file [1]:");
  });

  it("selects a candidate by index", async () => {
    expect((await prompt("2\n")).selected).toBe("/repo/old.jsonl");
  });

  it("accepts a typed path", async () => {
    expect((await prompt("./exports/traces.jsonl\n")).selected).toBe(
      "/repo/exports/traces.jsonl",
    );
  });

  it("re-prompts when a numeric choice is out of range", async () => {
    const result = await prompt("7\n2\n");

    expect(result.selected).toBe("/repo/old.jsonl");
    expect(result.output).toContain("Choose a number from 1 to 2.");
    expect(result.output.match(/Choose a trace file/g)).toHaveLength(2);
  });

  it("stops cleanly when the input closes during a question", async () => {
    const input = new PassThrough();
    let output = "";
    const selected = promptForTracePath({
      candidates,
      repo: "/repo",
      homeDir: "/home/example",
      input,
      output: new Writable({
        write(chunk, _encoding, callback) {
          output += String(chunk);
          callback();
        },
      }),
    });

    setImmediate(() => input.destroy());

    await expect(selected).resolves.toBeUndefined();
    expect(output).toContain("Choose a trace file");
  });

  it("explains traces before an empty path exits", async () => {
    const result = await prompt("\n", []);

    expect(result.selected).toBeUndefined();
    expect(result.output).toContain(
      "Traces are logs that your AI tools already write.",
    );
    expect(result.output).toContain(
      "See the supported sources at https://www.rightmodeler.com/integrations",
    );
    expect(result.output.indexOf("Traces are logs")).toBeLessThan(
      result.output.indexOf("Trace file path"),
    );
  });
});

const codexReady: PlanLoginStatus = {
  kind: "codex-login",
  ready: true,
  line: "codex 0.153.3: signed in with your plan",
};
const claudeReady: PlanLoginStatus = {
  kind: "claude-login",
  ready: true,
  line: "claude 2.1.282: signed in with your plan",
};
const codexSignedOut: PlanLoginStatus = {
  kind: "codex-login",
  ready: false,
  line: "codex: not signed in with a plan. Run codex login, then rerun; finished calls are kept.",
};
const claudeMissing: PlanLoginStatus = {
  kind: "claude-login",
  ready: false,
  line: "claude: cannot be used here. Install Claude Code and sign in with claude auth login, or use an API route with --base-url <url> and --api-key-env <name>.",
};
const priceList = "https://prices.example/v1/models";
const q1 = (statuses: readonly PlanLoginStatus[], fallback: 1 | 2): string =>
  [
    "How should rightmodeler call models? Replay sends your recorded calls to cheaper models, and a judge model from another vendor grades each answer.",
    ...statuses.map(({ line }) => `  ${line}`),
    "1. My plans, through the CLIs signed in on this machine",
    "2. An API key for a model provider or gateway",
    `Choose [${fallback}]: `,
  ].join("\n");
const fullMenu = (claude: boolean, codex: boolean): string =>
  [
    "Which provider or gateway?",
    "1. OpenRouter",
    "2. Vercel AI Gateway",
    claude
      ? "3. OpenAI (OpenAI models only; the judge runs through your claude login)"
      : "3. OpenAI (OpenAI models only; needs the claude CLI signed in to judge)",
    codex
      ? "4. Anthropic (Claude models only; the judge runs through your codex login)"
      : "4. Anthropic (Claude models only; needs the codex CLI signed in to judge)",
    "5. Another OpenAI-compatible endpoint",
    "Choose [1]: ",
  ].join("\n");
const multiVendorMenu = (heading: string): string =>
  [
    heading,
    "1. OpenRouter",
    "2. Vercel AI Gateway",
    "3. Another OpenAI-compatible endpoint",
    "Choose [1]: ",
  ].join("\n");
const notice = (
  candidates: string,
  judge: string,
  vendors: string,
  parts: string,
  plural: boolean,
): string =>
  [
    `Replays will run through ${candidates} and judge calls through ${judge}.`,
    "- Calls through a CLI use your plan's usage limits, the same 5-hour and weekly limits as your own coding. If a limit is reached, rightmodeler stops; rerun after the reset to continue.",
    `- Prompts from your traces go to ${vendors} under your plan's data settings.`,
    "- rightmodeler never reads your logins, and keeps API key variables away from the CLIs.",
    `- A coding CLI adds its own instructions to each call and cannot set temperature or an output limit.${parts} The report labels results measured this way.`,
    `Send recorded prompts through your ${plural ? "plans" : "plan"}? [y/N]: `,
  ].join("\n");
const claudePart =
  " claude's instructions include your account email and today's date.";
const codexPart =
  " codex also adds your global Codex instructions file when you have one.";
const openRouter: ModelRoute = {
  route: "api",
  judgeRoute: "api",
  api: {
    preset: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
};
const savedOther = {
  route: {
    route: "api",
    judgeRoute: "api",
    api: {
      preset: "other",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKeyEnv: "RM_056_UNSET_KEY",
    },
  } satisfies ModelRoute,
  flags: "--base-url http://127.0.0.1:9/v1 --api-key-env RM_056_UNSET_KEY",
};

async function chooseRoute(
  answers: readonly string[],
  options: {
    readonly statuses?: readonly PlanLoginStatus[] | "hidden";
    readonly saved?: { readonly route: ModelRoute; readonly flags: string };
    readonly hasEnv?: (name: string) => boolean;
  } = {},
): Promise<{
  route: ModelRoute | undefined;
  output: string;
  detections: number;
}> {
  const answering = promptAnswers(answers);
  const statuses = options.statuses ?? [codexReady, claudeReady];
  let output = "";
  let detections = 0;
  const route = await promptForModelRoute({
    input: answering.input,
    output: new Writable({
      write(chunk, _encoding, callback) {
        const text = String(chunk);
        output += text;
        answering.observe(text);
        callback();
      },
    }),
    plans:
      statuses === "hidden"
        ? undefined
        : async () => {
            detections += 1;
            return statuses;
          },
    saved: options.saved,
    hasEnv: options.hasEnv ?? (() => true),
    priceList,
  });
  return { route, output, detections };
}

describe("model route question", () => {
  it("plan branch: offers only ready CLIs, asks candidates then judge, asks consent, and returns names only", async () => {
    const both = await chooseRoute(["1", "1", "1", "y"]);

    expect(both.route).toEqual({
      route: "codex-login",
      judgeRoute: "claude-login",
    });
    expect(both.output).toBe(
      [
        q1([codexReady, claudeReady], 1),
        "Replay candidates through (choose the vendor your app calls today):\n1. codex (OpenAI models)\n2. claude (Anthropic models)\nChoose [1]: ",
        "Judge through:\n1. claude (your Claude plan)\n2. An API key for a provider or gateway\nChoose [1]: ",
        notice(
          "codex under your own login",
          "claude under your own login",
          "Anthropic and OpenAI",
          `${claudePart}${codexPart}`,
          true,
        ),
      ].join(""),
    );

    const claudeOnly = await chooseRoute(["1"], {
      statuses: [codexSignedOut, claudeReady],
    });

    expect(claudeOnly.route).toBeUndefined();
    expect(claudeOnly.output).toBe(
      `${q1([codexSignedOut, claudeReady], 1)}Replay candidates through (choose the vendor your app calls today):\n1. claude (Anthropic models)\nChoose [1]: `,
    );
  });

  it("plan branch with only claude ready offers an API key for the judge from the multi-vendor menu", async () => {
    const chosen = await chooseRoute(["1", "1", "1", "1", "", "y"], {
      statuses: [codexSignedOut, claudeReady],
    });

    expect(chosen.route).toEqual({
      route: "claude-login",
      judgeRoute: "api",
      api: {
        preset: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyEnv: "OPENROUTER_API_KEY",
      },
    });
    expect(chosen.output).toBe(
      [
        q1([codexSignedOut, claudeReady], 1),
        "Replay candidates through (choose the vendor your app calls today):\n1. claude (Anthropic models)\nChoose [1]: ",
        "Judge through:\n1. An API key for a provider or gateway\nChoose [1]: ",
        multiVendorMenu("Which provider or gateway for judge calls?"),
        "Environment variable that holds your OpenRouter key [OPENROUTER_API_KEY]: OPENROUTER_API_KEY is set.\n",
        notice(
          "claude under your own login",
          "https://openrouter.ai/api/v1, billed to your key",
          "Anthropic",
          claudePart,
          false,
        ),
      ].join(""),
    );
  });

  it("choosing plans when no CLI is ready explains and asks again", async () => {
    const statuses = [codexSignedOut, claudeMissing];
    const chosen = await chooseRoute(["1", "2", "1", ""], { statuses });

    expect(chosen.route).toEqual(openRouter);
    expect(chosen.output).toBe(
      [
        q1(statuses, 2),
        "Neither CLI is ready; each line above says how to fix it. Choose 2 to use an API key.\nChoose [2]: ",
        fullMenu(false, false),
        "Environment variable that holds your OpenRouter key [OPENROUTER_API_KEY]: OPENROUTER_API_KEY is set.\n",
      ].join(""),
    );
  });

  it.each([
    {
      name: "OpenRouter",
      answers: ["2", "1", ""],
      set: true,
      route: openRouter,
      tail: "Environment variable that holds your OpenRouter key [OPENROUTER_API_KEY]: OPENROUTER_API_KEY is set.\n",
    },
    {
      name: "Vercel AI Gateway",
      answers: ["2", "2", ""],
      set: false,
      route: {
        route: "api",
        judgeRoute: "api",
        api: {
          preset: "vercel",
          baseUrl: "https://ai-gateway.vercel.sh/v1",
          apiKeyEnv: "AI_GATEWAY_API_KEY",
        },
      },
      tail: "Environment variable that holds your Vercel AI Gateway key [AI_GATEWAY_API_KEY]: AI_GATEWAY_API_KEY is not set in this shell. Set it in your own shell before replay; rightmodeler never asks for the key and never stores it.\n",
    },
    {
      name: "another endpoint",
      answers: ["2", "5", " https://litellm.example.com/v1 ", " LITELLM_KEY "],
      set: true,
      route: {
        route: "api",
        judgeRoute: "api",
        api: {
          preset: "other",
          baseUrl: "https://litellm.example.com/v1",
          apiKeyEnv: "LITELLM_KEY",
        },
      },
      tail: "Base URL of the endpoint, usually ending in /v1: Environment variable that holds the endpoint's key [RIGHTMODELER_API_KEY]: LITELLM_KEY is set.\n",
    },
  ])(
    "API branch: OpenRouter, Vercel AI Gateway and another endpoint fill their base URL and variable ($name)",
    async ({ answers, set, route, tail }) => {
      const checked: string[] = [];
      const chosen = await chooseRoute(answers, {
        hasEnv: (name) => {
          checked.push(name);
          return set;
        },
      });

      expect(chosen.route).toEqual(route);
      expect(chosen.output).toBe(
        `${q1([codexReady, claudeReady], 1)}${fullMenu(true, true)}${tail}`,
      );
      expect(checked).toEqual([route.api!.apiKeyEnv]);
    },
  );

  it.each([
    {
      name: "OpenAI",
      statuses: [codexSignedOut, claudeReady],
      answers: ["2", "3", "", "y"],
      route: {
        route: "api",
        judgeRoute: "claude-login",
        api: {
          preset: "openai",
          baseUrl: "https://api.openai.com/v1",
          apiKeyEnv: "OPENAI_API_KEY",
          catalogReference: priceList,
        },
      },
      menu: fullMenu(true, false),
      tail: [
        "Environment variable that holds your OpenAI key [OPENAI_API_KEY]: OPENAI_API_KEY is set.\n",
        notice(
          "https://api.openai.com/v1, billed to your key",
          "claude under your own login",
          "Anthropic",
          claudePart,
          false,
        ),
      ].join(""),
    },
    {
      name: "Anthropic",
      statuses: [codexReady, claudeMissing],
      answers: ["2", "4", "", "y"],
      route: {
        route: "api",
        judgeRoute: "codex-login",
        api: {
          preset: "anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          catalogReference: priceList,
        },
      },
      menu: fullMenu(false, true),
      tail: [
        "Environment variable that holds your Anthropic key [ANTHROPIC_API_KEY]: ANTHROPIC_API_KEY is set.\n",
        notice(
          "https://api.anthropic.com/v1, billed to your key",
          "codex under your own login",
          "OpenAI",
          codexPart,
          false,
        ),
      ].join(""),
    },
  ])(
    "API branch: OpenAI and Anthropic add the price list and the other vendor's CLI as judge, and ask consent ($name)",
    async ({ statuses, answers, route, menu, tail }) => {
      const chosen = await chooseRoute(answers, { statuses });

      expect(chosen.route).toEqual(route);
      expect(chosen.output).toBe(`${q1(statuses, 1)}${menu}${tail}`);
    },
  );

  it("API branch: OpenAI without a ready claude explains and shows the menu again", async () => {
    const openai = await chooseRoute(["2", "3", "1", ""], {
      statuses: [codexReady, claudeMissing],
    });

    expect(openai.route).toEqual(openRouter);
    expect(openai.output).toBe(
      [
        q1([codexReady, claudeMissing], 1),
        fullMenu(false, true),
        "OpenAI's API serves only OpenAI models, and the judge must come from another vendor. Sign in to the claude CLI to judge through your Claude plan, or choose OpenRouter or Vercel AI Gateway.\n",
        fullMenu(false, true),
        "Environment variable that holds your OpenRouter key [OPENROUTER_API_KEY]: OPENROUTER_API_KEY is set.\n",
      ].join(""),
    );

    const anthropic = await chooseRoute(["2", "4", "1", ""], {
      statuses: [codexSignedOut, claudeReady],
    });

    expect(anthropic.route).toEqual(openRouter);
    expect(anthropic.output).toContain(
      `${fullMenu(true, false)}Anthropic's API serves only Claude models, and the judge must come from another vendor. Sign in to the codex CLI to judge through your ChatGPT plan, or choose OpenRouter or Vercel AI Gateway.\n${fullMenu(true, false)}`,
    );
  });

  it("refuses a URL with a user name, password or query string, and a key-shaped variable name, without repeating either", async () => {
    const chosen = await chooseRoute([
      "2",
      "5",
      "https://u:rm056pw@x.example/v1",
      "https://rm056user@x.example/v1",
      "https://x.example/v1?k=rm056q",
      "ftp://x.example/v1",
      "https://x.example/v1",
      "sk-live-rm056secret",
      "RM_KEY",
    ]);

    expect(chosen.route).toEqual({
      route: "api",
      judgeRoute: "api",
      api: {
        preset: "other",
        baseUrl: "https://x.example/v1",
        apiKeyEnv: "RM_KEY",
      },
    });
    const url =
      "Enter an http or https URL without a user name, password or query string, such as https://litellm.example.com/v1.\n";
    const name =
      "Enter the variable's name, such as OPENROUTER_API_KEY, not the key itself.\n";
    expect(chosen.output.split(url)).toHaveLength(5);
    expect(chosen.output.split(name)).toHaveLength(2);
    for (const secret of ["rm056pw", "rm056user", "rm056q", "rm056secret"]) {
      expect(chosen.output).not.toContain(secret);
    }
  });

  it("a saved route: Enter keeps it without detection, c asks again, anything else asks once more", async () => {
    const kept = await chooseRoute([""], { saved: savedOther });

    expect(kept.route).toBe(savedOther.route);
    expect(kept.detections).toBe(0);
    expect(kept.output).toBe(
      "Models: --base-url http://127.0.0.1:9/v1 --api-key-env RM_056_UNSET_KEY (saved for this repository)\nPress Enter to keep, or type c to choose again [keep]: ",
    );

    const again = await chooseRoute(["x", "c", "2", "1", ""], {
      saved: savedOther,
    });

    expect(again.route).toEqual(openRouter);
    expect(again.detections).toBe(1);
    expect(again.output).toBe(
      [
        "Models: --base-url http://127.0.0.1:9/v1 --api-key-env RM_056_UNSET_KEY (saved for this repository)\nPress Enter to keep, or type c to choose again [keep]: ",
        "Press Enter to keep the saved route, or type c to choose again.\nPress Enter to keep, or type c to choose again [keep]: ",
        q1([codexReady, claudeReady], 1),
        fullMenu(true, true),
        "Environment variable that holds your OpenRouter key [OPENROUTER_API_KEY]: OPENROUTER_API_KEY is set.\n",
      ].join(""),
    );

    const upper = await chooseRoute(["C", "2", "1", ""], { saved: savedOther });

    expect(upper.route).toEqual(openRouter);
    expect(upper.detections).toBe(1);
  });

  it("consent: anything but y returns no route, and a plan kind already in the saved route is not asked again", async () => {
    for (const answer of ["n", "", "sure"]) {
      const declined = await chooseRoute(["1", "1", "1", answer]);

      expect(declined.route, answer).toBeUndefined();
      expect(declined.output, answer).toContain("[y/N]: ");
    }
    expect((await chooseRoute(["1", "1", "1", " YES "])).route).toEqual({
      route: "codex-login",
      judgeRoute: "claude-login",
    });

    const known = await chooseRoute(["c", "1", "1", "1"], {
      saved: {
        route: { route: "codex-login", judgeRoute: "claude-login" },
        flags: "--route codex-login --judge-route claude-login",
      },
    });

    expect(known.route).toEqual({
      route: "codex-login",
      judgeRoute: "claude-login",
    });
    expect(known.output).not.toContain("[y/N]");

    const added = await chooseRoute(["c", "1", "1", "1", "y"], {
      saved: {
        route: {
          route: "codex-login",
          judgeRoute: "api",
          api: openRouter.api,
        },
        flags:
          "--base-url https://openrouter.ai/api/v1 --api-key-env OPENROUTER_API_KEY --route codex-login --judge-route api",
      },
    });

    expect(added.route).toEqual({
      route: "codex-login",
      judgeRoute: "claude-login",
    });
    expect(added.output).toContain(
      "Send recorded prompts through your plans? [y/N]: ",
    );
  });

  it("cancelling at any question returns no route", async () => {
    const plan = ["c", "1", "1", "2", "1", "", "y"];
    const stops = [
      ...plan.slice(0, -1).map((_, index) => plan.slice(0, index)),
      plan.slice(0, -1),
      ["c", "2"],
      ["c", "2", "1"],
      ["c", "2", "5"],
      ["c", "2", "5", "https://x.example/v1"],
    ];
    for (const answers of stops) {
      const chosen = await chooseRoute(answers, { saved: savedOther });

      expect(chosen.route, answers.join(",")).toBeUndefined();
    }
  });

  it("without plan routes (Mode B) offers only multi-vendor API routes", async () => {
    const chosen = await chooseRoute(["1", ""], { statuses: "hidden" });

    expect(chosen.route).toEqual(openRouter);
    expect(chosen.output).toBe(
      [
        "Mode B confirmation (--modeb-config) needs an API key for candidates and the judge, so only OpenRouter, Vercel AI Gateway and other endpoints are offered.\n",
        multiVendorMenu("Which provider or gateway?"),
        "Environment variable that holds your OpenRouter key [OPENROUTER_API_KEY]: OPENROUTER_API_KEY is set.\n",
      ].join(""),
    );
  });
});
