import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { isAbsolute, relative, resolve } from "node:path";

import type { DiscoveredTrace } from "./data/discover.js";
import type { TraceFormat } from "./data/index.js";

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

export async function promptForProviderBaseUrl(
  options: PromptStreams & { readonly current?: string },
): Promise<string | undefined> {
  options.output.write(
    "Replay calls cheaper models through any OpenAI-compatible endpoint, such as OpenRouter or the Vercel AI Gateway.\n",
  );
  const suffix = options.current === undefined ? "" : ` [${options.current}]`;
  const asked = await question(options, `Provider base URL${suffix}: `);
  if (asked.cancelled) return options.current;
  const answer = asked.answer.trim();
  return answer === "" ? options.current : answer;
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
    "openai-jsonl": "OpenAI log",
    langfuse: "Langfuse export",
    braintrust: "Braintrust export",
    langsmith: "LangSmith export",
    openinference: "OpenInference export",
    helicone: "Helicone export",
    weave: "Weave export",
    "claude-code": "Claude Code session",
    codex: "Codex session",
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
