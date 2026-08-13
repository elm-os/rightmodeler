import { describe, expect, it } from "vitest";

import { EXCLUDED_FRACTION_MAX, aggregate } from "./aggregation.js";
import {
  MIN_DISTINCT_STEPS,
  MIN_DISTINCT_TRAJECTORIES,
  MIN_REVIEW_TRIALS,
  wilson,
} from "./statistics.js";
import {
  aggregationFact,
  aggregationFacts,
  aggregationScenarios,
  withExpectedAssignments,
} from "./__fixtures__/aggregation.js";

const options = {
  gatePolicyVersion: "gate-1",
  qualityFloor: 0.8,
  availabilityFloor: 0.8,
} as const;

describe("aggregate", () => {
  it("partitions by evidence question while pooling judge model and version", () => {
    const verdicts = aggregate(
      aggregationScenarios.partitionsAndJudgePooling,
      options,
    );

    expect(verdicts).toHaveLength(2);
    expect(
      verdicts.map((verdict) => [
        verdict.evidenceQuestionId,
        verdict.nReviewTrials,
      ]),
    ).toEqual([
      ["question-1", 10],
      ["question-2", 10],
    ]);
    expect(verdicts[0]?.evaluatorKinds[0]?.orderConsistencyRate).toBe(0.5);
  });

  it("reports evaluator kinds separately and applies the weakest kind", () => {
    const [verdict] = aggregate(aggregationScenarios.evaluatorKinds, options);

    expect(
      verdict.evaluatorKinds.map((kind) => ({
        evaluatorKind: kind.evaluatorKind,
        passes: kind.passes,
        trials: kind.trials,
        passRate: kind.passRate,
      })),
    ).toEqual([
      {
        evaluatorKind: "deterministic",
        passes: 10,
        trials: 10,
        passRate: 1,
      },
      { evaluatorKind: "judge", passes: 7, trials: 10, passRate: 0.7 },
    ]);
    expect(verdict.weakestEvaluatorKind).toBe("judge");
    expect(verdict.decision).toBe("inconclusive");
  });

  it("excludes ambiguous and lost executions and publishes a worst-case bound", () => {
    const [verdict] = aggregate(aggregationScenarios.excludedFraction, options);
    const [kind] = verdict.evaluatorKinds;

    expect(kind).toMatchObject({ passes: 18, trials: 18 });
    expect(verdict.excludedExecutions).toBe(2);
    expect(verdict.excludedFraction).toBe(0.1);
    expect(verdict.excludedFraction).toBeGreaterThan(EXCLUDED_FRACTION_MAX);
    expect(verdict.worstCaseBound).toBeCloseTo(wilson(18, 20).lower, 12);
    expect(verdict).toMatchObject({
      decision: "abstain",
      abstainReason: { reason: "excluded_fraction_exceeded" },
    });
  });

  it("keeps conditional quality separate from availability", () => {
    const [verdict] = aggregate(
      aggregationScenarios.availabilityDivergence,
      options,
    );
    const [kind] = verdict.evaluatorKinds;

    expect(kind.passRate).toBe(1);
    expect(kind).toMatchObject({ passes: 17, trials: 17 });
    expect(kind.naiveInterval?.lower).toBeGreaterThan(0.75);
    expect(verdict.availability).toMatchObject({
      availableExecutions: 17,
      executions: 20,
      rate: 0.85,
    });
    expect(verdict.availability.lowerBound).toBeLessThan(0.8);
    expect(verdict).toMatchObject({
      decision: "abstain",
      abstainReason: { reason: "insufficient_availability" },
    });
  });

  it("recommends when complete evidence clears both aggregate floors", () => {
    const [verdict] = aggregate(aggregationFacts(20), options);

    expect(verdict.worstCaseBound).toBeGreaterThan(options.qualityFloor);
    expect(verdict.availability.lowerBound).toBeGreaterThan(
      options.availabilityFloor,
    );
    expect(verdict.decision).toBe("recommend");
  });

  it("applies the excluded-fraction refusal to each evaluator kind", () => {
    const expectedEvaluatorAssignments = Array.from(
      { length: 100 },
      (_, index) => ({
        caseId: `case-${index}`,
        stratumId: "default",
        evaluatorKind: index < 20 ? "judge" : "deterministic",
      }),
    );
    const facts = [
      ...Array.from({ length: 20 }, (_, index) =>
        aggregationFact(index, {
          evaluatorKind: "judge",
          attribution: index < 5 ? "lost" : "ok",
          expectedEvaluatorAssignments,
        }),
      ),
      ...Array.from({ length: 80 }, (_, offset) =>
        aggregationFact(offset + 20, {
          evaluatorKind: "deterministic",
          expectedEvaluatorAssignments,
        }),
      ),
    ];

    expect(
      aggregate(facts, { ...options, availabilityFloor: 0.7 })[0],
    ).toMatchObject({
      decision: "abstain",
      abstainReason: { reason: "excluded_fraction_exceeded" },
    });
  });

  it("carries the reference ceiling and leaves Mode A optimism absent", () => {
    const facts = aggregationFacts(10, { referenceCeilingMultiplier: 0.92 });
    const [verdict] = aggregate(facts, options);

    expect(verdict.referenceCeilingMultiplier).toBe(0.92);
    expect(verdict).not.toHaveProperty("modeAOptimismDelta");
  });

  it("refuses a naive interval and uses a cluster bootstrap lower bound", () => {
    const [verdict] = aggregate(
      aggregationScenarios.trajectoryClustering,
      options,
    );
    const [kind] = verdict.evaluatorKinds;

    expect(verdict.nTrajectories).toBe(5);
    expect(verdict).not.toHaveProperty("naiveInterval");
    expect(verdict.clusterBootstrapLow).toBeTypeOf("number");
    expect(kind).not.toHaveProperty("naiveInterval");
    expect(kind.clusterBootstrapLow).toBeCloseTo(wilson(5, 5).lower, 12);
  });

  it("uses trajectory resampling for mixed clustered outcomes", () => {
    const facts = aggregationFacts(16, (index) => ({
      passed: index < 10,
      trajectoryId: `trajectory-${index % 8}`,
    }));
    const [verdict] = aggregate(facts, {
      ...options,
      qualityFloor: 0.2,
    });
    const [kind] = verdict.evaluatorKinds;

    expect(kind.passRate).toBe(0.625);
    expect(kind.clusterBootstrapLow).not.toBeCloseTo(wilson(10, 16).lower, 4);
  });

  it("refuses a naive interval when a repeated trajectory includes an exclusion", () => {
    const facts = aggregationFacts(20, (index) => ({
      attribution: index === 1 ? "ambiguous" : "ok",
      trajectoryId: index < 2 ? "shared" : `trajectory-${index}`,
    }));
    const [verdict] = aggregate(facts, options);
    const [kind] = verdict.evaluatorKinds;

    expect(verdict.excludedFraction).toBe(EXCLUDED_FRACTION_MAX);
    expect(kind).not.toHaveProperty("naiveInterval");
    expect(kind.clusterBootstrapLow).toBeTypeOf("number");
  });

  it.each([
    {
      name: "review trials",
      facts: aggregationScenarios.insufficientReviewTrials,
      reason: "insufficient_review_trials",
      observed: 9,
      minimum: MIN_REVIEW_TRIALS,
    },
    {
      name: "distinct steps",
      facts: aggregationScenarios.insufficientDistinctSteps,
      reason: "insufficient_distinct_steps",
      observed: 1,
      minimum: MIN_DISTINCT_STEPS,
    },
    {
      name: "distinct trajectories",
      facts: aggregationScenarios.insufficientDistinctTrajectories,
      reason: "insufficient_distinct_trajectories",
      observed: 4,
      minimum: MIN_DISTINCT_TRAJECTORIES,
    },
  ])("names the $name minimum when evidence is below it", (scenario) => {
    const [verdict] = aggregate(scenario.facts, options);

    expect(scenario.observed).toBeLessThan(scenario.minimum);
    expect(verdict).toMatchObject({
      decision: "abstain",
      abstainReason: {
        reason: scenario.reason,
        observed: scenario.observed,
        required: scenario.minimum,
      },
    });
  });

  it("abstains when a family requires deterministic evidence and has none", () => {
    const facts = aggregationFacts(10, {
      requiresDeterministicEvidence: true,
      hasDeterministicEvidence: false,
    });

    expect(aggregate(facts, options)[0]).toMatchObject({
      decision: "abstain",
      abstainReason: { reason: "missing_deterministic_evidence" },
    });
  });

  it("does not borrow step diversity from another evaluator kind", () => {
    const expectedEvaluatorAssignments = Array.from(
      { length: 20 },
      (_, caseIndex) => ({
        caseId: `case-${caseIndex}`,
        stratumId: "default",
        evaluatorKind: caseIndex < 10 ? "deterministic" : "judge",
      }),
    );
    const facts = [
      ...Array.from({ length: 10 }, (_, index) =>
        aggregationFact(index, {
          evaluatorKind: "deterministic",
          expectedEvaluatorAssignments,
        }),
      ),
      ...Array.from({ length: 10 }, (_, offset) =>
        aggregationFact(offset + 10, {
          evaluatorKind: "judge",
          expectedEvaluatorAssignments,
          stepId: "only-judge-step",
        }),
      ),
    ];

    expect(aggregate(facts, options)[0]).toMatchObject({
      decision: "abstain",
      abstainReason: { reason: "insufficient_distinct_steps" },
    });
  });

  it("abstains when a predeclared evaluator kind is wholly absent", () => {
    const expectedEvaluatorAssignments = [
      ...Array.from({ length: 10 }, (_, index) => ({
        caseId: `case-${index}`,
        stratumId: "default",
        evaluatorKind: "deterministic",
      })),
      { caseId: "case-10", stratumId: "default", evaluatorKind: "judge" },
    ];
    const facts = Array.from({ length: 10 }, (_, index) =>
      aggregationFact(index, {
        evaluatorKind: "deterministic",
        expectedEvaluatorAssignments,
      }),
    );

    expect(aggregate(facts, options)[0]).toMatchObject({
      decision: "abstain",
      abstainReason: { reason: "incomplete_evaluator_coverage" },
    });
  });

  it("abstains when one predeclared case-kind assignment is absent", () => {
    const expectedEvaluatorAssignments = Array.from(
      { length: 11 },
      (_, index) => ({
        caseId: `case-${index}`,
        stratumId: "default",
        evaluatorKind: "judge",
      }),
    );
    const facts = Array.from({ length: 10 }, (_, index) =>
      aggregationFact(index, { expectedEvaluatorAssignments }),
    );

    expect(aggregate(facts, options)[0]).toMatchObject({
      decision: "abstain",
      abstainReason: { reason: "incomplete_evaluator_coverage" },
    });
  });

  it("abstains when evidence contains an unplanned case-kind assignment", () => {
    const facts = aggregationFacts(10);
    const expectedEvaluatorAssignments = facts.slice(0, 9).map((fact) => ({
      caseId: fact.execution.caseId,
      stratumId: fact.stratumId,
      evaluatorKind: fact.evaluatorKind,
    }));

    expect(
      aggregate(
        facts.map((fact) => ({ ...fact, expectedEvaluatorAssignments })),
        options,
      )[0],
    ).toMatchObject({
      decision: "abstain",
      abstainReason: { reason: "incomplete_evaluator_coverage" },
    });
  });

  it("abstains when one predeclared assignment is executed twice", () => {
    const facts = aggregationFacts(10);
    const duplicate = {
      ...facts[0]!,
      execution: {
        ...facts[0]!.execution,
        executionId: "duplicate-execution",
      },
      assessment: {
        ...facts[0]!.assessment!,
        assessmentId: "duplicate-assessment",
        executionId: "duplicate-execution",
      },
    };

    expect(aggregate([...facts, duplicate], options)[0]).toMatchObject({
      decision: "abstain",
      abstainReason: { reason: "incomplete_evaluator_coverage" },
    });
  });

  it("requires position-swap agreement metadata for judge evidence", () => {
    const facts = Array.from({ length: 10 }, (_, index) => ({
      ...aggregationFact(index),
      orderConsistent: undefined,
    }));

    expect(() => aggregate(facts, options)).toThrow(/order consistency/i);
  });

  it("names a failed minimum before a required-abstention failure", () => {
    const facts = aggregationFacts(9, (index) => ({
      requiredAbstention: index === 0,
      terminalOutcome: "success",
    }));

    expect(aggregate(facts, options)[0]).toMatchObject({
      decision: "abstain",
      abstainReason: { reason: "insufficient_review_trials" },
    });
  });

  it("derives required-abstention satisfaction from the execution outcome", () => {
    const facts = aggregationFacts(20, (index) => ({
      requiredAbstention: index < 10,
      terminalOutcome: "success",
    }));

    expect(aggregate(facts, options)[0]).toMatchObject({
      satisfiedRequiredAbstentions: 0,
      decision: "abstain",
      abstainReason: { reason: "required_abstention" },
    });
  });

  it("does not count an unattributable abstention as satisfied", () => {
    const facts = aggregationFacts(100, (index) => ({
      requiredAbstention: index === 0,
      attribution: index === 0 ? "ambiguous" : "ok",
    }));

    expect(aggregate(facts, options)[0]).toMatchObject({
      requiredAbstentions: 1,
      satisfiedRequiredAbstentions: 0,
      decision: "abstain",
      abstainReason: { reason: "required_abstention" },
    });
  });

  it("keeps required-abstention cases out of conditional quality", () => {
    const facts = withExpectedAssignments([
      ...Array.from({ length: 90 }, (_, index) =>
        aggregationFact(index, { requiredAbstention: true }),
      ),
      ...Array.from({ length: 10 }, (_, offset) =>
        aggregationFact(offset + 90, { passed: false }),
      ),
    ]);

    const [verdict] = aggregate(facts, options);

    expect(verdict.evaluatorKinds[0]).toMatchObject({
      conditionalExecutions: 10,
      passes: 0,
      trials: 10,
      passRate: 0,
    });
    expect(verdict.requiredAbstentions).toBe(90);
    expect(verdict.satisfiedRequiredAbstentions).toBe(90);
  });

  it("refuses to relabel evidence with a different gate policy version", () => {
    const facts = aggregationFacts(10, { gatePolicyVersion: "gate-old" });

    expect(() => aggregate(facts, options)).toThrow(/gate policy/i);
  });

  it("fails loudly when an attributable execution has no assessment", () => {
    const facts = aggregationFacts(10, (index) => ({
      assessment: index === 0 ? null : undefined,
    }));

    expect(() => aggregate(facts, options)).toThrow(/execution-0.*assessment/i);
  });

  it("carries judge disagreement as conservative quality variance", () => {
    const facts = aggregationFacts(10, (index) => ({
      judgeModel: "judge-a",
      orderConsistent: index !== 0,
    }));

    const [verdict] = aggregate(facts, options);

    expect(verdict.evaluatorKinds[0]).toMatchObject({
      orderConsistencyRate: 0.9,
      passes: 9,
      trials: 10,
      worstCasePassRate: 0.9,
    });
  });
});
