import { createHash } from "node:crypto";

import {
  type EvaluatorKindVerdict,
  type FamilyVerdict,
} from "./aggregation.js";
import { clusterBootstrap, wilson } from "./statistics.js";
import type { Interval } from "./statistics.js";
import { evaluateGates, type ReleaseGatePolicy } from "./gates.js";

export type CorpusSplit = "shortlist" | "holdout";

export interface CandidateSplitVerdicts {
  readonly shortlist: FamilyVerdict;
  readonly holdout?: FamilyVerdict;
}

export type VerdictsByCandidate = Readonly<
  Record<string, CandidateSplitVerdicts>
>;

export interface SelectionAdjustedEstimate extends Interval {
  readonly confidence: 0.95;
  readonly comparisons: number;
  readonly evaluatorKind: string;
  readonly method: "wilson" | "cluster_bootstrap";
}

export type WinnerSelection =
  | {
      readonly status: "no_shortlist_passer";
      readonly shortlistedCandidateIds: readonly string[];
      readonly holdoutRequired: false;
    }
  | {
      readonly status: "confirmation_required";
      readonly shortlistedCandidateIds: readonly string[];
      readonly confirmedCandidateId: string;
      readonly holdoutRequired: true;
    }
  | {
      readonly status: "holdout_failed" | "selected";
      readonly shortlistedCandidateIds: readonly string[];
      readonly confirmedCandidateId: string;
      readonly selectedCandidateId?: string;
      readonly selectionAdjustedEstimate: SelectionAdjustedEstimate;
      readonly holdoutRequired: false;
    };

export function assignSplits(
  caseIds: readonly string[],
  seed: string | number,
): Readonly<Record<string, CorpusSplit>> {
  const unique = new Set(caseIds);
  if (unique.size !== caseIds.length) {
    throw new Error("caseIds contains a duplicate identifier");
  }

  const ranked = [...caseIds].sort((left, right) => {
    const leftHash = splitHash(seed, left);
    const rightHash = splitHash(seed, right);
    return compareText(leftHash, rightHash) || compareText(left, right);
  });
  const shortlistSize = Math.floor(ranked.length / 2);
  const shortlistIds = new Set(ranked.slice(0, shortlistSize));

  return Object.fromEntries(
    [...caseIds]
      .sort()
      .map((caseId) => [
        caseId,
        shortlistIds.has(caseId) ? "shortlist" : "holdout",
      ]),
  );
}

export function assignDriftSplit(
  stableCaseIdentity: string,
  seed: string | number,
): CorpusSplit {
  return splitHash(seed, stableCaseIdentity) < "8".padEnd(64, "0")
    ? "shortlist"
    : "holdout";
}

export function selectWinner(
  verdictsByCandidate: VerdictsByCandidate,
  policy: ReleaseGatePolicy,
): WinnerSelection {
  const candidates = Object.entries(verdictsByCandidate);
  validateShortlists(candidates, policy.gatePolicyVersion);

  const shortlisted = candidates
    .filter(([, verdicts]) =>
      clearsShortlist(verdicts.shortlist, policy.passFraction),
    )
    .sort(
      ([leftId, left], [rightId, right]) =>
        left.shortlist.candidateCostUsd - right.shortlist.candidateCostUsd ||
        compareText(leftId, rightId),
    );
  const shortlistedCandidateIds = shortlisted.map(
    ([candidateId]) => candidateId,
  );
  const winner = shortlisted[0];
  if (winner === undefined) {
    return {
      status: "no_shortlist_passer",
      shortlistedCandidateIds,
      holdoutRequired: false,
    };
  }

  const [confirmedCandidateId, verdicts] = winner;
  if (verdicts.holdout === undefined) {
    return {
      status: "confirmation_required",
      shortlistedCandidateIds,
      confirmedCandidateId,
      holdoutRequired: true,
    };
  }
  validateWinnerHoldout(
    confirmedCandidateId,
    verdicts.shortlist,
    verdicts.holdout,
    policy.gatePolicyVersion,
  );
  const selectionAdjustedEstimate = adjustedWeakestEstimate(
    verdicts.holdout,
    candidates.length,
  );
  const selected =
    evaluateGates([verdicts.holdout], policy).every((gate) => gate.pass) &&
    selectionAdjustedEstimate.lower >= policy.qualityFloor;

  return {
    status: selected ? "selected" : "holdout_failed",
    shortlistedCandidateIds,
    confirmedCandidateId,
    ...(selected ? { selectedCandidateId: confirmedCandidateId } : {}),
    selectionAdjustedEstimate,
    holdoutRequired: false,
  };
}

function clearsShortlist(
  verdict: FamilyVerdict,
  passFraction: number,
): boolean {
  return (
    verdict.decision !== "abstain" &&
    verdict.unsafeSubstitutions === 0 &&
    verdict.evaluatorKinds.every((kind) => kind.passRate >= passFraction)
  );
}

function adjustedWeakestEstimate(
  verdict: FamilyVerdict,
  comparisons: number,
): SelectionAdjustedEstimate {
  const adjusted = verdict.evaluatorKinds.map((kind) =>
    adjustedEstimate(kind, comparisons, verdict.evidenceQuestionId),
  );
  return adjusted.sort(
    (left, right) =>
      left.lower - right.lower ||
      compareText(left.evaluatorKind, right.evaluatorKind),
  )[0]!;
}

function adjustedEstimate(
  kind: EvaluatorKindVerdict,
  comparisons: number,
  evidenceQuestionId: string,
): SelectionAdjustedEstimate {
  const clustered = kind.trajectoryClusters.some(
    (trajectory) => trajectory.trials > 1,
  );
  const interval = clustered
    ? clusterBootstrap(trajectoryOutcomes(kind), {
        resamples: 5_000,
        seed: stableSeed(
          `${evidenceQuestionId}\0${kind.evaluatorKind}\0selection`,
        ),
        comparisons,
      })
    : wilson(
        kind.trajectoryClusters.reduce(
          (total, trajectory) => total + trajectory.passes,
          0,
        ),
        kind.trajectoryClusters.reduce(
          (total, trajectory) => total + trajectory.trials,
          0,
        ),
        { comparisons },
      );

  return {
    ...interval,
    confidence: 0.95,
    comparisons,
    evaluatorKind: kind.evaluatorKind,
    method: clustered ? "cluster_bootstrap" : "wilson",
  };
}

function trajectoryOutcomes(
  kind: EvaluatorKindVerdict,
): Readonly<Record<string, readonly boolean[]>> {
  return Object.fromEntries(
    kind.trajectoryClusters.map((trajectory) => [
      trajectory.trajectoryId,
      [
        ...Array.from({ length: trajectory.passes }, () => true),
        ...Array.from(
          { length: trajectory.trials - trajectory.passes },
          () => false,
        ),
      ],
    ]),
  );
}

function validateShortlists(
  candidates: readonly [string, CandidateSplitVerdicts][],
  gatePolicyVersion: string,
): void {
  const evidenceQuestionIds = new Set<string>();
  const familyIds = new Set<string>();
  const gatePolicyVersions = new Set<string>();
  let expectedShortlistCases: readonly string[] | undefined;
  for (const [candidateId, verdicts] of candidates) {
    if (verdicts.shortlist.candidateId !== candidateId) {
      throw new Error(
        `candidate key ${candidateId} does not match its shortlist verdict`,
      );
    }
    if (verdicts.shortlist.corpusSplit !== "shortlist") {
      throw new Error(`candidate ${candidateId} has a mislabeled shortlist`);
    }
    if (verdicts.shortlist.gatePolicyVersion !== gatePolicyVersion) {
      throw new Error(`candidate ${candidateId} uses a different gate policy`);
    }
    const shortlistCases = [...verdicts.shortlist.caseIds].sort(compareText);
    expectedShortlistCases ??= shortlistCases;
    if (!sameStrings(shortlistCases, expectedShortlistCases)) {
      throw new Error("candidate shortlist verdicts use different cases");
    }
    evidenceQuestionIds.add(verdicts.shortlist.evidenceQuestionId);
    familyIds.add(verdicts.shortlist.familyId);
    gatePolicyVersions.add(verdicts.shortlist.gatePolicyVersion);
  }
  if (
    evidenceQuestionIds.size > 1 ||
    familyIds.size > 1 ||
    gatePolicyVersions.size > 1
  ) {
    throw new Error(
      "candidate verdicts do not answer the same evidence question",
    );
  }
}

function validateWinnerHoldout(
  candidateId: string,
  shortlist: FamilyVerdict,
  holdout: FamilyVerdict,
  gatePolicyVersion: string,
): void {
  if (holdout.candidateId !== candidateId) {
    throw new Error(
      `candidate key ${candidateId} does not match its holdout verdict`,
    );
  }
  if (holdout.corpusSplit !== "holdout") {
    throw new Error(`candidate ${candidateId} has a mislabeled holdout`);
  }
  if (
    shortlist.candidateCostUsd !== holdout.candidateCostUsd ||
    shortlist.candidateFamily !== holdout.candidateFamily ||
    shortlist.familyId !== holdout.familyId ||
    shortlist.evidenceQuestionId !== holdout.evidenceQuestionId
  ) {
    throw new Error(`candidate ${candidateId} has inconsistent split metadata`);
  }
  if (holdout.gatePolicyVersion !== gatePolicyVersion) {
    throw new Error(`candidate ${candidateId} uses a different gate policy`);
  }
  const holdoutCases = new Set(holdout.caseIds);
  if (shortlist.caseIds.some((caseId) => holdoutCases.has(caseId))) {
    throw new Error(
      `candidate ${candidateId} reuses a case across corpus splits`,
    );
  }
}

function splitHash(seed: string | number, caseId: string): string {
  return createHash("sha256")
    .update(String(seed))
    .update("\0")
    .update(caseId)
    .digest("hex");
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableSeed(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
