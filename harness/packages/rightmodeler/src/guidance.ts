import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { isAbsolute, relative, resolve } from "node:path";

import {
  isPlanRouteKind,
  type PlanLoginStatus,
  type PlanRouteKind,
} from "@rightmodeler/replay";

import type { DiscoveredTrace } from "./data/discover.js";
import type { TraceFormat } from "./data/index.js";
import type { ModelRoute } from "./pipeline.js";

export interface PromptStreams {
  readonly input: Readable;
  readonly output: Writable;
}

export async function promptForTracePath(
  options: PromptStreams & {
    readonly candidates: readonly DiscoveredTrace[];
    readonly repo: string;
    readonly homeDir: string;
    readonly now?: Date;
  },
): Promise<string | undefined> {
  if (options.candidates.length === 0) {
    options.output.write(
      [
        "Traces are logs that your AI tools already write.",
        "If you use Claude Code or Codex in this project, run a few tasks there and run this command again. Rightmodeler finds those logs automatically.",
        "If your app logs to Langfuse, Braintrust, LangSmith, Helicone, or W&B Weave, export a file and enter its path.",
        "See the supported sources at https://www.rightmodeler.com/integrations",
        "",
      ].join("\n"),
    );
    const asked = await question(
      options,
      "Trace file path (leave empty to stop): ",
    );
    const typed = asked.answer.trim();
    return asked.cancelled || typed === ""
      ? undefined
      : resolve(options.repo, typed);
  }

  options.output.write("Found trace files:\n");
  const now = options.now ?? new Date();
  for (const [index, candidate] of options.candidates.entries()) {
    options.output.write(
      `${index + 1}. ${formatName(candidate.format)}, about ${candidate.approximateRecords} ${unit("model call", candidate.approximateRecords)}, ${formatAge(candidate.modifiedAt, now)}, ${shortPath(candidate.path, options.repo, options.homeDir)}\n`,
    );
  }
  const asked = await question(
    options,
    "Choose a trace file [1]: ",
    (value) => {
      const choice = value.trim();
      if (/^[0-9]+$/u.test(choice)) {
        const selected = options.candidates[Number(choice) - 1];
        if (selected === undefined) {
          options.output.write(
            `Choose a number from 1 to ${options.candidates.length}.\n`,
          );
          return false;
        }
      }
      return true;
    },
  );
  if (asked.cancelled) return undefined;
  const answer = asked.answer.trim();
  if (answer === "") return options.candidates[0]!.path;
  if (/^[1-9][0-9]*$/u.test(answer)) {
    const selected = options.candidates[Number(answer) - 1];
    if (selected !== undefined) return selected.path;
  }
  return resolve(options.repo, answer);
}

const apiPresets = {
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    key: "your OpenRouter key",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
  vercel: {
    label: "Vercel AI Gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    key: "your Vercel AI Gateway key",
    apiKeyEnv: "AI_GATEWAY_API_KEY",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    key: "your OpenAI key",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    key: "your Anthropic key",
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
  other: {
    label: "Another OpenAI-compatible endpoint",
    baseUrl: undefined,
    key: "the endpoint's key",
    apiKeyEnv: "RIGHTMODELER_API_KEY",
  },
} as const;
const singleVendorPresets = {
  openai: {
    judge: "claude-login",
    usable:
      "OpenAI (OpenAI models only; the judge runs through your claude login)",
    unusable:
      "OpenAI (OpenAI models only; needs the claude CLI signed in to judge)",
    explanation:
      "OpenAI's API serves only OpenAI models, and the judge must come from another vendor. Sign in to the claude CLI to judge through your Claude plan, or choose OpenRouter or Vercel AI Gateway.",
  },
  anthropic: {
    judge: "codex-login",
    usable:
      "Anthropic (Claude models only; the judge runs through your codex login)",
    unusable:
      "Anthropic (Claude models only; needs the codex CLI signed in to judge)",
    explanation:
      "Anthropic's API serves only Claude models, and the judge must come from another vendor. Sign in to the codex CLI to judge through your ChatGPT plan, or choose OpenRouter or Vercel AI Gateway.",
  },
} as const;
const planClis = {
  "codex-login": {
    command: "codex",
    models: "OpenAI models",
    plan: "your ChatGPT plan",
    vendor: "OpenAI",
  },
  "claude-login": {
    command: "claude",
    models: "Anthropic models",
    plan: "your Claude plan",
    vendor: "Anthropic",
  },
} as const;

type ApiPreset = keyof typeof apiPresets;
type ModelRouteApi = NonNullable<ModelRoute["api"]>;
type RouteStreams = PromptStreams & {
  readonly saved?: { readonly route: ModelRoute; readonly flags: string };
  readonly hasEnv: (name: string) => boolean;
  readonly priceList: string;
};

export function isApiKeyEnvName(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/u.test(value);
}

export function isShareableBaseUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === "" &&
    url.search === ""
  );
}

export async function promptForModelRoute(
  options: RouteStreams & {
    readonly plans?: () => Promise<readonly PlanLoginStatus[]>;
  },
): Promise<ModelRoute | undefined> {
  if (options.saved !== undefined) {
    options.output.write(
      `Models: ${options.saved.flags} (saved for this repository)\n`,
    );
    const asked = await question(
      options,
      "Press Enter to keep, or type c to choose again [keep]: ",
      (answer) => {
        if (/^c?$/iu.test(answer.trim())) return true;
        options.output.write(
          "Press Enter to keep the saved route, or type c to choose again.\n",
        );
        return false;
      },
    );
    if (asked.cancelled) return undefined;
    if (asked.answer.trim() === "") return options.saved.route;
  }
  let route: ModelRoute | undefined;
  if (options.plans === undefined) {
    options.output.write(
      "Mode B confirmation (--modeb-config) needs an API key for candidates and the judge, so only OpenRouter, Vercel AI Gateway and other endpoints are offered.\n",
    );
    const api = await askMultiVendorApi(options, "Which provider or gateway?");
    route = api && { route: "api", judgeRoute: "api", api };
  } else {
    route = await askRoute(options, await options.plans());
  }
  return route !== undefined && (await consented(options, route))
    ? route
    : undefined;
}

async function askRoute(
  options: RouteStreams,
  statuses: readonly PlanLoginStatus[],
): Promise<ModelRoute | undefined> {
  const ready = statuses.filter(({ ready }) => ready).map(({ kind }) => kind);
  const way = await menu(
    options,
    [
      "How should rightmodeler call models? Replay sends your recorded calls to cheaper models, and a judge model from another vendor grades each answer.",
      ...statuses.map(({ line }) => `  ${line}`),
    ],
    [
      "My plans, through the CLIs signed in on this machine",
      "An API key for a model provider or gateway",
    ],
    ready.length > 0 ? 1 : 2,
    (choice) =>
      choice === 1 && ready.length === 0
        ? "Neither CLI is ready; each line above says how to fix it. Choose 2 to use an API key."
        : undefined,
  );
  if (way === undefined) return undefined;
  if (way === 2) return askApiRoute(options, ready);
  const candidates = await menu(
    options,
    ["Replay candidates through (choose the vendor your app calls today):"],
    ready.map((kind) => `${planClis[kind].command} (${planClis[kind].models})`),
    1,
  );
  if (candidates === undefined) return undefined;
  const route = ready[candidates - 1]!;
  const judges = ready.filter((kind) => kind !== route);
  const judge = await menu(
    options,
    ["Judge through:"],
    [
      ...judges.map(
        (kind) => `${planClis[kind].command} (${planClis[kind].plan})`,
      ),
      "An API key for a provider or gateway",
    ],
    1,
  );
  if (judge === undefined) return undefined;
  if (judge <= judges.length) return { route, judgeRoute: judges[judge - 1]! };
  const api = await askMultiVendorApi(
    options,
    "Which provider or gateway for judge calls?",
  );
  return api && { route, judgeRoute: "api", api };
}

async function askApiRoute(
  options: RouteStreams,
  ready: readonly PlanRouteKind[],
): Promise<ModelRoute | undefined> {
  const presets = [
    "openrouter",
    "vercel",
    "openai",
    "anthropic",
    "other",
  ] as const;
  for (;;) {
    const choice = await menu(
      options,
      ["Which provider or gateway?"],
      presets.map((preset) =>
        preset === "openai" || preset === "anthropic"
          ? ready.includes(singleVendorPresets[preset].judge)
            ? singleVendorPresets[preset].usable
            : singleVendorPresets[preset].unusable
          : apiPresets[preset].label,
      ),
      1,
    );
    if (choice === undefined) return undefined;
    const preset = presets[choice - 1]!;
    if (preset !== "openai" && preset !== "anthropic") {
      const api = await askApi(options, preset);
      return api && { route: "api", judgeRoute: "api", api };
    }
    const { judge, explanation } = singleVendorPresets[preset];
    if (!ready.includes(judge)) {
      options.output.write(`${explanation}\n`);
      continue;
    }
    const api = await askApi(options, preset);
    return (
      api && {
        route: "api",
        judgeRoute: judge,
        api: { ...api, catalogReference: options.priceList },
      }
    );
  }
}

async function askMultiVendorApi(
  options: RouteStreams,
  heading: string,
): Promise<ModelRouteApi | undefined> {
  const presets = ["openrouter", "vercel", "other"] as const;
  const choice = await menu(
    options,
    [heading],
    presets.map((preset) => apiPresets[preset].label),
    1,
  );
  return choice === undefined
    ? undefined
    : askApi(options, presets[choice - 1]!);
}

async function askApi(
  options: RouteStreams,
  preset: ApiPreset,
): Promise<ModelRouteApi | undefined> {
  const { output } = options;
  let baseUrl: string | undefined = apiPresets[preset].baseUrl;
  if (baseUrl === undefined) {
    const asked = await question(
      options,
      "Base URL of the endpoint, usually ending in /v1: ",
      (answer) => {
        if (isShareableBaseUrl(answer.trim())) return true;
        output.write(
          "Enter an http or https URL without a user name, password or query string, such as https://litellm.example.com/v1.\n",
        );
        return false;
      },
    );
    if (asked.cancelled) return undefined;
    baseUrl = asked.answer.trim();
  }
  const fallback = apiPresets[preset].apiKeyEnv;
  const named = await question(
    options,
    `Environment variable that holds ${apiPresets[preset].key} [${fallback}]: `,
    (answer) => {
      const name = answer.trim();
      if (name === "" || isApiKeyEnvName(name)) return true;
      output.write(
        "Enter the variable's name, such as OPENROUTER_API_KEY, not the key itself.\n",
      );
      return false;
    },
  );
  if (named.cancelled) return undefined;
  const apiKeyEnv = named.answer.trim() === "" ? fallback : named.answer.trim();
  output.write(
    options.hasEnv(apiKeyEnv)
      ? `${apiKeyEnv} is set.\n`
      : `${apiKeyEnv} is not set in this shell. Set it in your own shell before replay; rightmodeler never asks for the key and never stores it.\n`,
  );
  return { preset, baseUrl, apiKeyEnv };
}

async function consented(
  options: RouteStreams,
  route: ModelRoute,
): Promise<boolean> {
  const kinds = [route.route, route.judgeRoute].filter(isPlanRouteKind);
  const saved = options.saved?.route;
  if (
    kinds.every((kind) => kind === saved?.route || kind === saved?.judgeRoute)
  ) {
    return true;
  }
  const through = (kind: ModelRoute["route"]): string =>
    kind === "api"
      ? `${route.api!.baseUrl}, billed to your key`
      : `${planClis[kind].command} under your own login`;
  const used = (["claude-login", "codex-login"] as const).filter((kind) =>
    kinds.includes(kind),
  );
  const { output } = options;
  output.write(
    `Replays will run through ${through(route.route)} and judge calls through ${through(route.judgeRoute)}.\n`,
  );
  output.write(
    "- Calls through a CLI use your plan's usage limits, the same 5-hour and weekly limits as your own coding. If a limit is reached, rightmodeler stops; rerun after the reset to continue.\n",
  );
  output.write(
    `- Prompts from your traces go to ${used.map((kind) => planClis[kind].vendor).join(" and ")} under your plan's data settings.\n`,
  );
  output.write(
    "- rightmodeler never reads your logins, and keeps API key variables away from the CLIs.\n",
  );
  output.write(
    `- A coding CLI adds its own instructions to each call and cannot set temperature or an output limit.${used.includes("claude-login") ? " claude's instructions include your account email and today's date." : ""}${used.includes("codex-login") ? " codex also adds your global Codex instructions file when you have one." : ""} The report labels results measured this way.\n`,
  );
  const asked = await question(
    options,
    `Send recorded prompts through your ${used.length > 1 ? "plans" : "plan"}? [y/N]: `,
  );
  return !asked.cancelled && /^y(?:es)?$/iu.test(asked.answer.trim());
}

async function menu(
  options: PromptStreams,
  heading: readonly string[],
  items: readonly string[],
  fallback: number,
  refuse: (choice: number) => string | undefined = () => undefined,
): Promise<number | undefined> {
  for (const line of heading) options.output.write(`${line}\n`);
  for (const [index, item] of items.entries()) {
    options.output.write(`${index + 1}. ${item}\n`);
  }
  let chosen = fallback;
  const asked = await question(options, `Choose [${fallback}]: `, (answer) => {
    const typed = answer.trim();
    chosen =
      typed === "" ? fallback : /^[0-9]+$/u.test(typed) ? Number(typed) : 0;
    if (chosen < 1 || chosen > items.length) {
      options.output.write(`Choose a number from 1 to ${items.length}.\n`);
      return false;
    }
    const refusal = refuse(chosen);
    if (refusal !== undefined) options.output.write(`${refusal}\n`);
    return refusal === undefined;
  });
  return asked.cancelled ? undefined : chosen;
}

interface Asked {
  readonly answer: string;
  // True when the prompt ended without an answer (Ctrl-C, Ctrl-D, or a closed
  // stream) rather than by the user pressing enter; enter on an empty line is
  // an ANSWER of "", which pickers use to accept their default.
  readonly cancelled: boolean;
}

function question(
  streams: PromptStreams,
  prompt: string,
  accept: (answer: string) => boolean = () => true,
): Promise<Asked> {
  const readline = createInterface({
    input: streams.input,
    output: streams.output,
  });
  return new Promise((resolveAnswer) => {
    let settled = false;
    const finish = (asked: Asked): void => {
      if (settled) return;
      settled = true;
      resolveAnswer(asked);
    };
    const ask = (): void => {
      readline.question(prompt, (answer) => {
        if (!accept(answer)) {
          ask();
          return;
        }
        finish({ answer, cancelled: false });
        readline.close();
      });
    };
    readline.once("close", () => finish({ answer: "", cancelled: true }));
    streams.input.once("close", () => {
      readline.close();
      finish({ answer: "", cancelled: true });
    });
    streams.output.once("close", () => {
      readline.close();
      finish({ answer: "", cancelled: true });
    });
    ask();
  });
}

function formatName(format: TraceFormat): string {
  const names: Record<TraceFormat, string> = {
    "otel-genai": "OpenTelemetry GenAI export",
    "ai-sdk": "AI SDK telemetry export",
    "openai-jsonl": "OpenAI log",
    langfuse: "Langfuse export",
    braintrust: "Braintrust export",
    langsmith: "LangSmith export",
    openinference: "OpenInference export",
    helicone: "Helicone export",
    weave: "Weave export",
    "claude-code": "Claude Code session",
    codex: "Codex session",
    bifrost: "Bifrost log export",
  };
  return names[format];
}

function shortPath(path: string, repo: string, homeDir: string): string {
  const fromRepo = relative(resolve(repo), path);
  if (fromRepo !== "" && !fromRepo.startsWith("..") && !isAbsolute(fromRepo)) {
    return `./${fromRepo}`;
  }
  const fromHome = relative(resolve(homeDir), path);
  if (fromHome !== "" && !fromHome.startsWith("..") && !isAbsolute(fromHome)) {
    return `~/${fromHome}`;
  }
  return path;
}

function formatAge(modifiedAt: Date, now: Date): string {
  const seconds = Math.max(
    0,
    Math.floor((now.getTime() - modifiedAt.getTime()) / 1_000),
  );
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${unit("minute", minutes)} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${unit("hour", hours)} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${unit("day", days)} ago`;
}

function unit(label: string, value: number): string {
  return value === 1 ? label : `${label}s`;
}
