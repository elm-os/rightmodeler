#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Writable, type Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { Argument, Command, CommanderError, Option } from "commander";

import {
  PIPELINE_STAGES,
  beginDetachedReplayWorker,
  claimDetachedReplay,
  estimateReplay,
  listApprovedSwapSets,
  listWatchablePullRequests,
  planPipeline,
  readActiveDetachedReplay,
  readIngestResumption,
  readReport,
  readRunStatus,
  readStatus,
  runAuditTabulate,
  runCorpusImport,
  runPipeline,
  runResultExport,
  runWatch,
  type PipelineOptions,
  type PipelineStage,
} from "./pipeline.js";
import {
  applySwaps,
  type ApplySwapsOptions,
  type ApplySwapsResult,
} from "./apply/index.js";
import { createGithubClient } from "./github/index.js";
import {
  processIo,
  ProtocolError,
  Reporter,
  type CliIo,
  type OutputMode,
} from "./protocol.js";
import { discoverTraces, type DiscoveredTrace } from "./data/discover.js";
import { TraceAdaptError } from "./data/index.js";
import { promptForProviderBaseUrl, promptForTracePath } from "./guidance.js";
import {
  approveDriftProposal,
  publishDriftProposal,
  runDrift,
  type ApproveDriftProposalOptions,
  type PublishDriftProposalOptions,
  type RunDriftOptions,
} from "./drift.js";
import {
  rollbackSwaps,
  type RollbackResult,
  type RollbackSwapsOptions,
} from "./rollback.js";
import { version } from "./version.js";
import { docNames, readDoc } from "./cli-docs.js";

interface GlobalOptions {
  repo: string;
  store?: string;
  output: OutputMode;
}

interface PipelineCommandOptions {
  traces?: string;
  matchers?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  evaluator?: "braintrust" | "langfuse" | "langsmith" | "promptfoo";
  evaluatorBaseUrl?: string;
  evaluatorApiKeyEnv?: string;
  evaluatorPublicKeyEnv?: string;
  evaluatorProjectId?: string;
  evaluatorCommand?: string;
  evaluatorConfig?: string;
  evaluatorScorer?: string[];
  evaluatorGateMetric?: string;
  evaluatorGateThreshold?: string;
  maxCostUsd?: string;
  maxConcurrency?: string;
  pricingFile?: string;
  includeFree?: boolean;
  modebConfig?: string;
  through?: PipelineStage;
  plan?: boolean;
  yes?: boolean;
  detach?: boolean;
  internalRunId?: string;
  approvedRun?: string;
}

interface AuditTabulateOptions {
  worksheet?: string;
}

interface CorpusImportOptions {
  from: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  publicKeyEnv?: string;
}

interface ExportCommandOptions {
  to: "braintrust" | "langfuse";
  baseUrl?: string;
  apiKeyEnv?: string;
  publicKeyEnv?: string;
  projectId?: string;
  datasetId?: string;
}

interface ApplyCommandOptions {
  owner: string;
  githubRepo?: string;
  githubBaseUrl: string;
  githubTokenEnv: string;
  dryRun?: boolean;
}

interface RollbackCommandOptions {
  owner: string;
  githubRepo?: string;
  pr: string;
  githubBaseUrl: string;
  githubTokenEnv: string;
}

interface DriftCommandOptions {
  traces?: string;
}

interface DriftApproveCommandOptions {
  proposal: string;
  actor: string;
  reason?: string;
}

interface DriftPublishCommandOptions {
  proposal: string;
}

interface WatchCommandOptions {
  owner: string;
  githubRepo: string;
  pr: string;
  githubBaseUrl: string;
  githubTokenEnv: string;
}

interface StatusCommandOptions {
  run?: string;
}

export interface ProgramHandle {
  program: Command;
  exitCode(): number;
  usageOutput(): string;
}

interface CliRuntime {
  readonly stdin: Readable & { readonly isTTY?: boolean };
  readonly stdout: Writable & { readonly isTTY?: boolean };
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
  now(): Date;
}

const processRuntime: CliRuntime = {
  stdin: process.stdin,
  stdout: process.stdout,
  env: process.env,
  homeDir: homedir(),
  now: () => new Date(),
};

export function createProgram(
  io: CliIo = processIo,
  runtime: CliRuntime = processRuntime,
): ProgramHandle {
  let code = 0;
  let usageOutput = "";
  const program = new Command()
    .name("rightmodeler")
    .description("Find and prove safe model substitutions.")
    .addHelpText(
      "after",
      "\nExit codes are command-specific: apply and rollback use 0 success, 1 refused, >=10 runtime error; drift uses 0 success, 2 needs input, >=10 runtime error; watch uses 0 quiet, 1 actions taken, 2 lock held elsewhere, >=10 runtime error; pipeline commands use 0 no recommendation, 1 recommendation exists, 2 needs input, 3 budget, >=10 runtime error.\n",
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
      writeErr: (text) => {
        usageOutput += text;
      },
    });

  const run = (
    command: Command,
    action: (reporter: Reporter, global: GlobalOptions) => Promise<number>,
  ): void => {
    command.action(async () => {
      const global = command.optsWithGlobals<GlobalOptions>();
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
    const prepared = await guidedPipelineOptions(
      global,
      local,
      reporter,
      runtime,
    );
    const result = await withInputGuidance(
      prepared,
      local,
      runtime,
      async (options) =>
        local.plan
          ? {
              ...(await planPipeline(options)),
              executedStages: [],
              verdicts: [],
              recommendationExists: false,
            }
          : runPipeline(options),
    );
    reporter.result(result);
    return local.plan ||
      (local.through !== undefined && local.through !== "report")
      ? 0
      : result.recommendationExists
        ? 1
        : 0;
  });

  const estimate = addPipelineOptions(
    program
      .command("estimate")
      .description("project replay spend before paid model calls"),
    true,
  ).option(
    "--approved-run <digest>",
    "scope projection to one merged approved swap",
  );
  run(estimate, async (reporter, global) => {
    const local = estimate.opts<PipelineCommandOptions>();
    const prepared = await guidedPipelineOptions(
      global,
      local,
      reporter,
      runtime,
    );
    const result = await withInputGuidance(
      prepared,
      local,
      runtime,
      async (options) => {
        await runPipeline({ ...options, through: "shortlist" });
        return estimateReplay(options);
      },
    );
    reporter.result(result);
    return 0;
  });

  for (const stage of PIPELINE_STAGES.slice(0, -1)) {
    if (stage === "audit-sample" || stage === "corpus") continue;
    const command = addPipelineOptions(
      program.command(stage).description(`run through the ${stage} stage`),
      stage === "replay" || stage === "confirm",
    );
    if (stage === "replay") {
      command
        .option("--detach", "enqueue replay and return its run identifier")
        .option(
          "--approved-run <digest>",
          "regression-test one merged approved swap",
        )
        .addOption(new Option("--internal-run-id <runId>").hideHelp());
    }
    run(command, async (reporter, global) => {
      const local = command.opts<PipelineCommandOptions>();
      const options = pipelineOptions(global, local, reporter);
      const replayTarget =
        stage === "replay" && local.approvedRun !== undefined
          ? "aggregate"
          : stage;
      if (stage === "replay" && local.detach) {
        if (local.internalRunId !== undefined) {
          throw new Error("--detach cannot be combined with --internal-run-id");
        }
        const claim = await claimDetachedReplay({
          ...options,
          through: replayTarget,
        });
        if (!claim.terminal) {
          await startDetachedReplay(global, local, claim.runId);
        }
        reporter.result(claim);
        return 0;
      }
      if (
        stage === "replay" &&
        local.internalRunId !== undefined &&
        !(await beginDetachedReplayWorker(options, local.internalRunId))
      ) {
        reporter.result(
          await readRunStatus({ ...global, runId: local.internalRunId }),
        );
        return 0;
      }
      const result = await runPipeline({
        ...options,
        through: replayTarget,
        ...(stage === "replay" && local.internalRunId !== undefined
          ? { existingRunId: local.internalRunId }
          : {}),
      });
      reporter.result(result);
      return 0;
    });
  }

  const corpus = addPipelineOptions(
    program.command("corpus").description("build or import the replay corpus"),
    false,
  );
  run(corpus, async (reporter, global) => {
    const result = await runPipeline({
      ...pipelineOptions(
        global,
        corpus.opts<PipelineCommandOptions>(),
        reporter,
      ),
      through: "corpus",
    });
    reporter.result(result);
    return 0;
  });

  const corpusImport = corpus
    .command("import")
    .description("import a curated provider dataset")
    .requiredOption("--from <provider:dataset>", "provider and dataset")
    .option("--base-url <url>", "dataset provider API base URL")
    .option(
      "--api-key-env <name>",
      "environment variable containing the dataset provider API key",
    )
    .option(
      "--public-key-env <name>",
      "environment variable containing the Langfuse public key",
    );
  run(corpusImport, async (reporter, global) => {
    const local = corpusImport.opts<CorpusImportOptions>();
    const source = parseCorpusSource(local.from);
    const result = await runCorpusImport({
      repo: global.repo,
      store: global.store,
      config: corpusImportConfig(source, local),
    });
    reporter.result({
      corpusVersionId: result.corpusVersionId,
      caseCount: result.cases.length,
      curatedVerifiedCases: result.cases.filter(
        ({ content }) => content.referenceVerified,
      ).length,
    });
    return 0;
  });

  const exportCommand = program
    .command("export")
    .description("export trials and verdicts to an evaluation provider")
    .addOption(
      new Option("--to <provider>", "result sink provider")
        .choices(["braintrust", "langfuse"])
        .makeOptionMandatory(),
    )
    .option("--base-url <url>", "result sink API base URL")
    .option(
      "--api-key-env <name>",
      "environment variable containing the result sink API key",
    )
    .option(
      "--public-key-env <name>",
      "environment variable containing the Langfuse public key",
    )
    .option("--project-id <id>", "Braintrust project identifier")
    .option("--dataset-id <id>", "Langfuse dataset identifier");
  run(exportCommand, async (reporter, global) => {
    const local = exportCommand.opts<ExportCommandOptions>();
    const result = await runResultExport({
      repo: global.repo,
      store: global.store,
      config: resultSinkConfig(local),
    });
    reporter.result(result);
    return 0;
  });

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
    .option(
      "--github-repo <repo>",
      "GitHub repository name (default: the repository directory name)",
    )
    .requiredOption("--github-base-url <url>", "GitHub API base URL")
    .requiredOption(
      "--github-token-env <name>",
      "environment variable containing the GitHub token",
    )
    .option("--dry-run", "run all machine gates without writing GitHub state");
  run(apply, async (reporter, global) => {
    const local = apply.opts<ApplyCommandOptions>();
    const result = await applySwaps({
      repo: global.repo,
      store: global.store,
      owner: local.owner,
      ...(local.githubRepo === undefined
        ? {}
        : { githubRepo: local.githubRepo }),
      githubBaseUrl: local.githubBaseUrl,
      githubTokenEnv: local.githubTokenEnv,
      dryRun: local.dryRun ?? false,
    });
    reporter.result(result);
    return result.status === "refused" ? 1 : 0;
  });

  const rollback = program
    .command("rollback")
    .description("open a draft pull request restoring a prior model swap")
    .requiredOption("--owner <owner>", "GitHub repository owner")
    .option(
      "--github-repo <repo>",
      "GitHub repository name (default: the repository directory name)",
    )
    .requiredOption("--pr <number>", "merged pull request number")
    .requiredOption("--github-base-url <url>", "GitHub API base URL")
    .requiredOption(
      "--github-token-env <name>",
      "environment variable containing the GitHub token",
    );
  run(rollback, async (reporter, global) => {
    const local = rollback.opts<RollbackCommandOptions>();
    const prNumber = Number(local.pr);
    if (!Number.isSafeInteger(prNumber) || prNumber < 1) {
      throw new Error("--pr must be a positive integer");
    }
    const result = await rollbackSwaps({
      repo: global.repo,
      store: global.store,
      owner: local.owner,
      ...(local.githubRepo === undefined
        ? {}
        : { githubRepo: local.githubRepo }),
      githubBaseUrl: local.githubBaseUrl,
      githubTokenEnv: local.githubTokenEnv,
      prNumber,
    });
    reporter.result(result);
    return result.status === "refused" ? 1 : 0;
  });

  const drift = program
    .command("drift")
    .description("detect drift against the active replay corpus")
    .option("--traces <path>", "new trace batch");
  run(drift, async (reporter, global) => {
    const traces = drift.opts<DriftCommandOptions>().traces;
    if (traces === undefined) {
      throw new ProtocolError({
        exitCode: 2,
        code: "missing_traces_path",
        message: "--traces is required",
        remedy: "Pass --traces <path> with the new trace batch.",
      });
    }
    const result = await runDrift({
      repo: global.repo,
      store: global.store,
      traces,
    });
    reporter.result(result);
    return 0;
  });

  const driftApprove = drift
    .command("approve")
    .description("approve a stored corpus drift proposal")
    .requiredOption("--proposal <id>", "drift proposal SHA-256 identifier")
    .requiredOption("--actor <name>", "approving actor")
    .option("--reason <text>", "approval reason");
  run(driftApprove, async (reporter, global) => {
    const local = driftApprove.opts<DriftApproveCommandOptions>();
    const result = await approveDriftProposal({
      repo: global.repo,
      store: global.store,
      proposalId: local.proposal,
      actor: local.actor,
      ...(local.reason === undefined ? {} : { reason: local.reason }),
    });
    reporter.result(result);
    return 0;
  });

  const driftPublish = drift
    .command("publish")
    .description("publish an approved corpus drift proposal")
    .requiredOption("--proposal <id>", "drift proposal SHA-256 identifier");
  run(driftPublish, async (reporter, global) => {
    const local = driftPublish.opts<DriftPublishCommandOptions>();
    const result = await publishDriftProposal({
      repo: global.repo,
      store: global.store,
      proposalId: local.proposal,
    });
    reporter.result(result);
    return 0;
  });

  const watch = program
    .command("watch")
    .description("reconcile one open model-swap pull request")
    .requiredOption("--owner <owner>", "GitHub repository owner")
    .requiredOption("--github-repo <repo>", "GitHub repository name")
    .requiredOption("--pr <number>", "pull request number")
    .requiredOption("--github-base-url <url>", "GitHub API base URL")
    .requiredOption(
      "--github-token-env <name>",
      "environment variable containing the GitHub token",
    );
  run(watch, async (reporter, global) => {
    const local = watch.opts<WatchCommandOptions>();
    const prNumber = Number(local.pr);
    if (!Number.isSafeInteger(prNumber) || prNumber < 1) {
      throw new Error("--pr must be a positive integer");
    }
    const result = await runWatch({
      repo: global.repo,
      store: global.store,
      githubClient: createGithubClient({
        baseUrl: local.githubBaseUrl,
        tokenEnv: local.githubTokenEnv,
      }),
      owner: local.owner,
      githubRepo: local.githubRepo,
      prNumber,
    });
    reporter.result(result);
    return result.status === "lock_held"
      ? 2
      : result.status === "actions_taken"
        ? 1
        : 0;
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
    .description("summarize the current store")
    .option("--run <runId>", "report one detached replay run");
  run(status, async (reporter, global) => {
    const runId = status.opts<StatusCommandOptions>().run;
    reporter.result(
      runId === undefined
        ? await readStatus(global)
        : await readRunStatus({ ...global, runId }),
    );
    return 0;
  });

  const docs = program
    .command("docs")
    .description("print documentation packaged with this CLI")
    .addArgument(
      new Argument("[name]", "packaged document name").choices(docNames()),
    );
  run(docs, async (reporter) => {
    const name = docs.processedArgs[0] as string | undefined;
    reporter.result(name === undefined ? { docs: docNames() } : readDoc(name));
    return 0;
  });

  return {
    program,
    exitCode: () => code,
    usageOutput: () => usageOutput,
  };
}

function addPipelineOptions(command: Command, provider: boolean): Command {
  command
    .option("--traces <path>", "trace input file or directory")
    .option("--matchers <path>", "declarative matcher definitions JSON file")
    .option(
      "--include-free",
      "include zero-priced models in candidate shortlists",
    )
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
      .option(
        "--max-cost-usd <amount>",
        "optional hard spend cap in USD; omit to run uncapped so every case and judge cell completes",
      )
      .option("--max-concurrency <n>", "maximum concurrent provider requests")
      .option(
        "--pricing-file <path>",
        "JSON map from model id to per-token input and output USD, for catalogs without pricing",
      )
      .addOption(
        new Option(
          "--evaluator <provider>",
          "external evaluator provider",
        ).choices(["braintrust", "langfuse", "langsmith", "promptfoo"]),
      )
      .option("--evaluator-base-url <url>", "external evaluator API base URL")
      .option(
        "--evaluator-api-key-env <name>",
        "environment variable containing the evaluator API key",
      )
      .option(
        "--evaluator-public-key-env <name>",
        "environment variable containing the Langfuse public key",
      )
      .option(
        "--evaluator-project-id <id>",
        "Braintrust project or LangSmith dataset identifier",
      )
      .option(
        "--evaluator-command <path>",
        "promptfoo executable path or command",
      )
      .option(
        "--evaluator-config <path>",
        "promptfoo assertions configuration file",
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
      );
  }
  if (command.name() === "init" || command.name() === "estimate") {
    command.option(
      "--yes",
      "accept the newest discovered trace without prompting",
    );
  }
  return command;
}

function invalidOption(message: string): ProtocolError {
  return new ProtocolError({
    exitCode: 2,
    code: "invalid_option",
    message,
    remedy:
      "Correct the option and rerun; run rightmodeler <command> --help for accepted values.",
  });
}

function pipelineOptions(
  global: GlobalOptions,
  local: PipelineCommandOptions,
  reporter: Reporter,
): PipelineOptions {
  if (
    local.approvedRun !== undefined &&
    !/^[0-9a-f]{64}$/u.test(local.approvedRun)
  ) {
    throw invalidOption("--approved-run must be a SHA-256 run-spec digest");
  }
  const maxCostUsd =
    local.maxCostUsd === undefined ? undefined : Number(local.maxCostUsd);
  if (
    maxCostUsd !== undefined &&
    (!Number.isFinite(maxCostUsd) || maxCostUsd < 0)
  ) {
    throw invalidOption("--max-cost-usd must be a non-negative number");
  }
  const maxConcurrency =
    local.maxConcurrency === undefined
      ? undefined
      : Number(local.maxConcurrency);
  if (
    maxConcurrency !== undefined &&
    (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1)
  ) {
    throw invalidOption("--max-concurrency must be a positive integer");
  }
  const evaluatorGateThreshold =
    local.evaluatorGateThreshold === undefined
      ? undefined
      : Number(local.evaluatorGateThreshold);
  if (
    evaluatorGateThreshold !== undefined &&
    !Number.isFinite(evaluatorGateThreshold)
  ) {
    throw invalidOption("--evaluator-gate-threshold must be a finite number");
  }
  const hasEvaluatorCompanion =
    local.evaluatorBaseUrl !== undefined ||
    local.evaluatorApiKeyEnv !== undefined ||
    local.evaluatorPublicKeyEnv !== undefined ||
    local.evaluatorProjectId !== undefined ||
    local.evaluatorCommand !== undefined ||
    local.evaluatorConfig !== undefined ||
    local.evaluatorScorer !== undefined ||
    local.evaluatorGateMetric !== undefined ||
    evaluatorGateThreshold !== undefined;
  if (local.evaluator === undefined && hasEvaluatorCompanion) {
    throw invalidOption("Evaluator options require --evaluator <provider>");
  }
  if (local.evaluator !== undefined && local.evaluatorScorer === undefined) {
    throw invalidOption(
      `At least one --evaluator-scorer is required with --evaluator ${local.evaluator}`,
    );
  }
  return {
    repo: global.repo,
    store: global.store,
    traces: local.traces,
    matchersPath: local.matchers,
    baseUrl: local.baseUrl,
    apiKeyEnv: local.apiKeyEnv,
    maxCostUsd,
    maxConcurrency,
    pricingFilePath: local.pricingFile,
    includeFreeModels: local.includeFree,
    ...(local.evaluator === undefined
      ? {}
      : {
          evaluator: evaluatorConfig(local, evaluatorGateThreshold),
        }),
    modeBConfigPath: local.modebConfig,
    approvedRunSpecDigest: local.approvedRun,
    through: local.through,
    plan: local.plan,
    reporter,
  };
}

async function guidedPipelineOptions(
  global: GlobalOptions,
  local: PipelineCommandOptions,
  reporter: Reporter,
  runtime: CliRuntime,
): Promise<{
  readonly options: PipelineOptions;
  readonly candidates: readonly DiscoveredTrace[];
  readonly interactive: boolean;
  readonly selectedDiscoveredTrace?: string;
}> {
  const options = pipelineOptions(global, local, reporter);
  const interactive =
    global.output === "human" &&
    runtime.stdin.isTTY === true &&
    runtime.stdout.isTTY === true;
  if (local.traces !== undefined || local.plan || local.through === "scan") {
    return { options, candidates: [], interactive };
  }
  const resumption = await readIngestResumption(options);
  if (resumption.resumable) {
    if (global.output === "human" && resumption.tracePath !== undefined) {
      reporter.io.stdout(
        `Resuming the ingested trace: ${resumption.tracePath}\n`,
      );
    }
    return { options, candidates: [], interactive };
  }
  const candidates = await discoverTraces({
    repo: global.repo,
    homeDir: runtime.homeDir,
  });
  const traces = local.yes
    ? candidates[0]?.path
    : interactive
      ? await promptForTracePath({
          candidates,
          repo: resolve(global.repo),
          homeDir: runtime.homeDir,
          now: runtime.now(),
          input: runtime.stdin,
          output: promptOutput(reporter.io, runtime.stdout.isTTY),
        })
      : undefined;
  if (local.yes && traces !== undefined && global.output === "human") {
    reporter.io.stdout(`Using trace file: ${traces}\n`);
  }
  return {
    options: traces === undefined ? options : { ...options, traces },
    candidates,
    interactive,
    ...(traces === undefined ? {} : { selectedDiscoveredTrace: traces }),
  };
}

async function withInputGuidance<T>(
  prepared: {
    readonly options: PipelineOptions;
    readonly candidates: readonly DiscoveredTrace[];
    readonly interactive: boolean;
    readonly selectedDiscoveredTrace?: string;
  },
  local: PipelineCommandOptions,
  runtime: CliRuntime,
  operation: (options: PipelineOptions) => Promise<T>,
): Promise<T> {
  try {
    return await operation(prepared.options);
  } catch (error) {
    if (
      error instanceof ProtocolError &&
      error.code === "missing_traces_path" &&
      prepared.candidates.length > 0
    ) {
      throw new ProtocolError({
        exitCode: error.exitCode,
        code: error.code,
        message: error.message,
        remedy: `${error.remedy} ${candidateRemedy(prepared.candidates)}`,
      });
    }
    if (
      prepared.selectedDiscoveredTrace !== undefined &&
      error instanceof TraceAdaptError
    ) {
      throw new ProtocolError({
        exitCode: 2,
        code: "unusable_trace_input",
        message: error.message,
        remedy: "Rerun the command and choose a different trace file.",
      });
    }
    if (
      !(error instanceof ProtocolError) ||
      error.code !== "missing_provider_configuration" ||
      !prepared.interactive
    ) {
      throw error;
    }
    const baseUrl = await promptForProviderBaseUrl({
      current: local.baseUrl,
      input: runtime.stdin,
      output: promptOutput(prepared.options.reporter.io, runtime.stdout.isTTY),
    });
    if (baseUrl === undefined) throw error;
    const apiKeyEnv = local.apiKeyEnv ?? "RIGHTMODELER_API_KEY";
    if (!runtime.env[apiKeyEnv]) {
      throw new ProtocolError({
        exitCode: 2,
        code: "missing_provider_configuration",
        message: `Provider API key environment variable is not set: ${apiKeyEnv}.`,
        remedy: `Set the environment variable ${apiKeyEnv} to your provider API key, then rerun.`,
      });
    }
    return operation({
      ...prepared.options,
      baseUrl,
      apiKeyEnv,
    });
  }
}

function promptOutput(
  io: CliIo,
  isTTY: boolean | undefined,
): Writable & { readonly isTTY?: boolean } {
  return Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        io.stdout(String(chunk));
        callback();
      },
    }),
    { isTTY },
  );
}

function candidateRemedy(candidates: readonly DiscoveredTrace[]): string {
  const shown = candidates.slice(0, 3).map(({ path }) => path);
  const more = candidates.length - shown.length;
  const paths =
    more === 0 ? shown.join(", ") : `${shown.join(", ")}, and ${more} more`;
  return `Found ${candidates.length} candidate ${candidates.length === 1 ? "trace file" : "trace files"}: ${paths}. Pass --traces <path>.`;
}

function evaluatorConfig(
  local: PipelineCommandOptions,
  gateThreshold: number | undefined,
): NonNullable<PipelineOptions["evaluator"]> {
  const provider = local.evaluator!;
  const scoring = {
    scorers: local.evaluatorScorer!,
    ...(local.evaluatorGateMetric === undefined
      ? {}
      : { gateMetric: local.evaluatorGateMetric }),
    ...(gateThreshold === undefined ? {} : { gateThreshold }),
  };
  if (provider !== "langfuse" && local.evaluatorPublicKeyEnv !== undefined) {
    throw invalidOption(
      "--evaluator-public-key-env requires --evaluator langfuse",
    );
  }
  if (
    provider !== "promptfoo" &&
    (local.evaluatorCommand !== undefined ||
      local.evaluatorConfig !== undefined)
  ) {
    throw invalidOption(
      "--evaluator-command and --evaluator-config require --evaluator promptfoo",
    );
  }
  if (provider === "braintrust") {
    if (local.evaluatorProjectId === undefined) {
      throw invalidOption(
        "--evaluator-project-id is required with --evaluator braintrust",
      );
    }
    return {
      provider,
      apiKeyEnv: local.evaluatorApiKeyEnv ?? "BRAINTRUST_API_KEY",
      baseUrl: local.evaluatorBaseUrl ?? "https://api.braintrust.dev",
      projectId: local.evaluatorProjectId,
      ...scoring,
    };
  }
  if (provider === "langsmith") {
    if (local.evaluatorProjectId === undefined) {
      throw invalidOption(
        "--evaluator-project-id must name the dataset used with --evaluator langsmith",
      );
    }
    return {
      provider,
      apiKeyEnv: local.evaluatorApiKeyEnv ?? "LANGSMITH_API_KEY",
      baseUrl: local.evaluatorBaseUrl ?? "https://api.smith.langchain.com",
      datasetId: local.evaluatorProjectId,
      ...scoring,
    };
  }
  if (provider === "langfuse") {
    if (local.evaluatorProjectId !== undefined) {
      throw invalidOption(
        "--evaluator-project-id is not used with --evaluator langfuse",
      );
    }
    return {
      provider,
      apiKeyEnv: local.evaluatorApiKeyEnv ?? "LANGFUSE_SECRET_KEY",
      publicKeyEnv: local.evaluatorPublicKeyEnv ?? "LANGFUSE_PUBLIC_KEY",
      baseUrl: local.evaluatorBaseUrl ?? "https://cloud.langfuse.com",
      ...scoring,
    };
  }
  if (
    local.evaluatorBaseUrl !== undefined ||
    local.evaluatorApiKeyEnv !== undefined ||
    local.evaluatorProjectId !== undefined ||
    local.evaluatorPublicKeyEnv !== undefined
  ) {
    throw invalidOption(
      "API and project options are not used with --evaluator promptfoo",
    );
  }
  if (local.evaluatorConfig === undefined) {
    throw invalidOption(
      "--evaluator-config is required with --evaluator promptfoo",
    );
  }
  return {
    provider,
    command: local.evaluatorCommand ?? "promptfoo",
    assertionsPath: local.evaluatorConfig,
    ...scoring,
  };
}

function parseCorpusSource(value: string): {
  readonly provider: "braintrust" | "langsmith" | "langfuse";
  readonly dataset: string;
} {
  const separator = value.indexOf(":");
  const provider = value.slice(0, separator);
  const dataset = value.slice(separator + 1);
  if (
    separator < 1 ||
    dataset.length === 0 ||
    !["braintrust", "langsmith", "langfuse"].includes(provider)
  ) {
    throw invalidOption(
      "--from must be braintrust:<dataset>, langsmith:<dataset>, or langfuse:<dataset>",
    );
  }
  return {
    provider: provider as "braintrust" | "langsmith" | "langfuse",
    dataset,
  };
}

function corpusImportConfig(
  source: ReturnType<typeof parseCorpusSource>,
  local: CorpusImportOptions,
) {
  if (source.provider !== "langfuse" && local.publicKeyEnv !== undefined) {
    throw invalidOption(
      "--public-key-env is only used with --from langfuse:<dataset>",
    );
  }
  if (source.provider === "braintrust") {
    return {
      ...source,
      baseUrl: local.baseUrl ?? "https://api.braintrust.dev",
      apiKeyEnv: local.apiKeyEnv ?? "BRAINTRUST_API_KEY",
    } as const;
  }
  if (source.provider === "langsmith") {
    return {
      ...source,
      baseUrl: local.baseUrl ?? "https://api.smith.langchain.com",
      apiKeyEnv: local.apiKeyEnv ?? "LANGSMITH_API_KEY",
    } as const;
  }
  return {
    ...source,
    baseUrl: local.baseUrl ?? "https://cloud.langfuse.com",
    apiKeyEnv: local.apiKeyEnv ?? "LANGFUSE_SECRET_KEY",
    publicKeyEnv: local.publicKeyEnv ?? "LANGFUSE_PUBLIC_KEY",
  } as const;
}

function resultSinkConfig(local: ExportCommandOptions) {
  if (local.to === "braintrust") {
    if (local.projectId === undefined) {
      throw invalidOption("--project-id is required with --to braintrust");
    }
    if (local.datasetId !== undefined || local.publicKeyEnv !== undefined) {
      throw invalidOption(
        "--dataset-id and --public-key-env are only used with --to langfuse",
      );
    }
    return {
      provider: local.to,
      baseUrl: local.baseUrl ?? "https://api.braintrust.dev",
      apiKeyEnv: local.apiKeyEnv ?? "BRAINTRUST_API_KEY",
      projectId: local.projectId,
    } as const;
  }
  if (local.datasetId === undefined) {
    throw invalidOption("--dataset-id is required with --to langfuse");
  }
  if (local.projectId !== undefined) {
    throw invalidOption("--project-id is only used with --to braintrust");
  }
  return {
    provider: local.to,
    baseUrl: local.baseUrl ?? "https://cloud.langfuse.com",
    apiKeyEnv: local.apiKeyEnv ?? "LANGFUSE_SECRET_KEY",
    publicKeyEnv: local.publicKeyEnv ?? "LANGFUSE_PUBLIC_KEY",
    datasetId: local.datasetId,
  } as const;
}

function collectOption(value: string, previous?: string[]): string[] {
  return [...(previous ?? []), value];
}

const PIPELINE_ARG_OPTIONS = [
  { flag: "--traces", key: "traces", kind: "path" },
  { flag: "--matchers", key: "matchers", kind: "path" },
  { flag: "--modeb-config", key: "modebConfig", kind: "path" },
  { flag: "--base-url", key: "baseUrl", kind: "value" },
  { flag: "--api-key-env", key: "apiKeyEnv", kind: "value" },
  { flag: "--max-cost-usd", key: "maxCostUsd", kind: "value" },
  { flag: "--max-concurrency", key: "maxConcurrency", kind: "value" },
  { flag: "--pricing-file", key: "pricingFile", kind: "path" },
  { flag: "--include-free", key: "includeFree", kind: "flag" },
  { flag: "--approved-run", key: "approvedRun", kind: "value" },
  { flag: "--evaluator", key: "evaluator", kind: "value" },
  {
    flag: "--evaluator-base-url",
    key: "evaluatorBaseUrl",
    kind: "value",
  },
  {
    flag: "--evaluator-api-key-env",
    key: "evaluatorApiKeyEnv",
    kind: "value",
  },
  {
    flag: "--evaluator-public-key-env",
    key: "evaluatorPublicKeyEnv",
    kind: "value",
  },
  {
    flag: "--evaluator-project-id",
    key: "evaluatorProjectId",
    kind: "value",
  },
  {
    flag: "--evaluator-command",
    key: "evaluatorCommand",
    kind: "command",
  },
  {
    flag: "--evaluator-config",
    key: "evaluatorConfig",
    kind: "path",
  },
  {
    flag: "--evaluator-scorer",
    key: "evaluatorScorer",
    kind: "repeated",
  },
  {
    flag: "--evaluator-gate-metric",
    key: "evaluatorGateMetric",
    kind: "value",
  },
  {
    flag: "--evaluator-gate-threshold",
    key: "evaluatorGateThreshold",
    kind: "value",
  },
] as const satisfies readonly {
  flag: string;
  key: keyof PipelineCommandOptions;
  kind: "value" | "path" | "command" | "flag" | "repeated";
}[];

export function pipelineArgv(options: PipelineCommandOptions): string[] {
  const args: string[] = [];
  for (const { flag, key, kind } of PIPELINE_ARG_OPTIONS) {
    const value = options[key];
    if (kind === "flag") {
      if (value === true) args.push(flag);
      continue;
    }
    if (kind === "repeated") {
      for (const item of (value as string[] | undefined) ?? []) {
        appendCliOption(args, flag, item);
      }
      continue;
    }
    if (typeof value !== "string") continue;
    appendCliOption(
      args,
      flag,
      kind === "path"
        ? resolve(value)
        : kind === "command"
          ? detachedCommand(value)
          : value,
    );
  }
  return args;
}

async function startDetachedReplay(
  global: GlobalOptions,
  local: PipelineCommandOptions,
  runId: string,
): Promise<void> {
  const args = [
    fileURLToPath(import.meta.url),
    "--repo",
    resolve(global.repo),
    "--output",
    "json",
  ];
  if (global.store !== undefined) {
    args.push("--store", resolve(global.store));
  }
  args.push("replay", ...pipelineArgv(local));
  appendCliOption(args, "--internal-run-id", runId);

  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    const child = spawn(process.execPath, args, {
      cwd: resolve(global.repo),
      detached: true,
      env: process.env,
      stdio: "ignore",
    });
    child.once("error", rejectSpawn);
    child.once("spawn", () => {
      child.unref();
      resolveSpawn();
    });
  });
}

function detachedCommand(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.startsWith("./") ||
    value.startsWith("../") ||
    value.includes("/") ||
    value.includes("\\")
    ? resolve(value)
    : value;
}

function appendCliOption(
  args: string[],
  flag: string,
  value: string | undefined,
): void {
  if (value !== undefined) args.push(flag, value);
}

export async function executeCli(
  argv: readonly string[],
  io: CliIo = processIo,
  runtime: CliRuntime = processRuntime,
): Promise<number> {
  const handle = createProgram(io, runtime);
  try {
    await handle.program.parseAsync([...argv], { from: "user" });
    return handle.exitCode();
  } catch (error) {
    const outputIndex = argv.indexOf("--output");
    const mode = argv[outputIndex + 1];
    const reporter = new Reporter(
      mode === "json" || mode === "jsonl" ? mode : "human",
      io,
    );
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return 0;
      const usage = handle.usageOutput();
      if (reporter.mode === "human") {
        io.stderr(usage);
      } else {
        io.stderr(
          `${JSON.stringify({ code: "usage_error", message: usage.trim(), remedy: "Run rightmodeler --help (or <command> --help) for valid commands and options." })}\n`,
        );
      }
      return error.exitCode >= 10 ? error.exitCode : 10;
    }
    return reporter.error(error);
  }
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);

if (isEntryPoint) {
  process.exitCode = await executeCli(process.argv.slice(2));
}

export {
  approveDriftProposal,
  applySwaps,
  listApprovedSwapSets,
  listWatchablePullRequests,
  publishDriftProposal,
  readActiveDetachedReplay,
  rollbackSwaps,
  runDrift,
};
export type {
  ApproveDriftProposalOptions,
  ApplySwapsOptions,
  ApplySwapsResult,
  PipelineCommandOptions,
  PublishDriftProposalOptions,
  RollbackResult,
  RollbackSwapsOptions,
  RunDriftOptions,
};
