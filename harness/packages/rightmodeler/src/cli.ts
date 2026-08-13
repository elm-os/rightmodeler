#!/usr/bin/env node

import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Command, CommanderError, Option } from "commander";

import {
  PIPELINE_STAGES,
  planPipeline,
  readReport,
  readStatus,
  runAuditTabulate,
  runApply,
  runPipeline,
  type PipelineOptions,
  type PipelineStage,
} from "./pipeline.js";
import { createGithubClient } from "./github/index.js";
import {
  processIo,
  Reporter,
  type CliIo,
  type OutputMode,
} from "./protocol.js";
import { version } from "./version.js";

interface GlobalOptions {
  repo: string;
  store?: string;
  output: OutputMode;
}

interface PipelineCommandOptions {
  traces?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  evaluator?: "braintrust";
  evaluatorBaseUrl?: string;
  evaluatorApiKeyEnv?: string;
  evaluatorProjectId?: string;
  evaluatorScorer?: string[];
  evaluatorGateMetric?: string;
  evaluatorGateThreshold?: string;
  maxCostUsd?: string;
  modebConfig?: string;
  through?: PipelineStage;
  plan?: boolean;
  yes?: boolean;
}

interface AuditTabulateOptions {
  worksheet?: string;
}

interface ApplyCommandOptions {
  owner: string;
  githubBaseUrl: string;
  githubTokenEnv: string;
  dryRun?: boolean;
}

export interface ProgramHandle {
  program: Command;
  exitCode(): number;
}

export function createProgram(io: CliIo = processIo): ProgramHandle {
  let code = 0;
  const program = new Command()
    .name("rightmodeler")
    .description("Find and prove safe model substitutions.")
    .addHelpText(
      "after",
      "\nExit codes are command-specific: apply uses 0 applied/clean dry-run, 1 refused, >=10 runtime error; pipeline commands use 0 no recommendation, 1 recommendation exists, 2 needs input, 3 budget, >=10 runtime error.\n",
    )
    .version(version)
    .option("--repo <dir>", "repository to analyze", process.cwd())
    .option("--store <dir>", "store directory")
    .addOption(
      new Option("--output <mode>", "output mode")
        .choices(["human", "json", "jsonl"])
        .default("human"),
    )
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout(text),
      writeErr: (text) => io.stderr(text),
    });

  const run = (
    command: Command,
    action: (reporter: Reporter, global: GlobalOptions) => Promise<number>,
  ): void => {
    command.action(async (_options: unknown, invoked: Command) => {
      const global = invoked.optsWithGlobals<GlobalOptions>();
      const reporter = new Reporter(global.output, io);
      try {
        code = await action(reporter, global);
      } catch (error) {
        code = reporter.error(error);
      }
    });
  };

  const init = addPipelineOptions(
    program.command("init").description("run the resumable Phase A pipeline"),
    true,
  );
  run(init, async (reporter, global) => {
    const local = init.opts<PipelineCommandOptions>();
    const options = pipelineOptions(global, local, reporter);
    const result = local.plan
      ? {
          stages: await planPipeline(options),
          executedStages: [],
          verdicts: [],
          recommendationExists: false,
        }
      : await runPipeline(options);
    reporter.result(result);
    return local.plan ||
      (local.through !== undefined && local.through !== "report")
      ? 0
      : result.recommendationExists
        ? 1
        : 0;
  });

  for (const stage of PIPELINE_STAGES.slice(0, -1)) {
    if (stage === "audit-sample") continue;
    const command = addPipelineOptions(
      program.command(stage).description(`run through the ${stage} stage`),
      stage === "replay" || stage === "confirm",
    );
    run(command, async (reporter, global) => {
      const result = await runPipeline({
        ...pipelineOptions(
          global,
          command.opts<PipelineCommandOptions>(),
          reporter,
        ),
        through: stage,
      });
      reporter.result(result);
      return 0;
    });
  }

  const audit = program
    .command("audit")
    .description("manage the reference audit");
  const auditSample = addPipelineOptions(
    audit
      .command("sample")
      .description("write the audit worksheet without blocking"),
    false,
  );
  run(auditSample, async (reporter, global) => {
    const result = await runPipeline({
      ...pipelineOptions(
        global,
        auditSample.opts<PipelineCommandOptions>(),
        reporter,
      ),
      through: "audit-sample",
    });
    reporter.result(result);
    return 0;
  });

  const auditTabulate = audit
    .command("tabulate")
    .description("tabulate a completed audit worksheet")
    .option("--worksheet <path>", "completed worksheet JSON file");
  run(auditTabulate, async (reporter, global) => {
    const result = await runAuditTabulate({
      repo: global.repo,
      store: global.store,
      worksheet: auditTabulate.opts<AuditTabulateOptions>().worksheet,
    });
    reporter.result(result);
    return 0;
  });

  const apply = program
    .command("apply")
    .description("open a draft pull request for proven model swaps")
    .requiredOption("--owner <owner>", "GitHub repository owner")
    .requiredOption("--github-base-url <url>", "GitHub API base URL")
    .requiredOption(
      "--github-token-env <name>",
      "environment variable containing the GitHub token",
    )
    .option("--dry-run", "run all machine gates without writing GitHub state");
  run(apply, async (reporter, global) => {
    const local = apply.opts<ApplyCommandOptions>();
    const result = await runApply({
      repo: global.repo,
      store: global.store,
      githubClient: createGithubClient({
        baseUrl: local.githubBaseUrl,
        tokenEnv: local.githubTokenEnv,
      }),
      owner: local.owner,
      githubRepo: basename(resolve(global.repo)),
      dryRun: local.dryRun ?? false,
    });
    reporter.result(result);
    return result.status === "refused" ? 1 : 0;
  });

  const report = program
    .command("report")
    .description("write report.md and report.json");
  run(report, async (reporter, global) => {
    const result = await readReport(global);
    reporter.result({ ...result.report, reportPath: result.reportPath });
    return result.recommends ? 1 : 0;
  });

  const status = program
    .command("status")
    .description("summarize the current store");
  run(status, async (reporter, global) => {
    reporter.result(await readStatus(global));
    return 0;
  });

  return { program, exitCode: () => code };
}

function addPipelineOptions(command: Command, provider: boolean): Command {
  command
    .option("--traces <path>", "trace input file")
    .option(
      "--modeb-config <path>",
      "versioned Mode B runtime configuration JSON file",
    );
  if (provider) {
    command
      .option("--base-url <url>", "OpenAI-compatible provider base URL")
      .option(
        "--api-key-env <name>",
        "environment variable containing the provider API key",
      )
      .option("--max-cost-usd <amount>", "maximum replay spend in USD")
      .addOption(
        new Option(
          "--evaluator <provider>",
          "external evaluator provider",
        ).choices(["braintrust"]),
      )
      .option("--evaluator-base-url <url>", "external evaluator API base URL")
      .option(
        "--evaluator-api-key-env <name>",
        "environment variable containing the evaluator API key",
      )
      .option(
        "--evaluator-project-id <id>",
        "external evaluator project identifier",
      )
      .option(
        "--evaluator-scorer <name>",
        "external evaluator scorer name (repeatable)",
        collectOption,
      )
      .option(
        "--evaluator-gate-metric <name>",
        "scorer metric used for release gates",
      )
      .option(
        "--evaluator-gate-threshold <value>",
        "fallback pass threshold when the evaluator omits a pass decision",
      );
  }
  if (command.name() === "init") {
    command
      .option("--plan", "print stage states without executing")
      .addOption(
        new Option("--through <stage>", "stop after this stage").choices([
          ...PIPELINE_STAGES,
        ]),
      )
      .option("--yes", "accept defaults (reserved for future prompts)");
  }
  return command;
}

function pipelineOptions(
  global: GlobalOptions,
  local: PipelineCommandOptions,
  reporter: Reporter,
): PipelineOptions {
  const maxCostUsd =
    local.maxCostUsd === undefined ? undefined : Number(local.maxCostUsd);
  if (
    maxCostUsd !== undefined &&
    (!Number.isFinite(maxCostUsd) || maxCostUsd < 0)
  ) {
    throw new Error("--max-cost-usd must be a non-negative number");
  }
  const evaluatorGateThreshold =
    local.evaluatorGateThreshold === undefined
      ? undefined
      : Number(local.evaluatorGateThreshold);
  if (
    evaluatorGateThreshold !== undefined &&
    !Number.isFinite(evaluatorGateThreshold)
  ) {
    throw new Error("--evaluator-gate-threshold must be a finite number");
  }
  const hasEvaluatorCompanion =
    local.evaluatorBaseUrl !== undefined ||
    local.evaluatorApiKeyEnv !== undefined ||
    local.evaluatorProjectId !== undefined ||
    local.evaluatorScorer !== undefined ||
    local.evaluatorGateMetric !== undefined ||
    evaluatorGateThreshold !== undefined;
  if (local.evaluator === undefined && hasEvaluatorCompanion) {
    throw new Error("Evaluator options require --evaluator braintrust");
  }
  if (local.evaluator !== undefined && local.evaluatorProjectId === undefined) {
    throw new Error(
      "--evaluator-project-id is required with --evaluator braintrust",
    );
  }
  if (local.evaluator !== undefined && local.evaluatorScorer === undefined) {
    throw new Error(
      "At least one --evaluator-scorer is required with --evaluator braintrust",
    );
  }
  return {
    repo: global.repo,
    store: global.store,
    traces: local.traces,
    baseUrl: local.baseUrl,
    apiKeyEnv: local.apiKeyEnv,
    maxCostUsd,
    ...(local.evaluator === undefined
      ? {}
      : {
          evaluator: {
            apiKeyEnv: local.evaluatorApiKeyEnv ?? "BRAINTRUST_API_KEY",
            baseUrl: local.evaluatorBaseUrl ?? "https://api.braintrust.dev",
            projectId: local.evaluatorProjectId!,
            scorers: local.evaluatorScorer!,
            ...(local.evaluatorGateMetric === undefined
              ? {}
              : { gateMetric: local.evaluatorGateMetric }),
            ...(evaluatorGateThreshold === undefined
              ? {}
              : { gateThreshold: evaluatorGateThreshold }),
          },
        }),
    modeBConfigPath: local.modebConfig,
    through: local.through,
    plan: local.plan,
    reporter,
  };
}

function collectOption(value: string, previous?: string[]): string[] {
  return [...(previous ?? []), value];
}

export async function executeCli(
  argv: readonly string[],
  io: CliIo = processIo,
): Promise<number> {
  const handle = createProgram(io);
  try {
    await handle.program.parseAsync([...argv], { from: "user" });
    return handle.exitCode();
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed") return 0;
      return error.exitCode >= 10 ? error.exitCode : 10;
    }
    const outputIndex = argv.indexOf("--output");
    const mode = argv[outputIndex + 1];
    const reporter = new Reporter(
      mode === "json" || mode === "jsonl" ? mode : "human",
      io,
    );
    return reporter.error(error);
  }
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  process.exitCode = await executeCli(process.argv.slice(2));
}
