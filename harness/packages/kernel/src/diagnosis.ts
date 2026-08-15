import { computeRunSpecDigest, type JsonValue } from "@rightmodeler/core";

export const ISSUE_CLASSES = [
  "ingestion",
  "evaluator",
  "replay",
  "candidate-selection",
  "repo-validation",
  "insufficient-evidence",
] as const;

export type IssueClass = (typeof ISSUE_CLASSES)[number];

export const ISSUE_ACTIONS = {
  ingestion: "fix-ingestion",
  evaluator: "fix-evaluator",
  replay: "fix-replay",
  "candidate-selection": "adjust-selection",
  "repo-validation": "fix-repo-validation",
  "insufficient-evidence": "collect-evidence",
} as const satisfies Record<IssueClass, string>;

export type IssueAction = (typeof ISSUE_ACTIONS)[IssueClass];

export type DiagnosisGateStatus =
  "pass" | "fail" | "review" | "unavailable" | "indeterminate";

export interface DiagnosisGateFact {
  readonly id: string;
  readonly status: DiagnosisGateStatus;
}

export interface DiagnosisCaseFact {
  readonly caseId: string;
  readonly pipelineFamily: string;
  readonly terminalVerdict: "pass" | "fail" | "abstain";
  readonly failureCode: string | null;
  readonly evidenceRefs: readonly string[];
}

export interface FailedFamilyFacts {
  readonly gates: readonly DiagnosisGateFact[];
  readonly cases: readonly DiagnosisCaseFact[];
  readonly replayObserved: boolean;
}

export type DiagnosisConfidenceStatus =
  "pass" | "fail" | "review" | "unavailable";

export interface DiagnosisSnapshot extends FailedFamilyFacts {
  readonly snapshotId: string;
  readonly confidenceStatus: DiagnosisConfidenceStatus;
}

export interface RemediationValidationCommand {
  readonly name: string;
  readonly command: readonly string[];
  readonly timeout_seconds: number;
}

export type RemediationProposedChange =
  | {
      readonly type: "none";
      readonly content: null;
      readonly affected_files: readonly string[];
      readonly validation_commands: readonly RemediationValidationCommand[];
    }
  | {
      readonly type: "diff" | "configuration";
      readonly content: string;
      readonly affected_files: readonly string[];
      readonly validation_commands: readonly RemediationValidationCommand[];
    };

export interface RemediationValidation {
  readonly status: "not_run" | "passed" | "failed" | "review";
  readonly commands: readonly string[];
  readonly evidence_refs: readonly string[];
}

export type RemediationBaselineGateStatus = Exclude<
  DiagnosisGateStatus,
  "indeterminate"
>;

export interface RemediationProof {
  readonly target_gate_ids: readonly string[];
  readonly baseline_gate_statuses: Readonly<
    Record<string, RemediationBaselineGateStatus>
  >;
  readonly post_fix_snapshot_id: string | null;
  readonly holdout_snapshot_id: string | null;
  readonly target_improved: boolean;
  readonly regressed_gate_ids: readonly string[];
  readonly validation: RemediationValidation;
}

export interface RemediationEvidenceBody {
  readonly version: "1";
  readonly baseline_snapshot_id: string;
  readonly issue_class: IssueClass;
  readonly next_action: IssueAction;
  readonly status: "draft" | "review" | "proven";
  readonly trigger_case_ids: readonly string[];
  readonly proposed_change: RemediationProposedChange;
  readonly proof: RemediationProof;
  readonly residual_risks: readonly string[];
}

export interface RemediationEvidence extends RemediationEvidenceBody {
  readonly evidence_id: string;
}

export interface DiagnoseRemediationEvidenceInput {
  readonly baseline: DiagnosisSnapshot;
  readonly proposal?: RemediationProposedChange;
  readonly postFix?: DiagnosisSnapshot;
  readonly holdout?: DiagnosisSnapshot;
  readonly validation?: RemediationValidation;
}

export type Diagnosis = {
  [Class in IssueClass]: {
    readonly issueClass: Class;
    readonly nextAction: (typeof ISSUE_ACTIONS)[Class];
    readonly triggerCaseIds: readonly string[];
  };
}[IssueClass];

const EVALUATOR_FAILURES = new Set([
  "invalid_json",
  "schema_mismatch",
  "missing_required_fields",
  "frozen_human_verdict_fail",
  "reference_disagreement",
  "trajectory_mismatch",
]);

const SELECTION_GATES = [
  "zero-unsafe-substitutions",
  "recommendation-precision",
  "safe-opportunity-recall",
] as const;

export function diagnoseFailure(facts: FailedFamilyFacts): Diagnosis {
  const issueClass = classifyIssue(facts);
  return {
    issueClass,
    nextAction: ISSUE_ACTIONS[issueClass],
    triggerCaseIds: triggerCaseIds(facts.cases, issueClass),
  } as Diagnosis;
}

export function diagnoseRemediationEvidence(
  input: DiagnoseRemediationEvidenceInput,
): RemediationEvidence {
  const diagnosis = diagnoseFailure(input.baseline);
  const targetGateIds = failedOrWeakTargetGateIds(
    input.baseline,
    diagnosis.issueClass,
  );
  const proposedChange =
    diagnosis.issueClass === "insufficient-evidence"
      ? emptyChange()
      : normalizeChange(input.proposal);
  const proof = remediationProof(
    input.baseline,
    input.postFix,
    input.holdout,
    targetGateIds,
    input.validation,
  );
  const body: RemediationEvidenceBody = {
    version: "1",
    baseline_snapshot_id: input.baseline.snapshotId,
    issue_class: diagnosis.issueClass,
    next_action: diagnosis.nextAction,
    status: remediationStatus(diagnosis.issueClass, proposedChange, proof),
    trigger_case_ids: diagnosis.triggerCaseIds,
    proposed_change: proposedChange,
    proof,
    residual_risks: residualRisks(
      diagnosis.issueClass,
      proposedChange,
      proof,
      input.baseline,
      input.holdout,
    ),
  };
  return {
    ...body,
    evidence_id: `sha256:${computeRunSpecDigest(evidenceBodyValue(body))}`,
  };
}

function failedOrWeakTargetGateIds(
  snapshot: DiagnosisSnapshot,
  issueClass: IssueClass,
): string[] {
  const targetGateIds = snapshot.gates
    .filter(
      ({ status }) =>
        status === "fail" ||
        status === "review" ||
        status === "unavailable" ||
        status === "indeterminate",
    )
    .filter(
      ({ status }) =>
        status === "fail" || issueClass === "insufficient-evidence",
    )
    .map(({ id }) => id)
    .sort(compareText);
  return targetGateIds.length === 0 ? ["standard-benchmark"] : targetGateIds;
}

function emptyChange(): RemediationProposedChange {
  return {
    type: "none",
    content: null,
    affected_files: [],
    validation_commands: [],
  };
}

function normalizeChange(
  proposal: RemediationProposedChange | undefined,
): RemediationProposedChange {
  if (proposal === undefined) return emptyChange();
  const affectedFiles = [...new Set(proposal.affected_files)].sort(compareText);
  const validationCommands = proposal.validation_commands.map((command) => ({
    name: command.name,
    command: [...command.command],
    timeout_seconds: command.timeout_seconds,
  }));
  if (proposal.type === "none") {
    return {
      type: proposal.type,
      content: proposal.content,
      affected_files: affectedFiles,
      validation_commands: validationCommands,
    };
  }
  return {
    type: proposal.type,
    content: proposal.content,
    affected_files: affectedFiles,
    validation_commands: validationCommands,
  };
}

function remediationProof(
  baseline: DiagnosisSnapshot,
  postFix: DiagnosisSnapshot | undefined,
  holdout: DiagnosisSnapshot | undefined,
  targetGateIds: readonly string[],
  validation: RemediationValidation | undefined,
): RemediationProof {
  const baselineGates = new Map(baseline.gates.map((gate) => [gate.id, gate]));
  const postFixGates = new Map(
    (postFix?.gates ?? []).map((gate) => [gate.id, gate]),
  );
  const targetImproved =
    postFix !== undefined &&
    targetGateIds.length > 0 &&
    targetGateIds.every(
      (gateId) =>
        baselineGates.get(gateId)?.status !== "pass" &&
        postFixGates.get(gateId)?.status === "pass",
    );
  const regressedGateIds = [...baselineGates]
    .filter(
      ([gateId, gate]) =>
        gate.status === "pass" && postFixGates.get(gateId)?.status !== "pass",
    )
    .map(([gateId]) => gateId)
    .sort(compareText);
  const baselineGateStatuses: Record<string, RemediationBaselineGateStatus> =
    {};
  for (const [gateId, gate] of [...baselineGates].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    baselineGateStatuses[gateId] =
      gate.status === "indeterminate" ? "review" : gate.status;
  }
  return {
    target_gate_ids: [...targetGateIds],
    baseline_gate_statuses: baselineGateStatuses,
    post_fix_snapshot_id: postFix?.snapshotId ?? null,
    holdout_snapshot_id: holdout?.snapshotId ?? null,
    target_improved: targetImproved,
    regressed_gate_ids: regressedGateIds,
    validation: normalizeValidation(validation),
  };
}

function normalizeValidation(
  validation: RemediationValidation | undefined,
): RemediationValidation {
  if (validation === undefined) {
    return { status: "not_run", commands: [], evidence_refs: [] };
  }
  return {
    status: validation.status,
    commands: [...validation.commands],
    evidence_refs: [...validation.evidence_refs],
  };
}

function remediationStatus(
  issueClass: IssueClass,
  change: RemediationProposedChange,
  proof: RemediationProof,
): RemediationEvidenceBody["status"] {
  if (issueClass === "insufficient-evidence" || change.type === "none") {
    return "review";
  }
  if (
    proof.target_improved &&
    proof.regressed_gate_ids.length === 0 &&
    proof.validation.status === "passed"
  ) {
    return "proven";
  }
  return proof.post_fix_snapshot_id === null ? "draft" : "review";
}

function residualRisks(
  issueClass: IssueClass,
  change: RemediationProposedChange,
  proof: RemediationProof,
  baseline: DiagnosisSnapshot,
  holdout: DiagnosisSnapshot | undefined,
): string[] {
  const risks: string[] = [];
  if (issueClass === "insufficient-evidence") {
    risks.push("The available evidence does not isolate an actionable cause.");
  }
  if (change.type === "none") {
    risks.push("No diff or configuration change was proposed.");
  }
  if (proof.post_fix_snapshot_id === null) {
    risks.push("Post-fix benchmark proof has not been supplied.");
  }
  if (proof.regressed_gate_ids.length > 0) {
    risks.push(
      `The proposed fix regressed gates: ${proof.regressed_gate_ids.join(", ")}.`,
    );
  }
  if (proof.validation.status !== "passed") {
    risks.push("Post-fix validation is not recorded as passed.");
  }
  if (holdout === undefined) {
    risks.push("No holdout snapshot was supplied for this remediation.");
  } else if (!holdoutPasses(holdout)) {
    risks.push(
      "The supplied holdout snapshot does not pass its standard benchmark gate.",
    );
  }
  if (baseline.confidenceStatus !== "pass") {
    risks.push("The baseline confidence gate is not passing.");
  }
  return [...new Set(risks)].sort(compareText);
}

function holdoutPasses(snapshot: DiagnosisSnapshot): boolean {
  return (
    snapshot.gates.find(({ id }) => id === "standard-benchmark")?.status ===
    "pass"
  );
}

function evidenceBodyValue(body: RemediationEvidenceBody): JsonValue {
  return {
    version: body.version,
    baseline_snapshot_id: body.baseline_snapshot_id,
    issue_class: body.issue_class,
    next_action: body.next_action,
    status: body.status,
    trigger_case_ids: [...body.trigger_case_ids],
    proposed_change: {
      type: body.proposed_change.type,
      content: body.proposed_change.content,
      affected_files: [...body.proposed_change.affected_files],
      validation_commands: body.proposed_change.validation_commands.map(
        (command) => ({
          name: command.name,
          command: [...command.command],
          timeout_seconds: command.timeout_seconds,
        }),
      ),
    },
    proof: {
      target_gate_ids: [...body.proof.target_gate_ids],
      baseline_gate_statuses: { ...body.proof.baseline_gate_statuses },
      post_fix_snapshot_id: body.proof.post_fix_snapshot_id,
      holdout_snapshot_id: body.proof.holdout_snapshot_id,
      target_improved: body.proof.target_improved,
      regressed_gate_ids: [...body.proof.regressed_gate_ids],
      validation: {
        status: body.proof.validation.status,
        commands: [...body.proof.validation.commands],
        evidence_refs: [...body.proof.validation.evidence_refs],
      },
    },
    residual_risks: [...body.residual_risks],
  };
}

function classifyIssue(facts: FailedFamilyFacts): IssueClass {
  const gates = new Map(facts.gates.map((gate) => [gate.id, gate]));
  const codes = new Set(
    facts.cases.flatMap(({ failureCode }) =>
      failureCode === null || failureCode.length === 0 ? [] : [failureCode],
    ),
  );

  if ([...codes].some((code) => code.startsWith("ingestion_"))) {
    return "ingestion";
  }
  if (gates.has("replay-budget") || facts.replayObserved) {
    return "replay";
  }
  if ([...codes].some((code) => code.startsWith("replay_"))) {
    return "replay";
  }
  if (
    facts.cases.some(
      (caseFact) =>
        caseFact.terminalVerdict === "fail" &&
        caseFact.pipelineFamily === "repo-fix",
    ) ||
    [...gates.keys()].some((gateId) => gateId.startsWith("repo-"))
  ) {
    return "repo-validation";
  }
  if ([...codes].some((code) => EVALUATOR_FAILURES.has(code))) {
    return "evaluator";
  }
  if (codes.has("missing_candidate_result") || codes.has("missing_evidence")) {
    return "insufficient-evidence";
  }
  if (SELECTION_GATES.some((gateId) => gates.get(gateId)?.status === "fail")) {
    return "candidate-selection";
  }
  if (facts.cases.some(({ terminalVerdict }) => terminalVerdict === "fail")) {
    return "evaluator";
  }
  return "insufficient-evidence";
}

function triggerCaseIds(
  cases: readonly DiagnosisCaseFact[],
  issueClass: IssueClass,
): string[] {
  const caseIds = cases.flatMap((caseFact) => {
    const failureCode = caseFact.failureCode ?? "";
    if (issueClass === "ingestion" && failureCode.startsWith("ingestion_")) {
      return [caseFact.caseId];
    }
    if (
      issueClass === "replay" &&
      (failureCode.startsWith("replay_") || caseFact.terminalVerdict === "fail")
    ) {
      return [caseFact.caseId];
    }
    if (
      issueClass === "repo-validation" &&
      caseFact.pipelineFamily === "repo-fix"
    ) {
      return [caseFact.caseId];
    }
    if (issueClass === "evaluator" && EVALUATOR_FAILURES.has(failureCode)) {
      return [caseFact.caseId];
    }
    if (
      issueClass === "insufficient-evidence" &&
      (caseFact.terminalVerdict === "abstain" ||
        caseFact.evidenceRefs.length === 0)
    ) {
      return [caseFact.caseId];
    }
    if (
      issueClass === "candidate-selection" &&
      caseFact.terminalVerdict === "fail"
    ) {
      return [caseFact.caseId];
    }
    return [];
  });
  return [...new Set(caseIds)].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
