import { DEFAULT_PASS_FRACTION, type FamilyVerdict } from "./aggregation.js";

export const GATE_IDS = [
  "zero-unsafe-substitutions",
  "quality",
  "evidence-coverage",
  "required-abstention",
  "availability",
] as const;

export type GateId = (typeof GATE_IDS)[number];

export interface GateResult {
  readonly id: GateId;
  readonly pass: boolean;
  readonly reason: string;
}

export class ReleaseGatePolicy {
  readonly #validated = true;
  readonly gatePolicyVersion: string;
  readonly qualityFloor: number;
  readonly passFraction = DEFAULT_PASS_FRACTION;

  constructor(input: {
    readonly gatePolicyVersion: string;
    readonly qualityFloor: number;
  }) {
    if (input.gatePolicyVersion.length === 0) {
      throw new RangeError("gatePolicyVersion must not be empty");
    }
    if (
      !Number.isFinite(input.qualityFloor) ||
      input.qualityFloor <= 0.8 ||
      input.qualityFloor > 1
    ) {
      throw new RangeError("qualityFloor must be in (0.8, 1.0]");
    }
    this.gatePolicyVersion = input.gatePolicyVersion;
    this.qualityFloor = input.qualityFloor;
  }
}

export function evaluateGates(
  verdicts: readonly FamilyVerdict[],
  policy: ReleaseGatePolicy,
): GateResult[] {
  for (const verdict of verdicts) {
    if (verdict.gatePolicyVersion !== policy.gatePolicyVersion) {
      throw new Error(
        `verdict ${verdict.evidenceQuestionId} was produced under a different gate policy`,
      );
    }
  }

  const unsafeSubstitutions = verdicts.reduce(
    (total, verdict) => total + verdict.unsafeSubstitutions,
    0,
  );
  const qualityFailures = verdicts.filter((verdict) => {
    return (
      verdict.decision === "abstain" ||
      verdict.evaluatorKinds.some(
        (kind) => kind.worstCaseBound < policy.qualityFloor,
      )
    );
  });
  const coveredEvidenceCases = verdicts.reduce(
    (total, verdict) => total + verdict.coveredEvidenceCases,
    0,
  );
  const evidenceCases = verdicts.reduce(
    (total, verdict) => total + verdict.nExecutions,
    0,
  );
  const requiredAbstentions = verdicts.reduce(
    (total, verdict) => total + verdict.requiredAbstentions,
    0,
  );
  const satisfiedRequiredAbstentions = verdicts.reduce(
    (total, verdict) => total + verdict.satisfiedRequiredAbstentions,
    0,
  );
  const availabilityFailures = verdicts.filter(
    (verdict) => verdict.availability.lowerBound < policy.qualityFloor,
  );

  return [
    result(
      "zero-unsafe-substitutions",
      unsafeSubstitutions === 0,
      unsafeSubstitutions === 0
        ? "No unsafe substitutions were observed."
        : `${unsafeSubstitutions} unsafe substitution(s) were observed.`,
    ),
    result(
      "quality",
      verdicts.length > 0 && qualityFailures.length === 0,
      verdicts.length === 0
        ? "No verdicts were available for the quality gate."
        : qualityFailures.length === 0
          ? `Every worst-case-imputed evaluator lower bound meets the ${policy.qualityFloor} quality floor.`
          : `${qualityFailures.length} verdict(s) miss the ${policy.qualityFloor} worst-case-imputed quality floor or have a named abstention.`,
    ),
    result(
      "evidence-coverage",
      evidenceCases > 0 && coveredEvidenceCases === evidenceCases,
      evidenceCases === 0
        ? "No executions were available for the evidence-coverage gate."
        : coveredEvidenceCases === evidenceCases
          ? `All ${evidenceCases} execution(s) have evidence coverage.`
          : `${coveredEvidenceCases} of ${evidenceCases} execution(s) have evidence coverage.`,
    ),
    result(
      "required-abstention",
      satisfiedRequiredAbstentions === requiredAbstentions,
      satisfiedRequiredAbstentions === requiredAbstentions
        ? `All ${requiredAbstentions} required abstention(s) were satisfied.`
        : `${satisfiedRequiredAbstentions} of ${requiredAbstentions} required abstention(s) were satisfied.`,
    ),
    result(
      "availability",
      verdicts.length > 0 && availabilityFailures.length === 0,
      verdicts.length === 0
        ? "No verdicts were available for the availability gate."
        : availabilityFailures.length === 0
          ? `Every availability lower bound meets the ${policy.qualityFloor} floor.`
          : `${availabilityFailures.length} verdict(s) miss the ${policy.qualityFloor} availability floor.`,
    ),
  ];
}

function result(id: GateId, pass: boolean, reason: string): GateResult {
  return { id, pass, reason };
}
