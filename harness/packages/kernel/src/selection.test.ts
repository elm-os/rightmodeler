import { describe, expect, it } from "vitest";

import {
  aggregationFact,
  aggregationFacts,
} from "./__fixtures__/aggregation.js";
import { aggregate, type FamilyVerdict } from "./aggregation.js";
import { wilson } from "./statistics.js";
import { assignSplits, selectWinner } from "./selection.js";
import { ReleaseGatePolicy } from "./gates.js";

const policy = new ReleaseGatePolicy({
  gatePolicyVersion: "gate-1",
  qualityFloor: 0.9,
  availabilityFloor: 0.8,
});

function splitVerdict(input: {
  candidateId: string;
  cost: number;
  split: "shortlist" | "holdout";
  trials: number;
  passes: number;
}): FamilyVerdict {
  return aggregate(
    aggregationFacts(input.trials, (index) => ({
      candidateId: input.candidateId,
      candidateCostUsd: input.cost,
      caseId: `${input.split}-case-${index}`,
      corpusSplit: input.split,
      passed: index < input.passes,
    })),
    {
      gatePolicyVersion: "gate-1",
      qualityFloor: 0.8,
      availabilityFloor: 0.8,
    },
  )[0]!;
}

function candidate(input: {
  candidateId: string;
  cost: number;
  shortlistPasses: number;
  holdoutPasses: number;
  trials?: number;
}) {
  const trials = input.trials ?? 50;
  return {
    shortlist: splitVerdict({
      candidateId: input.candidateId,
      cost: input.cost,
      split: "shortlist",
      trials,
      passes: input.shortlistPasses,
    }),
    holdout: splitVerdict({
      candidateId: input.candidateId,
      cost: input.cost,
      split: "holdout",
      trials,
      passes: input.holdoutPasses,
    }),
  };
}

function clusteredCandidate(candidateId: string, cost: number) {
  const makeVerdict = (split: "shortlist" | "holdout") =>
    aggregate(
      aggregationFacts(17, (index) => ({
        candidateId,
        candidateCostUsd: cost,
        caseId: `${split}-case-${index}`,
        corpusSplit: split,
        trajectoryId: `${split}-trajectory-${index % 5}`,
      })),
      {
        gatePolicyVersion: "gate-1",
        qualityFloor: 0.8,
        availabilityFloor: 0.5,
      },
    )[0]!;

  return {
    shortlist: makeVerdict("shortlist"),
    holdout: makeVerdict("holdout"),
  };
}

function selectWithExistingHoldouts(
  candidates: Record<string, ReturnType<typeof candidate>>,
  releasePolicy = policy,
) {
  return selectWinner(candidates, releasePolicy);
}

describe("assignSplits", () => {
  it("assigns deterministic balanced halves independent of input order", () => {
    const caseIds = Array.from({ length: 11 }, (_, index) => `case-${index}`);
    const forward = assignSplits(caseIds, "seed-1");
    const reverse = assignSplits([...caseIds].reverse(), "seed-1");

    expect(reverse).toEqual(forward);
    expect(
      Object.values(forward).filter((split) => split === "shortlist"),
    ).toHaveLength(5);
    expect(
      Object.values(forward).filter((split) => split === "holdout"),
    ).toHaveLength(6);
    expect(assignSplits(caseIds, "seed-2")).not.toEqual(forward);
  });

  it("rejects duplicate case identifiers", () => {
    expect(() => assignSplits(["case-1", "case-1"], "seed")).toThrow(
      /duplicate/i,
    );
  });
});

describe("selectWinner", () => {
  it("does not fall back when the cheapest shortlist winner fails holdout", () => {
    const selection = selectWithExistingHoldouts({
      cheap: candidate({
        candidateId: "cheap",
        cost: 0.1,
        shortlistPasses: 50,
        holdoutPasses: 35,
      }),
      expensive: candidate({
        candidateId: "expensive",
        cost: 0.5,
        shortlistPasses: 50,
        holdoutPasses: 50,
      }),
    });

    expect(selection.shortlistedCandidateIds).toEqual(["cheap", "expensive"]);
    expect(selection.status).toBe("holdout_failed");
    if (
      selection.status === "no_shortlist_passer" ||
      selection.status === "confirmation_required"
    ) {
      throw new Error("expected the cheap candidate to reach holdout");
    }
    expect(selection.confirmedCandidateId).toBe("cheap");
    expect(selection.selectedCandidateId).toBeUndefined();
  });

  it("selects the cheapest passer and reports only a selection-adjusted estimate", () => {
    const selection = selectWithExistingHoldouts({
      cheap: candidate({
        candidateId: "cheap",
        cost: 0.1,
        shortlistPasses: 50,
        holdoutPasses: 50,
      }),
      expensive: candidate({
        candidateId: "expensive",
        cost: 0.5,
        shortlistPasses: 50,
        holdoutPasses: 50,
      }),
    });

    expect(selection).toMatchObject({
      status: "selected",
      confirmedCandidateId: "cheap",
      selectedCandidateId: "cheap",
      selectionAdjustedEstimate: {
        comparisons: 2,
        confidence: 0.95,
        method: "wilson",
      },
    });
    if (
      selection.status === "no_shortlist_passer" ||
      selection.status === "confirmation_required"
    ) {
      throw new Error("expected the cheap candidate to reach holdout");
    }
    expect(selection.selectionAdjustedEstimate).not.toHaveProperty("passes");
    expect(selection.selectionAdjustedEstimate).not.toHaveProperty("trials");
  });

  it("uses the total candidate count for multiplicity correction", () => {
    const multiplicityPolicy = new ReleaseGatePolicy({
      gatePolicyVersion: "gate-1",
      qualityFloor: 0.81,
      availabilityFloor: 0.8,
    });
    const selection = selectWithExistingHoldouts(
      {
        cheap: candidate({
          candidateId: "cheap",
          cost: 0.1,
          shortlistPasses: 17,
          holdoutPasses: 17,
          trials: 17,
        }),
        expensive: candidate({
          candidateId: "expensive",
          cost: 0.5,
          shortlistPasses: 17,
          holdoutPasses: 17,
          trials: 17,
        }),
      },
      multiplicityPolicy,
    );

    expect(wilson(17, 17).lower).toBeGreaterThan(0.81);
    if (
      selection.status === "no_shortlist_passer" ||
      selection.status === "confirmation_required"
    ) {
      throw new Error("expected the cheap candidate to reach holdout");
    }
    expect(selection.selectionAdjustedEstimate?.lower).toBeLessThan(0.81);
    expect(selection.status).toBe("holdout_failed");
  });

  it("multiplicity-corrects a clustered holdout estimate", () => {
    const multiplicityPolicy = new ReleaseGatePolicy({
      gatePolicyVersion: "gate-1",
      qualityFloor: 0.81,
      availabilityFloor: 0.8,
    });
    const clusteredCandidates = {
      cheap: clusteredCandidate("cheap", 0.1),
      expensive: clusteredCandidate("expensive", 0.5),
    };
    const winnerHoldout = clusteredCandidates.cheap.holdout;
    const planned = selectWinner(
      {
        cheap: { shortlist: clusteredCandidates.cheap.shortlist },
        expensive: { shortlist: clusteredCandidates.expensive.shortlist },
      },
      multiplicityPolicy,
    );
    if (planned.status !== "confirmation_required") {
      throw new Error("expected a confirmation plan");
    }
    expect(winnerHoldout.caseIds).not.toHaveLength(0);
    const selection = selectWinner(clusteredCandidates, multiplicityPolicy);

    expect(selection.status).toBe("holdout_failed");
    if (
      selection.status === "no_shortlist_passer" ||
      selection.status === "confirmation_required"
    ) {
      throw new Error("expected the cheap candidate to reach holdout");
    }
    expect(selection.selectionAdjustedEstimate).toMatchObject({
      comparisons: 2,
      method: "cluster_bootstrap",
    });
    expect(selection.selectionAdjustedEstimate.lower).toBeLessThan(0.81);
  });

  it("reports no estimate when no candidate clears the shortlist filter", () => {
    const selection = selectWinner(
      {
        weak: candidate({
          candidateId: "weak",
          cost: 0.1,
          shortlistPasses: 30,
          holdoutPasses: 50,
        }),
      },
      policy,
    );

    expect(selection).toEqual({
      status: "no_shortlist_passer",
      shortlistedCandidateIds: [],
      holdoutRequired: false,
    });
  });

  it("requests and consumes holdout evidence only for the cheapest shortlist passer", () => {
    const cheap = candidate({
      candidateId: "cheap",
      cost: 0.1,
      shortlistPasses: 50,
      holdoutPasses: 50,
    });
    const expensive = candidate({
      candidateId: "expensive",
      cost: 0.5,
      shortlistPasses: 50,
      holdoutPasses: 50,
    });
    const shortlistsOnly = {
      cheap: { shortlist: cheap.shortlist },
      expensive: { shortlist: expensive.shortlist },
    };

    const planned = selectWinner(shortlistsOnly, policy);
    expect(planned).toMatchObject({
      status: "confirmation_required",
      shortlistedCandidateIds: ["cheap", "expensive"],
      confirmedCandidateId: "cheap",
      holdoutRequired: true,
    });
    if (planned.status !== "confirmation_required") {
      throw new Error("expected a confirmation plan");
    }
    expect(
      selectWinner(
        {
          cheap,
          expensive: { shortlist: expensive.shortlist },
        },
        policy,
      ),
    ).toMatchObject({
      status: "selected",
      confirmedCandidateId: "cheap",
      holdoutRequired: false,
    });
  });

  it("does not select a holdout winner that fails a binding release gate", () => {
    const failingCoverage = candidate({
      candidateId: "candidate",
      cost: 0.1,
      shortlistPasses: 50,
      holdoutPasses: 50,
    });
    failingCoverage.holdout = aggregate(
      aggregationFacts(50, (index) => ({
        candidateId: "candidate",
        candidateCostUsd: 0.1,
        caseId: `holdout-case-${index}`,
        corpusSplit: "holdout",
        evidenceCovered: false,
      })),
      {
        gatePolicyVersion: "gate-1",
        qualityFloor: 0.8,
        availabilityFloor: 0.5,
      },
    )[0]!;

    expect(
      selectWithExistingHoldouts({ candidate: failingCoverage }).status,
    ).toBe("holdout_failed");
  });
});
