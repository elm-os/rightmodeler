import { describe, expect, it } from "vitest";

import {
  diagnoseFailure,
  diagnoseRemediationEvidence,
  type DiagnosisCaseFact,
  type DiagnosisSnapshot,
  type FailedFamilyFacts,
  type RemediationProposedChange,
} from "./diagnosis.js";

function caseFact(
  overrides: Partial<DiagnosisCaseFact> = {},
): DiagnosisCaseFact {
  return {
    caseId: "case-1",
    pipelineFamily: "structured-check",
    terminalVerdict: "pass",
    failureCode: null,
    evidenceRefs: ["candidate/case-1"],
    ...overrides,
  };
}

function familyFacts(
  overrides: Partial<FailedFamilyFacts> = {},
): FailedFamilyFacts {
  return {
    gates: [],
    cases: [caseFact()],
    replayObserved: false,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<DiagnosisSnapshot> = {},
): DiagnosisSnapshot {
  return {
    ...familyFacts(),
    snapshotId: `sha256:${"a".repeat(64)}`,
    confidenceStatus: "pass",
    ...overrides,
  };
}

function proposedChange(
  overrides: {
    readonly content?: string;
    readonly affected_files?: readonly string[];
    readonly validation_commands?: RemediationProposedChange["validation_commands"];
  } = {},
): RemediationProposedChange {
  return {
    type: "configuration",
    content: "require the structured evaluator status field",
    affected_files: ["src/evaluator.ts"],
    validation_commands: [
      {
        name: "tests",
        command: ["pnpm", "test"],
        timeout_seconds: 60,
      },
    ],
    ...overrides,
  };
}

describe("diagnoseFailure", () => {
  it("maps test_diagnosis_classifies_replay_budget_failure", () => {
    expect(
      diagnoseFailure(
        familyFacts({
          replayObserved: true,
          cases: [
            caseFact({
              terminalVerdict: "fail",
              failureCode: "invalid_json",
            }),
          ],
        }),
      ),
    ).toEqual({
      issueClass: "replay",
      nextAction: "fix-replay",
      triggerCaseIds: ["case-1"],
    });
  });

  it("maps test_diagnosis_proves_actionable_evaluator_fix classification", () => {
    expect(
      diagnoseFailure(
        familyFacts({
          gates: [
            { id: "quality", status: "fail" },
            { id: "standard-benchmark", status: "fail" },
          ],
          cases: [
            caseFact({
              terminalVerdict: "fail",
              failureCode: "invalid_json",
            }),
          ],
        }),
      ),
    ).toEqual({
      issueClass: "evaluator",
      nextAction: "fix-evaluator",
      triggerCaseIds: ["case-1"],
    });
  });

  it("maps test_diagnosis_keeps_missing_evidence_as_review classification", () => {
    expect(
      diagnoseFailure(
        familyFacts({
          cases: [
            caseFact({
              terminalVerdict: "abstain",
              evidenceRefs: [],
            }),
          ],
        }),
      ),
    ).toEqual({
      issueClass: "insufficient-evidence",
      nextAction: "collect-evidence",
      triggerCaseIds: ["case-1"],
    });
  });

  it("maps test_diagnosis_keeps_indeterminate_gates_in_remediation classification", () => {
    expect(
      diagnoseFailure(
        familyFacts({
          gates: [{ id: "quality", status: "indeterminate" }],
        }),
      ),
    ).toEqual({
      issueClass: "insufficient-evidence",
      nextAction: "collect-evidence",
      triggerCaseIds: [],
    });
  });

  it("maps the classifier portion of test_diagnose_command_writes_evidence_artifact", () => {
    expect(
      diagnoseFailure(
        familyFacts({
          cases: [
            caseFact({
              terminalVerdict: "fail",
              failureCode: "invalid_json",
            }),
          ],
        }),
      ),
    ).toEqual({
      issueClass: "evaluator",
      nextAction: "fix-evaluator",
      triggerCaseIds: ["case-1"],
    });
  });

  it.each([
    {
      name: "ingestion",
      input: familyFacts({
        cases: [
          caseFact({
            terminalVerdict: "fail",
            failureCode: "ingestion_decode_failed",
          }),
        ],
      }),
      expected: "ingestion",
      expectedAction: "fix-ingestion",
    },
    {
      name: "replay-budget gate",
      input: familyFacts({
        gates: [{ id: "replay-budget", status: "pass" }],
      }),
      expected: "replay",
      expectedAction: "fix-replay",
    },
    {
      name: "replay failure code",
      input: familyFacts({
        cases: [caseFact({ failureCode: "replay_timeout" })],
      }),
      expected: "replay",
      expectedAction: "fix-replay",
    },
    {
      name: "repo-validation gate",
      input: familyFacts({
        gates: [{ id: "repo-ci", status: "pass" }],
      }),
      expected: "repo-validation",
      expectedAction: "fix-repo-validation",
    },
    {
      name: "candidate selection",
      input: familyFacts({
        gates: [{ id: "recommendation-precision", status: "fail" }],
        cases: [caseFact({ terminalVerdict: "fail" })],
      }),
      expected: "candidate-selection",
      expectedAction: "adjust-selection",
    },
    {
      name: "fallback evaluator",
      input: familyFacts({
        cases: [
          caseFact({
            terminalVerdict: "fail",
            failureCode: "unknown_failure",
          }),
        ],
      }),
      expected: "evaluator",
      expectedAction: "fix-evaluator",
    },
    {
      name: "default insufficient evidence",
      input: familyFacts(),
      expected: "insufficient-evidence",
      expectedAction: "collect-evidence",
    },
  ])(
    "classifies the $name branch and maps its action",
    ({ input, expected, expectedAction }) => {
      expect(diagnoseFailure(input)).toMatchObject({
        issueClass: expected,
        nextAction: expectedAction,
      });
    },
  );

  it.each([
    "invalid_json",
    "schema_mismatch",
    "missing_required_fields",
    "frozen_human_verdict_fail",
    "reference_disagreement",
    "trajectory_mismatch",
  ])("recognizes evaluator failure code %s", (failureCode) => {
    expect(
      diagnoseFailure(
        familyFacts({
          cases: [caseFact({ terminalVerdict: "fail", failureCode })],
        }),
      ).issueClass,
    ).toBe("evaluator");
  });

  it.each([
    {
      name: "ingestion before replay",
      input: familyFacts({
        replayObserved: true,
        cases: [caseFact({ failureCode: "ingestion_parse_failed" })],
      }),
      expected: "ingestion",
    },
    {
      name: "replay before repository validation",
      input: familyFacts({
        replayObserved: true,
        gates: [{ id: "repo-ci", status: "fail" }],
      }),
      expected: "replay",
    },
    {
      name: "repository validation before evaluator",
      input: familyFacts({
        cases: [
          caseFact({
            pipelineFamily: "repo-fix",
            terminalVerdict: "fail",
            failureCode: "invalid_json",
          }),
        ],
      }),
      expected: "repo-validation",
    },
    {
      name: "evaluator before insufficient evidence",
      input: familyFacts({
        cases: [
          caseFact({
            terminalVerdict: "fail",
            failureCode: "invalid_json",
            evidenceRefs: [],
          }),
        ],
      }),
      expected: "evaluator",
    },
    {
      name: "insufficient evidence before candidate selection",
      input: familyFacts({
        gates: [{ id: "safe-opportunity-recall", status: "fail" }],
        cases: [
          caseFact({
            terminalVerdict: "fail",
            failureCode: "missing_evidence",
          }),
        ],
      }),
      expected: "insufficient-evidence",
    },
    {
      name: "candidate selection before evaluator fallback",
      input: familyFacts({
        gates: [{ id: "zero-unsafe-substitutions", status: "fail" }],
        cases: [caseFact({ terminalVerdict: "fail" })],
      }),
      expected: "candidate-selection",
    },
  ])("preserves $name", ({ input, expected }) => {
    expect(diagnoseFailure(input).issueClass).toBe(expected);
  });

  it.each([
    {
      name: "ingestion codes",
      input: familyFacts({
        cases: [
          caseFact({ caseId: "z", failureCode: "ingestion_parse_failed" }),
          caseFact({ caseId: "a", failureCode: "ingestion_decode_failed" }),
          caseFact({ caseId: "ignored", terminalVerdict: "fail" }),
          caseFact({ caseId: "a", failureCode: "ingestion_decode_failed" }),
        ],
      }),
      expected: ["a", "z"],
    },
    {
      name: "failed or replay-coded cases",
      input: familyFacts({
        replayObserved: true,
        cases: [
          caseFact({ caseId: "failed", terminalVerdict: "fail" }),
          caseFact({ caseId: "coded", failureCode: "replay_timeout" }),
          caseFact({ caseId: "ignored" }),
        ],
      }),
      expected: ["coded", "failed"],
    },
    {
      name: "every repo-fix case",
      input: familyFacts({
        gates: [{ id: "repo-ci", status: "pass" }],
        cases: [
          caseFact({ caseId: "pass", pipelineFamily: "repo-fix" }),
          caseFact({
            caseId: "fail",
            pipelineFamily: "repo-fix",
            terminalVerdict: "fail",
          }),
          caseFact({ caseId: "ignored" }),
        ],
      }),
      expected: ["fail", "pass"],
    },
    {
      name: "exact evaluator codes",
      input: familyFacts({
        cases: [
          caseFact({
            caseId: "exact",
            terminalVerdict: "fail",
            failureCode: "trajectory_mismatch",
          }),
          caseFact({
            caseId: "fallback",
            terminalVerdict: "fail",
            failureCode: "unknown_failure",
          }),
        ],
      }),
      expected: ["exact"],
    },
    {
      name: "abstaining or evidence-free cases",
      input: familyFacts({
        cases: [
          caseFact({ caseId: "abstain", terminalVerdict: "abstain" }),
          caseFact({ caseId: "empty", evidenceRefs: [] }),
          caseFact({ caseId: "ignored" }),
        ],
      }),
      expected: ["abstain", "empty"],
    },
    {
      name: "failed candidate-selection cases",
      input: familyFacts({
        gates: [{ id: "recommendation-precision", status: "fail" }],
        cases: [
          caseFact({ caseId: "failed", terminalVerdict: "fail" }),
          caseFact({ caseId: "ignored" }),
        ],
      }),
      expected: ["failed"],
    },
  ])("selects and sorts trigger IDs for $name", ({ input, expected }) => {
    expect(diagnoseFailure(input).triggerCaseIds).toEqual(expected);
  });

  it("allows evaluator fallback to have no exact-code trigger", () => {
    expect(
      diagnoseFailure(
        familyFacts({
          cases: [
            caseFact({
              terminalVerdict: "fail",
              failureCode: "unknown_failure",
            }),
          ],
        }),
      ),
    ).toEqual({
      issueClass: "evaluator",
      nextAction: "fix-evaluator",
      triggerCaseIds: [],
    });
  });
});

describe("diagnoseRemediationEvidence", () => {
  it("keeps a replay failure without a proposed change in review", () => {
    const evidence = diagnoseRemediationEvidence({
      baseline: snapshot({
        replayObserved: true,
        cases: [
          caseFact({
            terminalVerdict: "fail",
            failureCode: "invalid_json",
          }),
        ],
      }),
    });

    expect(evidence).toMatchObject({
      version: "1",
      evidence_id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      baseline_snapshot_id: `sha256:${"a".repeat(64)}`,
      issue_class: "replay",
      next_action: "fix-replay",
      status: "review",
      trigger_case_ids: ["case-1"],
      proposed_change: {
        type: "none",
        content: null,
        affected_files: [],
        validation_commands: [],
      },
      proof: {
        target_gate_ids: ["standard-benchmark"],
        post_fix_snapshot_id: null,
        holdout_snapshot_id: null,
        target_improved: false,
        validation: {
          status: "not_run",
          commands: [],
          evidence_refs: [],
        },
      },
    });
  });

  it("proves an actionable evaluator fix without regressions", () => {
    const baseline = snapshot({
      gates: [
        { id: "quality", status: "fail" },
        { id: "standard-benchmark", status: "fail" },
        { id: "speed", status: "pass" },
      ],
      cases: [
        caseFact({ terminalVerdict: "fail", failureCode: "invalid_json" }),
      ],
    });
    const postFix = snapshot({
      snapshotId: `sha256:${"b".repeat(64)}`,
      gates: [
        { id: "quality", status: "pass" },
        { id: "standard-benchmark", status: "pass" },
        { id: "speed", status: "pass" },
      ],
    });
    const holdout = snapshot({
      snapshotId: `sha256:${"c".repeat(64)}`,
      gates: [{ id: "standard-benchmark", status: "pass" }],
    });

    const evidence = diagnoseRemediationEvidence({
      baseline,
      proposal: proposedChange({
        affected_files: ["src/evaluator.ts", "src/evaluator.ts"],
      }),
      postFix,
      holdout,
      validation: {
        status: "passed",
        commands: ["tests"],
        evidence_refs: ["ci/1"],
      },
    });

    expect(evidence.status).toBe("proven");
    expect(evidence.proof.target_improved).toBe(true);
    expect(evidence.proof.regressed_gate_ids).toEqual([]);
    expect(evidence.proof).toMatchObject({
      target_gate_ids: ["quality", "standard-benchmark"],
      post_fix_snapshot_id: postFix.snapshotId,
      holdout_snapshot_id: holdout.snapshotId,
      validation: {
        status: "passed",
        commands: ["tests"],
        evidence_refs: ["ci/1"],
      },
    });
    expect(evidence.proposed_change.affected_files).toEqual([
      "src/evaluator.ts",
    ]);
    expect(evidence.residual_risks).toEqual([]);
  });

  it("keeps missing evidence in review with named residual risks", () => {
    const evidence = diagnoseRemediationEvidence({
      baseline: snapshot({
        confidenceStatus: "review",
        cases: [caseFact({ terminalVerdict: "abstain", evidenceRefs: [] })],
      }),
      proposal: proposedChange(),
    });

    expect(evidence.issue_class).toBe("insufficient-evidence");
    expect(evidence.next_action).toBe("collect-evidence");
    expect(evidence.status).toBe("review");
    expect(evidence.residual_risks).not.toEqual([]);
    expect(evidence.residual_risks).toContain(
      "The available evidence does not isolate an actionable cause.",
    );
    expect(evidence.proposed_change.type).toBe("none");
  });

  it("maps indeterminate baseline gate statuses to review", () => {
    const evidence = diagnoseRemediationEvidence({
      baseline: snapshot({
        gates: [{ id: "quality", status: "indeterminate" }],
      }),
    });

    expect(evidence.proof.target_gate_ids).toContain("quality");
    expect(evidence.proof.baseline_gate_statuses.quality).toBe("review");
  });

  it("leaves an actionable change in draft until post-fix proof arrives", () => {
    const evidence = diagnoseRemediationEvidence({
      baseline: snapshot({
        gates: [{ id: "quality", status: "fail" }],
        cases: [
          caseFact({ terminalVerdict: "fail", failureCode: "invalid_json" }),
        ],
      }),
      proposal: proposedChange(),
    });

    expect(evidence.status).toBe("draft");
    expect(evidence.residual_risks).toContain(
      "Post-fix benchmark proof has not been supplied.",
    );
  });

  it("keeps post-fix regressions and incomplete delegated validation in review", () => {
    const evidence = diagnoseRemediationEvidence({
      baseline: snapshot({
        confidenceStatus: "unavailable",
        gates: [
          { id: "quality", status: "fail" },
          { id: "speed", status: "pass" },
        ],
        cases: [
          caseFact({ terminalVerdict: "fail", failureCode: "invalid_json" }),
        ],
      }),
      proposal: proposedChange(),
      postFix: snapshot({
        snapshotId: `sha256:${"b".repeat(64)}`,
        gates: [
          { id: "quality", status: "pass" },
          { id: "speed", status: "fail" },
        ],
      }),
      holdout: snapshot({
        snapshotId: `sha256:${"c".repeat(64)}`,
        gates: [{ id: "standard-benchmark", status: "review" }],
      }),
      validation: {
        status: "review",
        commands: ["target CI"],
        evidence_refs: ["github-check-run:1"],
      },
    });

    expect(evidence.status).toBe("review");
    expect(evidence.proof.regressed_gate_ids).toEqual(["speed"]);
    expect(evidence.residual_risks).toEqual(
      expect.arrayContaining([
        "The baseline confidence gate is not passing.",
        "The proposed fix regressed gates: speed.",
        "Post-fix validation is not recorded as passed.",
        "The supplied holdout snapshot does not pass its standard benchmark gate.",
      ]),
    );
  });
});

describe("proposed mutation-closing tests", () => {
  it.each([
    "invalid_json",
    "schema_mismatch",
    "missing_required_fields",
    "frozen_human_verdict_fail",
    "reference_disagreement",
    "trajectory_mismatch",
  ])("classifies %s without the terminal-fail fallback", (failureCode) => {
    expect(
      diagnoseFailure(
        familyFacts({
          cases: [caseFact({ terminalVerdict: "pass", failureCode })],
        }),
      ),
    ).toEqual({
      issueClass: "evaluator",
      nextAction: "fix-evaluator",
      triggerCaseIds: ["case-1"],
    });
  });

  it("prefers an evaluator code over an insufficient-evidence code", () => {
    expect(
      diagnoseFailure(
        familyFacts({
          cases: [
            caseFact({ caseId: "a", failureCode: "invalid_json" }),
            caseFact({ caseId: "b", failureCode: "missing_evidence" }),
          ],
        }),
      ).issueClass,
    ).toBe("evaluator");
  });

  it("classifies missing_candidate_result as insufficient evidence", () => {
    expect(
      diagnoseFailure(
        familyFacts({
          gates: [{ id: "recommendation-precision", status: "fail" }],
          cases: [
            caseFact({
              terminalVerdict: "fail",
              failureCode: "missing_candidate_result",
            }),
          ],
        }),
      ).issueClass,
    ).toBe("insufficient-evidence");
  });

  it("prefers an ingestion code over a replay code", () => {
    expect(
      diagnoseFailure(
        familyFacts({
          cases: [
            caseFact({ caseId: "a", failureCode: "ingestion_parse_failed" }),
            caseFact({ caseId: "b", failureCode: "replay_timeout" }),
          ],
        }),
      ).issueClass,
    ).toBe("ingestion");
  });

  it("prefers a replay code over repo, evaluator, and selection classes", () => {
    expect(
      diagnoseFailure(
        familyFacts({
          gates: [
            { id: "repo-ci", status: "fail" },
            { id: "recommendation-precision", status: "fail" },
          ],
          cases: [
            caseFact({
              caseId: "a",
              pipelineFamily: "repo-fix",
              terminalVerdict: "fail",
              failureCode: "replay_timeout",
            }),
            caseFact({
              caseId: "b",
              terminalVerdict: "fail",
              failureCode: "invalid_json",
            }),
          ],
        }),
      ).issueClass,
    ).toBe("replay");
  });

  it("ignores a passing repo-fix case when no repo gate is present", () => {
    expect(
      diagnoseFailure(
        familyFacts({
          cases: [
            caseFact({ caseId: "a", pipelineFamily: "repo-fix" }),
            caseFact({
              caseId: "b",
              terminalVerdict: "fail",
              failureCode: "invalid_json",
            }),
          ],
        }),
      ).issueClass,
    ).toBe("evaluator");
  });

  it.each([
    "zero-unsafe-substitutions",
    "recommendation-precision",
    "safe-opportunity-recall",
  ])("gates candidate selection on a failing %s gate", (id) => {
    const cases = [caseFact({ terminalVerdict: "fail" })];
    expect(
      diagnoseFailure(familyFacts({ gates: [{ id, status: "fail" }], cases }))
        .issueClass,
    ).toBe("candidate-selection");
    expect(
      diagnoseFailure(familyFacts({ gates: [{ id, status: "pass" }], cases }))
        .issueClass,
    ).toBe("evaluator");
  });
});
