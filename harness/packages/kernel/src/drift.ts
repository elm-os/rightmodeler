import {
  canonicalJson,
  computeRunSpecDigest,
  type JsonValue,
} from "@rightmodeler/core";

export const DRIFT_SIGNALS = [
  "input",
  "tool",
  "evaluator",
  "acceptance",
  "model",
  "cost",
  "latency",
  "retry",
  "trajectory",
  "none",
] as const;

export type DriftSignal = (typeof DRIFT_SIGNALS)[number];
export type DriftChangeAction =
  "add" | "relabel" | "retire" | "red-team" | "no-change";
export type PipelineFamily =
  "reference-freeform" | "structured-check" | "tool-trajectory" | "repo-fix";

export interface HistoricalRun {
  readonly id: string;
  readonly prompt: string;
  readonly model: string;
  readonly tool_calls?: JsonValue;
  readonly evaluator?: JsonValue;
  readonly evaluator_version?: JsonValue;
  readonly success?: boolean | null;
  readonly cost_usd?: number | null;
  readonly duration_ms?: number | null;
  readonly latency_ms?: number | null;
  readonly retry_count?: number | null;
  readonly trajectory?: JsonValue;
  readonly not_evaluated?: readonly DriftNotEvaluated[];
}

export interface DriftNotEvaluated {
  readonly signal: DriftSignal;
  readonly dimension: string;
  readonly reason: string;
}

export interface HistoricalRunBundle {
  readonly version: string;
  readonly bundle_id: string;
  readonly runs: readonly HistoricalRun[];
}

export interface CorpusCaseLabels {
  readonly recommendation: "safe" | "unsafe" | "not_applicable";
  readonly required_abstention: boolean;
}

export interface CorpusCaseDefinition {
  readonly case_id: string;
  readonly source_run_id: string;
  readonly pipeline_family: PipelineFamily;
  readonly workload_label: string;
  readonly split: "working" | "holdout";
  readonly risk: "normal" | "high";
  readonly required_evidence:
    "deterministic" | "reference" | "trajectory" | "abstain";
  readonly checks: Readonly<Record<string, JsonValue>>;
  readonly labels?: CorpusCaseLabels;
}

export interface CorpusDefinition {
  readonly version: string;
  readonly corpus_id: string;
  readonly parent_version: string | null;
  readonly cases: readonly CorpusCaseDefinition[];
}

export interface CorpusManifest {
  readonly version: string;
  readonly corpus_id: string;
  readonly corpus_version: string;
  readonly parent_version: string | null;
  readonly source_bundle_id: string;
  readonly content_digest: string;
  readonly cases: readonly CorpusCaseDefinition[];
}

export interface BenchmarkCases {
  readonly version: string;
  readonly corpus_version_id: string;
  readonly source_bundle_id: string;
  readonly cases: readonly CorpusCaseDefinition[];
}

export interface DriftChange {
  readonly action: DriftChangeAction;
  readonly case_id: string;
  readonly signal: DriftSignal;
  readonly detail: string;
}

export interface DriftApproval {
  readonly actor: string;
  readonly timestamp: string;
  readonly reason: string | null;
}

interface CorpusDriftProposalBase {
  readonly version: string;
  readonly proposal_id: string;
  readonly parent_corpus_version_id: string;
  readonly candidate_definition_digest: string;
  readonly proposed_changes: readonly DriftChange[];
  readonly signals: readonly DriftSignal[];
  readonly exposed_holdout_case_ids: readonly string[];
  readonly replacement_holdout_case_ids: readonly string[];
}

export type ProposedCorpusDriftProposal = CorpusDriftProposalBase & {
  readonly status: "proposed";
  readonly approval: null;
};

export type ApprovedCorpusDriftProposal = CorpusDriftProposalBase & {
  readonly status: "approved";
  readonly approval: DriftApproval;
};

export type PublishedCorpusDriftProposal = CorpusDriftProposalBase & {
  readonly status: "published";
  readonly approval: DriftApproval;
};

export type RejectedCorpusDriftProposal = CorpusDriftProposalBase & {
  readonly status: "rejected";
  readonly approval: DriftApproval | null;
};

export type CorpusDriftProposal =
  | ProposedCorpusDriftProposal
  | ApprovedCorpusDriftProposal
  | PublishedCorpusDriftProposal
  | RejectedCorpusDriftProposal;

export interface PublishDriftResult {
  readonly proposal: PublishedCorpusDriftProposal;
  readonly manifest: CorpusManifest;
  readonly benchmark_cases: BenchmarkCases;
}

const pipelineFamilies = new Set<PipelineFamily>([
  "reference-freeform",
  "structured-check",
  "tool-trajectory",
  "repo-fix",
]);

export function detectDrift(
  parentManifest: CorpusManifest,
  parentBundle: HistoricalRunBundle,
  candidateBundle: HistoricalRunBundle,
  candidateDefinition: CorpusDefinition,
): ProposedCorpusDriftProposal {
  const parentCases = caseMapBySourceRunId(parentManifest.cases);
  const candidateCases = caseMapBySourceRunId(candidateDefinition.cases);
  const parentRuns = runMap(parentBundle);
  const candidateRuns = runMap(candidateBundle);
  let changes: DriftChange[] = [];
  const signals: DriftSignal[] = [];

  for (const sourceRunId of difference(candidateCases, parentCases)) {
    const caseId = candidateCases.get(sourceRunId)!.case_id;
    changes.push(
      change("add", caseId, "none", "case is new in the candidate corpus"),
    );
  }
  for (const sourceRunId of difference(parentCases, candidateCases)) {
    const caseId = parentCases.get(sourceRunId)!.case_id;
    changes.push(
      change(
        "retire",
        caseId,
        "none",
        "case is absent from the candidate corpus",
      ),
    );
  }

  const notEvaluated = new Map<string, DriftChange>();
  for (const sourceRunId of intersection(parentCases, candidateCases)) {
    const parentCase = parentCases.get(sourceRunId)!;
    const candidateCase = candidateCases.get(sourceRunId)!;
    const caseId = candidateCase.case_id;
    if (caseDefinitionChanged(parentCase, candidateCase)) {
      changes.push(
        change(
          candidateCase.risk === "high" ? "red-team" : "relabel",
          caseId,
          "evaluator",
          "reviewed case definition changed",
        ),
      );
      signals.push("evaluator");
    }

    const parentRun = parentRuns.get(parentCase.source_run_id);
    const candidateRun = candidateRuns.get(candidateCase.source_run_id);
    if (parentRun !== undefined && candidateRun !== undefined) {
      for (const signal of runSignals(parentRun, candidateRun)) {
        changes.push(
          change(
            candidateCase.risk === "high" ? "red-team" : "relabel",
            caseId,
            signal,
            `source run shows ${signal} drift`,
          ),
        );
        signals.push(signal);
      }
      for (const item of [
        ...(parentRun.not_evaluated ?? []),
        ...(candidateRun.not_evaluated ?? []),
      ]) {
        const detail = `${item.dimension} drift not evaluated: ${item.reason}`;
        notEvaluated.set(
          `${item.signal}\0${item.dimension}\0${item.reason}`,
          change("no-change", caseId, item.signal, detail),
        );
      }
    }
  }

  const exposed = [...parentCases.entries()]
    .flatMap(([sourceRunId, parentCase]) =>
      parentCase.split === "holdout" &&
      candidateCases.get(sourceRunId)?.split === "working"
        ? [candidateCases.get(sourceRunId)!.case_id]
        : [],
    )
    .sort(compareText);
  const replacements = [...candidateCases.entries()]
    .flatMap(([sourceRunId, candidateCase]) =>
      candidateCase.split === "holdout" && !parentCases.has(sourceRunId)
        ? [candidateCase.case_id]
        : [],
    )
    .sort(compareText);
  if (exposed.length > 0) {
    signals.push("acceptance");
    changes.push(
      change(
        "red-team",
        exposed[0]!,
        "acceptance",
        "holdout case was exposed and needs replacement coverage",
      ),
    );
  }
  changes.push(
    ...[...notEvaluated.values()].sort(
      (left, right) =>
        compareText(left.detail, right.detail) ||
        compareText(left.case_id, right.case_id),
    ),
  );
  if (changes.length === 0) {
    changes = [
      change("no-change", "corpus", "none", "no material drift detected"),
    ];
  }

  const body = {
    version: "1",
    parent_corpus_version_id: parentManifest.content_digest,
    candidate_definition_digest: contentDigest(
      corpusDefinitionValue(candidateDefinition),
    ),
    status: "proposed" as const,
    proposed_changes: changes,
    signals:
      signals.length === 0
        ? (["none"] as const)
        : [...new Set(signals)].sort(compareText),
    exposed_holdout_case_ids: exposed,
    replacement_holdout_case_ids: replacements,
    approval: null,
  };
  return {
    ...body,
    proposal_id: contentDigest(proposalBodyValue(body)),
  };
}

export function approveDrift(
  proposal: CorpusDriftProposal,
  actor: string,
  reason: string | null = null,
  timestamp = new Date().toISOString(),
): ApprovedCorpusDriftProposal {
  if (proposal.status !== "proposed") {
    throw new Error("only proposed drift may be approved");
  }
  assertDriftProposalIntegrity(proposal);
  return {
    ...proposal,
    status: "approved",
    approval: { actor, timestamp, reason },
  };
}

export function publishDrift(
  parentManifest: CorpusManifest,
  candidateBundle: HistoricalRunBundle,
  candidateDefinition: CorpusDefinition,
  proposal: CorpusDriftProposal,
): PublishDriftResult {
  if (proposal.status !== "approved" || proposal.approval === null) {
    throw new Error("corpus publication requires an approved drift proposal");
  }
  assertDriftProposalIntegrity(proposal);
  if (proposal.parent_corpus_version_id !== parentManifest.content_digest) {
    throw new Error("drift proposal parent does not match the current corpus");
  }
  let candidateDefinitionDigest: string;
  try {
    candidateDefinitionDigest = contentDigest(
      corpusDefinitionValue(candidateDefinition),
    );
  } catch {
    throw new Error("candidate definition does not match drift proposal");
  }
  if (proposal.candidate_definition_digest !== candidateDefinitionDigest) {
    throw new Error("candidate definition does not match drift proposal");
  }
  if (candidateDefinition.parent_version !== parentManifest.content_digest) {
    throw new Error(
      "candidate definition must name the current corpus as its parent",
    );
  }

  const candidateCaseIds = new Set(
    candidateDefinition.cases.map(({ case_id }) => case_id),
  );
  if (
    proposal.exposed_holdout_case_ids.some(
      (caseId) => !candidateCaseIds.has(caseId),
    )
  ) {
    throw new Error("drift proposal references missing exposed holdout cases");
  }
  const exposed = new Set(proposal.exposed_holdout_case_ids);
  const replacements = new Set(proposal.replacement_holdout_case_ids);
  if (replacements.size < exposed.size) {
    throw new Error(
      "every exposed holdout requires a replacement holdout case",
    );
  }

  const { manifest, benchmarkCases } = compileCorpus(
    candidateBundle,
    candidateDefinition,
  );
  return {
    proposal: {
      ...proposal,
      status: "published",
      approval: proposal.approval,
    },
    manifest,
    benchmark_cases: benchmarkCases,
  };
}

function runMap(bundle: HistoricalRunBundle): Map<string, HistoricalRun> {
  return new Map(bundle.runs.map((run) => [run.id, run]));
}

function caseMapBySourceRunId(
  cases: readonly CorpusCaseDefinition[],
): Map<string, CorpusCaseDefinition> {
  return new Map(
    cases.map((corpusCase) => [corpusCase.source_run_id, corpusCase]),
  );
}

function difference(
  left: ReadonlyMap<string, unknown>,
  right: ReadonlyMap<string, unknown>,
): string[] {
  return [...left.keys()].filter((key) => !right.has(key)).sort(compareText);
}

function intersection(
  left: ReadonlyMap<string, unknown>,
  right: ReadonlyMap<string, unknown>,
): string[] {
  return [...left.keys()].filter((key) => right.has(key)).sort(compareText);
}

function different(left: JsonValue | undefined, right: JsonValue | undefined) {
  return (
    left !== undefined &&
    left !== null &&
    right !== undefined &&
    right !== null &&
    canonicalJson(left) !== canonicalJson(right)
  );
}

function runSignals(
  parentRun: HistoricalRun,
  candidateRun: HistoricalRun,
): DriftSignal[] {
  const signals: DriftSignal[] = [];
  if (different(parentRun.prompt, candidateRun.prompt)) signals.push("input");
  if (different(parentRun.tool_calls, candidateRun.tool_calls)) {
    signals.push("tool");
  }
  if (
    different(parentRun.evaluator, candidateRun.evaluator) ||
    different(parentRun.evaluator_version, candidateRun.evaluator_version)
  ) {
    signals.push("evaluator");
  }
  if (different(parentRun.success, candidateRun.success)) {
    signals.push("acceptance");
  }
  if (different(parentRun.model, candidateRun.model)) signals.push("model");
  if (relativeChange(parentRun.cost_usd, candidateRun.cost_usd) > 0.2) {
    signals.push("cost");
  }
  if (relativeChange(runLatency(parentRun), runLatency(candidateRun)) > 0.2) {
    signals.push("latency");
  }
  if (different(parentRun.retry_count, candidateRun.retry_count)) {
    signals.push("retry");
  }
  if (different(parentRun.trajectory, candidateRun.trajectory)) {
    signals.push("trajectory");
  }
  return signals;
}

function relativeChange(
  left: number | null | undefined,
  right: number | null | undefined,
): number {
  if (typeof left !== "number" || typeof right !== "number" || left === 0) {
    return 0;
  }
  return Math.abs(right - left) / Math.abs(left);
}

function runLatency(run: HistoricalRun): number | null | undefined {
  return run.duration_ms === undefined ? run.latency_ms : run.duration_ms;
}

function caseDefinitionChanged(
  parentCase: CorpusCaseDefinition,
  candidateCase: CorpusCaseDefinition,
): boolean {
  return (
    !sameValue(parentCase.pipeline_family, candidateCase.pipeline_family) ||
    !sameValue(parentCase.workload_label, candidateCase.workload_label) ||
    !sameValue(parentCase.risk, candidateCase.risk) ||
    !sameValue(parentCase.required_evidence, candidateCase.required_evidence) ||
    !sameValue(parentCase.checks, candidateCase.checks) ||
    !sameValue(
      corpusLabelsValue(parentCase.labels),
      corpusLabelsValue(candidateCase.labels),
    )
  );
}

function sameValue(
  left: JsonValue | undefined,
  right: JsonValue | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalJson(left) === canonicalJson(right);
}

function change(
  action: DriftChangeAction,
  case_id: string,
  signal: DriftSignal,
  detail: string,
): DriftChange {
  return { action, case_id, signal, detail };
}

export function assertDriftProposalIntegrity(
  proposal: CorpusDriftProposal,
): void {
  let digest: string;
  try {
    digest = contentDigest(proposalBodyValue(proposal));
  } catch {
    throw new Error("drift proposal digest does not match its contents");
  }
  if (digest !== proposal.proposal_id) {
    throw new Error("drift proposal digest does not match its contents");
  }
}

export function assertCorpusManifestIntegrity(manifest: CorpusManifest): void {
  let digest: string;
  try {
    digest = contentDigest(manifestBodyValue(manifest));
  } catch {
    throw new Error("corpus manifest digest does not match its contents");
  }
  if (digest !== manifest.content_digest) {
    throw new Error("corpus manifest digest does not match its contents");
  }
}

function contentDigest(value: JsonValue): string {
  return `sha256:${computeRunSpecDigest(value)}`;
}

function proposalBodyValue(
  proposal: Omit<CorpusDriftProposal, "proposal_id"> | CorpusDriftProposal,
): JsonValue {
  return {
    version: proposal.version,
    parent_corpus_version_id: proposal.parent_corpus_version_id,
    candidate_definition_digest: proposal.candidate_definition_digest,
    status: "proposed",
    proposed_changes: proposal.proposed_changes.map((item) => ({ ...item })),
    signals: [...proposal.signals],
    exposed_holdout_case_ids: [...proposal.exposed_holdout_case_ids],
    replacement_holdout_case_ids: [...proposal.replacement_holdout_case_ids],
    approval: null,
  };
}

function corpusCaseValue(corpusCase: CorpusCaseDefinition): JsonValue {
  return {
    case_id: corpusCase.case_id,
    source_run_id: corpusCase.source_run_id,
    pipeline_family: corpusCase.pipeline_family,
    workload_label: corpusCase.workload_label,
    split: corpusCase.split,
    risk: corpusCase.risk,
    required_evidence: corpusCase.required_evidence,
    checks: { ...corpusCase.checks },
    ...(corpusCase.labels === undefined
      ? {}
      : { labels: { ...corpusCase.labels } }),
  };
}

function corpusLabelsValue(
  labels: CorpusCaseLabels | undefined,
): JsonValue | undefined {
  return labels === undefined ? undefined : { ...labels };
}

function corpusDefinitionValue(definition: CorpusDefinition): JsonValue {
  return {
    version: definition.version,
    corpus_id: definition.corpus_id,
    parent_version: definition.parent_version,
    cases: definition.cases.map(corpusCaseValue),
  };
}

function manifestBodyValue(
  manifest: Omit<CorpusManifest, "content_digest"> | CorpusManifest,
): JsonValue {
  return {
    version: manifest.version,
    corpus_id: manifest.corpus_id,
    corpus_version: manifest.corpus_version,
    parent_version: manifest.parent_version,
    source_bundle_id: manifest.source_bundle_id,
    cases: manifest.cases.map(corpusCaseValue),
  };
}

function compileCorpus(
  bundle: HistoricalRunBundle,
  definition: CorpusDefinition,
): { manifest: CorpusManifest; benchmarkCases: BenchmarkCases } {
  const runs = runMap(bundle);
  const cases: CorpusCaseDefinition[] = [];
  const seenCaseIds = new Set<string>();

  for (const corpusCase of definition.cases) {
    if (seenCaseIds.has(corpusCase.case_id)) {
      throw new Error(`duplicate corpus case: ${corpusCase.case_id}`);
    }
    seenCaseIds.add(corpusCase.case_id);
    const sourceRun = runs.get(corpusCase.source_run_id);
    if (sourceRun === undefined) {
      throw new Error(`source run not found: ${corpusCase.source_run_id}`);
    }
    if (sourceRun.success !== true) {
      throw new Error(
        `source run is not accepted: ${corpusCase.source_run_id}`,
      );
    }
    if (!pipelineFamilies.has(corpusCase.pipeline_family)) {
      throw new Error(
        `unsupported pipeline family: ${corpusCase.pipeline_family}`,
      );
    }
    cases.push(cloneCorpusCase(corpusCase));
  }
  cases.sort((left, right) => compareText(left.case_id, right.case_id));

  const manifestWithoutDigest = {
    version: definition.version,
    corpus_id: definition.corpus_id,
    corpus_version: definition.version,
    parent_version: definition.parent_version,
    source_bundle_id: bundle.bundle_id,
    cases,
  };
  const digest = contentDigest(manifestBodyValue(manifestWithoutDigest));
  const manifest: CorpusManifest = {
    ...manifestWithoutDigest,
    content_digest: digest,
  };
  return {
    manifest,
    benchmarkCases: {
      version: definition.version,
      corpus_version_id: digest,
      source_bundle_id: bundle.bundle_id,
      cases,
    },
  };
}

function cloneCorpusCase(
  corpusCase: CorpusCaseDefinition,
): CorpusCaseDefinition {
  return {
    ...corpusCase,
    checks: { ...corpusCase.checks },
    ...(corpusCase.labels === undefined
      ? {}
      : { labels: { ...corpusCase.labels } }),
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
