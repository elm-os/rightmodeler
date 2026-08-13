import { describe, expect, it } from "vitest";

import {
  aggregationFact,
  aggregationFacts,
  withExpectedAssignments,
} from "./__fixtures__/aggregation.js";
import { aggregate } from "./aggregation.js";
import { ReleaseGatePolicy, evaluateGates, type GateId } from "./gates.js";

function verdicts(
  overrides: Parameters<typeof aggregationFact>[1] = {},
  count = 100,
) {
  return aggregate(aggregationFacts(count, overrides), {
    gatePolicyVersion: "gate-1",
    qualityFloor: 0.8,
    availabilityFloor: 0.8,
  });
}

function gateMap(
  results: ReturnType<typeof evaluateGates>,
): Readonly<Record<GateId, boolean>> {
  return Object.fromEntries(
    results.map((result) => [result.id, result.pass]),
  ) as Readonly<Record<GateId, boolean>>;
}

describe("ReleaseGatePolicy", () => {
  it("constructs the fixed shortlist policy and validates the quality floor", () => {
    const policy = new ReleaseGatePolicy({
      gatePolicyVersion: "gate-1",
      qualityFloor: 0.9,
      availabilityFloor: 0.8,
    });

    expect(policy).toEqual({
      gatePolicyVersion: "gate-1",
      qualityFloor: 0.9,
      availabilityFloor: 0.8,
      passFraction: 0.75,
    });
    expect(
      () =>
        new ReleaseGatePolicy({
          gatePolicyVersion: "gate-1",
          qualityFloor: 0.8,
          availabilityFloor: 0.8,
        }),
    ).toThrow(/qualityFloor/);
    expect(
      () =>
        new ReleaseGatePolicy({
          gatePolicyVersion: "gate-1",
          qualityFloor: 1.001,
          availabilityFloor: 0.8,
        }),
    ).toThrow(/qualityFloor/);
  });
});

describe("evaluateGates", () => {
  const policy = new ReleaseGatePolicy({
    gatePolicyVersion: "gate-1",
    qualityFloor: 0.8 + Number.EPSILON,
    availabilityFloor: 0.8 + Number.EPSILON,
  });

  it("passes all five release gates for complete safe evidence", () => {
    const results = evaluateGates(verdicts(), policy);

    expect(results.map((result) => result.id)).toEqual([
      "zero-unsafe-substitutions",
      "quality",
      "evidence-coverage",
      "required-abstention",
      "availability",
    ]);
    expect(results.every((result) => result.pass)).toBe(true);
    expect(results.every((result) => result.reason.length > 0)).toBe(true);
  });

  it.each([
    {
      gate: "zero-unsafe-substitutions",
      overrides: { unsafeSubstitution: true },
    },
    { gate: "quality", overrides: { passed: false } },
    { gate: "evidence-coverage", overrides: { evidenceCovered: false } },
    {
      gate: "required-abstention",
      overrides: {
        requiredAbstention: true,
        terminalOutcome: "success",
      },
    },
    { gate: "availability", overrides: { attribution: "silent-failure" } },
  ] as const)("fails the $gate gate independently", ({ gate, overrides }) => {
    const results = gateMap(evaluateGates(verdicts(overrides), policy));

    expect(results[gate]).toBe(false);
  });

  it("keeps conditional quality separate when availability fails", () => {
    const facts = aggregationFacts(100, (index) => ({
      attribution: index < 15 ? "silent-failure" : "ok",
    }));
    const [verdict] = aggregate(facts, {
      gatePolicyVersion: "gate-1",
      qualityFloor: 0.8,
      availabilityFloor: 0.8,
    });
    const results = gateMap(evaluateGates([verdict], policy));

    expect(verdict.evaluatorKinds[0]).toMatchObject({
      averageScore: 1,
      passRate: 1,
    });
    expect(results.availability).toBe(false);
  });

  it("does not let required-abstention cases inflate conditional quality", () => {
    const facts = withExpectedAssignments([
      ...Array.from({ length: 90 }, (_, index) =>
        aggregationFact(index, { requiredAbstention: true }),
      ),
      ...Array.from({ length: 10 }, (_, offset) =>
        aggregationFact(offset + 90, { passed: false }),
      ),
    ]);
    const [verdict] = aggregate(facts, {
      gatePolicyVersion: "gate-1",
      qualityFloor: 0.8,
      availabilityFloor: 0.8,
    });
    const results = gateMap(evaluateGates([verdict], policy));

    expect(verdict.evaluatorKinds[0]).toMatchObject({ passes: 0, trials: 10 });
    expect(results.quality).toBe(false);
    expect(results["required-abstention"]).toBe(true);
  });

  it("does not exempt required-abstention cases from named refusals or availability", () => {
    const facts = aggregationFacts(100, (index) => ({
      requiredAbstention: true,
      attribution: index < 20 ? "silent-failure" : "ok",
    }));
    const [verdict] = aggregate(facts, {
      gatePolicyVersion: "gate-1",
      qualityFloor: 0.8,
      availabilityFloor: 0.8,
    });
    const results = gateMap(evaluateGates([verdict], policy));

    expect(verdict).toMatchObject({
      decision: "abstain",
      abstainReason: {
        reason: "insufficient_review_trials",
        observed: 0,
        required: 10,
      },
    });
    expect(results.quality).toBe(false);
    expect(results.availability).toBe(false);
    expect(results["required-abstention"]).toBe(false);
  });

  it("does not conflate a coverage abstention with a quality failure", () => {
    const [verdict] = aggregate(
      aggregationFacts(100, { evidenceCovered: false }),
      {
        gatePolicyVersion: "gate-1",
        qualityFloor: 0.8,
        availabilityFloor: 0.8,
      },
    );
    const results = gateMap(evaluateGates([verdict], policy));

    expect(verdict).toMatchObject({
      decision: "abstain",
      abstainReason: {
        reason: "incomplete_evidence_coverage",
        observed: 0,
        required: 100,
      },
    });
    expect(results.quality).toBe(true);
    expect(results["evidence-coverage"]).toBe(false);
  });

  it("gates the worst-case-imputed lower bound rather than raw scores", () => {
    const facts = aggregationFacts(100, (index) => ({
      passed: index < 90,
      score: 1,
    }));
    const [verdict] = aggregate(facts, {
      gatePolicyVersion: "gate-1",
      qualityFloor: 0.9,
      availabilityFloor: 0.8,
    });
    const strictPolicy = new ReleaseGatePolicy({
      gatePolicyVersion: "gate-1",
      qualityFloor: 0.9,
      availabilityFloor: 0.8,
    });
    const results = gateMap(evaluateGates([verdict], strictPolicy));

    expect(verdict.evaluatorKinds[0]?.averageScore).toBe(1);
    expect(verdict.worstCaseBound).toBeLessThan(0.9);
    expect(results.quality).toBe(false);
  });

  it("refuses verdicts produced under a different gate policy", () => {
    expect(() =>
      evaluateGates(
        verdicts(),
        new ReleaseGatePolicy({
          gatePolicyVersion: "gate-2",
          qualityFloor: 0.9,
          availabilityFloor: 0.8,
        }),
      ),
    ).toThrow(/gate policy/i);
  });

  it("does not pass release quality, coverage, or availability without evidence", () => {
    const results = gateMap(evaluateGates([], policy));

    expect(results.quality).toBe(false);
    expect(results["evidence-coverage"]).toBe(false);
    expect(results.availability).toBe(false);
  });
});
