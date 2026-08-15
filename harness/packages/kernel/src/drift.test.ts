import { describe, expect, it } from "vitest";

import {
  approveDrift,
  assertCorpusManifestIntegrity,
  detectDrift,
  publishDrift,
  type CorpusCaseDefinition,
  type CorpusDefinition,
  type CorpusDriftProposal,
  type CorpusManifest,
  type HistoricalRun,
  type HistoricalRunBundle,
} from "./drift.js";

const parentDigest = `sha256:${"a".repeat(64)}`;

function corpusCase(
  case_id: string,
  source_run_id: string,
  split: "working" | "holdout" = "working",
  overrides: Partial<CorpusCaseDefinition> = {},
): CorpusCaseDefinition {
  return {
    case_id,
    source_run_id,
    pipeline_family: "structured-check",
    workload_label: "drift-fixture",
    split,
    risk: "normal",
    required_evidence: "deterministic",
    checks: { required_fields: ["status"] },
    ...overrides,
  };
}

function run(
  id: string,
  prompt: string,
  overrides: Partial<HistoricalRun> = {},
): HistoricalRun {
  return {
    id,
    prompt,
    model: "gpt-4o",
    success: true,
    cost_usd: 0.1,
    duration_ms: 100,
    ...overrides,
  };
}

function bundle(
  runs: readonly HistoricalRun[],
  bundle_id: string,
): HistoricalRunBundle {
  return { version: "1", bundle_id, runs };
}

function fixtures(): {
  parentManifest: CorpusManifest;
  parentBundle: HistoricalRunBundle;
  candidateBundle: HistoricalRunBundle;
  candidateDefinition: CorpusDefinition;
} {
  const parentCases = [
    corpusCase("case-1", "run-1"),
    corpusCase("case-2", "run-2", "holdout"),
  ];
  return {
    parentManifest: {
      version: "1",
      corpus_id: "drift-fixture",
      corpus_version: "1",
      parent_version: null,
      source_bundle_id: "parent-bundle",
      content_digest: parentDigest,
      cases: parentCases,
    },
    parentBundle: bundle(
      [run("run-1", "Original prompt"), run("run-2", "Stable prompt")],
      "parent-bundle",
    ),
    candidateBundle: bundle(
      [
        run("run-1", "Changed prompt", {
          model: "gpt-4o-mini",
          cost_usd: 0.3,
          duration_ms: 150,
        }),
        run("run-2", "Stable prompt"),
        run("run-3", "New holdout prompt"),
      ],
      "candidate-bundle",
    ),
    candidateDefinition: {
      version: "2",
      corpus_id: "drift-fixture",
      parent_version: parentDigest,
      cases: [
        corpusCase("case-1", "run-1"),
        corpusCase("case-2", "run-2", "working"),
        corpusCase("case-3", "run-3", "holdout"),
      ],
    },
  };
}

function proposalForRuns(
  parentRun: HistoricalRun,
  candidateRun: HistoricalRun,
): CorpusDriftProposal {
  const parentCase = corpusCase("case-1", parentRun.id);
  return detectDrift(
    {
      version: "1",
      corpus_id: "drift-fixture",
      corpus_version: "1",
      parent_version: null,
      source_bundle_id: "parent-bundle",
      content_digest: parentDigest,
      cases: [parentCase],
    },
    bundle([parentRun], "parent-bundle"),
    bundle([candidateRun], "candidate-bundle"),
    {
      version: "2",
      corpus_id: "drift-fixture",
      parent_version: parentDigest,
      cases: [corpusCase("case-1", candidateRun.id)],
    },
  );
}

describe("detectDrift", () => {
  it("maps test_detect_drift_emits_reviewable_signals_and_holdout_replacement", () => {
    const {
      parentManifest,
      parentBundle,
      candidateBundle,
      candidateDefinition,
    } = fixtures();

    const proposal = detectDrift(
      parentManifest,
      parentBundle,
      candidateBundle,
      candidateDefinition,
    );

    expect(Object.keys(proposal).sort()).toEqual([
      "approval",
      "candidate_definition_digest",
      "exposed_holdout_case_ids",
      "parent_corpus_version_id",
      "proposal_id",
      "proposed_changes",
      "replacement_holdout_case_ids",
      "signals",
      "status",
      "version",
    ]);
    expect(proposal).toMatchObject({
      version: "1",
      parent_corpus_version_id: parentDigest,
      status: "proposed",
      approval: null,
      signals: ["acceptance", "cost", "input", "latency", "model"],
      exposed_holdout_case_ids: ["case-2"],
      replacement_holdout_case_ids: ["case-3"],
    });
    expect(proposal.proposal_id).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(proposal.candidate_definition_digest).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(proposal.proposed_changes).toEqual(
      expect.arrayContaining([
        {
          action: "add",
          case_id: "case-3",
          signal: "none",
          detail: "case is new in the candidate corpus",
        },
        {
          action: "red-team",
          case_id: "case-2",
          signal: "acceptance",
          detail: "holdout case was exposed and needs replacement coverage",
        },
      ]),
    );
  });

  it.each([
    {
      signal: "input",
      parent: run("run-1", "old"),
      candidate: run("run-1", "new"),
    },
    {
      signal: "tool",
      parent: run("run-1", "same", { tool_calls: [{ name: "old" }] }),
      candidate: run("run-1", "same", { tool_calls: [{ name: "new" }] }),
    },
    {
      signal: "evaluator",
      parent: run("run-1", "same", { evaluator: "judge-a" }),
      candidate: run("run-1", "same", { evaluator: "judge-b" }),
    },
    {
      signal: "evaluator",
      parent: run("run-1", "same", { evaluator_version: "1" }),
      candidate: run("run-1", "same", { evaluator_version: "2" }),
    },
    {
      signal: "acceptance",
      parent: run("run-1", "same", { success: true }),
      candidate: run("run-1", "same", { success: false }),
    },
    {
      signal: "model",
      parent: run("run-1", "same", { model: "old" }),
      candidate: run("run-1", "same", { model: "new" }),
    },
    {
      signal: "cost",
      parent: run("run-1", "same", { cost_usd: 100 }),
      candidate: run("run-1", "same", { cost_usd: 121 }),
    },
    {
      signal: "latency",
      parent: run("run-1", "same", { duration_ms: 100 }),
      candidate: run("run-1", "same", { duration_ms: 121 }),
    },
    {
      signal: "retry",
      parent: run("run-1", "same", { retry_count: 0 }),
      candidate: run("run-1", "same", { retry_count: 1 }),
    },
    {
      signal: "trajectory",
      parent: run("run-1", "same", { trajectory: ["first"] }),
      candidate: run("run-1", "same", { trajectory: ["second"] }),
    },
  ])("detects $signal run drift", ({ signal, parent, candidate }) => {
    expect(proposalForRuns(parent, candidate).signals).toEqual([signal]);
  });

  it("uses structural equality and the Python null and threshold rules", () => {
    const parent = run("run-1", "same", {
      tool_calls: [{ name: "lookup", arguments: { id: 1 } }],
      cost_usd: 100,
      duration_ms: null,
      latency_ms: 100,
    });
    const candidate = run("run-1", "same", {
      tool_calls: [{ name: "lookup", arguments: { id: 1 } }],
      cost_usd: 120,
      duration_ms: null,
      latency_ms: 150,
      retry_count: 1,
    });

    const proposal = proposalForRuns(parent, candidate);

    expect(proposal.signals).toEqual(["none"]);
    expect(proposal.proposed_changes).toEqual([
      {
        action: "no-change",
        case_id: "corpus",
        signal: "none",
        detail: "no material drift detected",
      },
    ]);
    expect(
      proposalForRuns(
        run("run-1", "same", { cost_usd: 0, tool_calls: undefined }),
        run("run-1", "same", { cost_usd: 10, tool_calls: ["new"] }),
      ).signals,
    ).toEqual(["none"]);
    expect(
      proposalForRuns(
        run("run-1", "same", { duration_ms: undefined, latency_ms: 100 }),
        run("run-1", "same", { duration_ms: undefined, latency_ms: 121 }),
      ).signals,
    ).toEqual(["latency"]);
  });

  it.each([
    { field: "pipeline_family", value: "repo-fix" },
    { field: "workload_label", value: "changed" },
    { field: "risk", value: "high", action: "red-team" },
    { field: "required_evidence", value: "reference" },
    { field: "checks", value: { exact: true } },
    {
      field: "labels",
      value: { recommendation: "safe", required_abstention: false },
    },
  ] as const)(
    "maps a changed $field case definition to evaluator drift",
    ({ field, value, action }) => {
      const baseCase = corpusCase("case-1", "run-1");
      const candidateCase = { ...baseCase, [field]: value };
      const proposal = detectDrift(
        {
          version: "1",
          corpus_id: "drift-fixture",
          corpus_version: "1",
          parent_version: null,
          source_bundle_id: "parent-bundle",
          content_digest: parentDigest,
          cases: [baseCase],
        },
        bundle([run("run-1", "same")], "parent-bundle"),
        bundle([run("run-1", "same")], "candidate-bundle"),
        {
          version: "2",
          corpus_id: "drift-fixture",
          parent_version: parentDigest,
          cases: [candidateCase],
        },
      );

      expect(proposal.signals).toEqual(["evaluator"]);
      expect(proposal.proposed_changes).toEqual([
        {
          action: action ?? "relabel",
          case_id: "case-1",
          signal: "evaluator",
          detail: "reviewed case definition changed",
        },
      ]);
    },
  );

  it("sorts additions and retirements without promoting them to top-level signals", () => {
    const proposal = detectDrift(
      {
        version: "1",
        corpus_id: "drift-fixture",
        corpus_version: "1",
        parent_version: null,
        source_bundle_id: "parent-bundle",
        content_digest: parentDigest,
        cases: [
          corpusCase("retire-b", "run-b"),
          corpusCase("retire-a", "run-a"),
        ],
      },
      bundle([], "parent-bundle"),
      bundle([], "candidate-bundle"),
      {
        version: "2",
        corpus_id: "drift-fixture",
        parent_version: parentDigest,
        cases: [corpusCase("add-b", "run-d"), corpusCase("add-a", "run-c")],
      },
    );

    expect(proposal.signals).toEqual(["none"]);
    expect(
      proposal.proposed_changes.map(({ action, case_id }) => [action, case_id]),
    ).toEqual([
      ["add", "add-a"],
      ["add", "add-b"],
      ["retire", "retire-a"],
      ["retire", "retire-b"],
    ]);
  });

  it("leaves an unchanged holdout out of exposure and replacement", () => {
    const cases = [
      corpusCase("case-1", "run-1"),
      corpusCase("case-2", "run-2", "holdout"),
    ];
    const proposal = detectDrift(
      {
        version: "1",
        corpus_id: "drift-fixture",
        corpus_version: "1",
        parent_version: null,
        source_bundle_id: "parent-bundle",
        content_digest: parentDigest,
        cases,
      },
      bundle([run("run-1", "same"), run("run-2", "same")], "parent-bundle"),
      bundle([run("run-1", "same"), run("run-2", "same")], "candidate-bundle"),
      {
        version: "2",
        corpus_id: "drift-fixture",
        parent_version: parentDigest,
        cases,
      },
    );

    expect(proposal.exposed_holdout_case_ids).toEqual([]);
    expect(proposal.replacement_holdout_case_ids).toEqual([]);
    expect(proposal.signals).toEqual(["none"]);
  });

  it("reports every exposed holdout, sorted, and flags the first", () => {
    const parentCases = [
      corpusCase("case-z", "run-1", "holdout"),
      corpusCase("case-a", "run-2", "holdout"),
    ];
    const proposal = detectDrift(
      {
        version: "1",
        corpus_id: "drift-fixture",
        corpus_version: "1",
        parent_version: null,
        source_bundle_id: "parent-bundle",
        content_digest: parentDigest,
        cases: parentCases,
      },
      bundle([run("run-1", "same"), run("run-2", "same")], "parent-bundle"),
      bundle([run("run-1", "same"), run("run-2", "same")], "candidate-bundle"),
      {
        version: "2",
        corpus_id: "drift-fixture",
        parent_version: parentDigest,
        cases: [
          corpusCase("case-z", "run-1"),
          corpusCase("case-a", "run-2"),
          corpusCase("case-r1", "run-3", "holdout"),
        ],
      },
    );

    expect(proposal.exposed_holdout_case_ids).toEqual(["case-a", "case-z"]);
    expect(proposal.replacement_holdout_case_ids).toEqual(["case-r1"]);
    expect(
      proposal.proposed_changes.filter(({ signal }) => signal === "acceptance"),
    ).toEqual([
      {
        action: "red-team",
        case_id: "case-a",
        signal: "acceptance",
        detail: "holdout case was exposed and needs replacement coverage",
      },
    ]);
  });

  it("dedupes repeated signals across cases", () => {
    const parentCases = [
      corpusCase("case-1", "run-1"),
      corpusCase("case-2", "run-2"),
    ];
    const proposal = detectDrift(
      {
        version: "1",
        corpus_id: "drift-fixture",
        corpus_version: "1",
        parent_version: null,
        source_bundle_id: "parent-bundle",
        content_digest: parentDigest,
        cases: parentCases,
      },
      bundle([run("run-1", "old"), run("run-2", "old")], "parent-bundle"),
      bundle([run("run-1", "new"), run("run-2", "new")], "candidate-bundle"),
      {
        version: "2",
        corpus_id: "drift-fixture",
        parent_version: parentDigest,
        cases: parentCases,
      },
    );

    expect(proposal.signals).toEqual(["input"]);
  });

  it("ignores a run field that is null on one side only", () => {
    expect(
      proposalForRuns(
        run("run-1", "same", { success: null }),
        run("run-1", "same", { success: false }),
      ).signals,
    ).toEqual(["none"]);
  });
});

describe("approveDrift", () => {
  it("checks proposal integrity and only approves proposed drift", () => {
    const fixture = fixtures();
    const proposal = detectDrift(
      fixture.parentManifest,
      fixture.parentBundle,
      fixture.candidateBundle,
      fixture.candidateDefinition,
    );
    const approved = approveDrift(
      proposal,
      "tester",
      "replace exposed holdout",
      "2026-07-13T12:00:00+00:00",
    );

    expect(approved).toMatchObject({
      proposal_id: proposal.proposal_id,
      status: "approved",
      approval: {
        actor: "tester",
        timestamp: "2026-07-13T12:00:00+00:00",
        reason: "replace exposed holdout",
      },
    });
    expect(() => approveDrift(approved, "other")).toThrow(
      "only proposed drift may be approved",
    );
    expect(() =>
      approveDrift({ ...proposal, signals: ["tool"] }, "tester"),
    ).toThrow("drift proposal digest does not match its contents");
  });
});

describe("publishDrift", () => {
  it("maps test_approved_drift_publishes_new_immutable_parented_version", () => {
    const fixture = fixtures();
    const approved = approveDrift(
      detectDrift(
        fixture.parentManifest,
        fixture.parentBundle,
        fixture.candidateBundle,
        fixture.candidateDefinition,
      ),
      "tester",
      "replace exposed holdout",
      "2026-07-13T12:00:00+00:00",
    );

    const published = publishDrift(
      fixture.parentManifest,
      fixture.candidateBundle,
      fixture.candidateDefinition,
      approved,
    );

    expect(approved.status).toBe("approved");
    expect(published.proposal).toMatchObject({
      proposal_id: approved.proposal_id,
      status: "published",
      approval: approved.approval,
    });
    expect(published.manifest.parent_version).toBe(parentDigest);
    expect(published.manifest.content_digest).not.toBe(parentDigest);
    expect(published.benchmark_cases.corpus_version_id).toBe(
      published.manifest.content_digest,
    );
    expect(
      published.benchmark_cases.cases.map(({ case_id }) => case_id),
    ).toEqual(["case-1", "case-2", "case-3"]);
  });

  it("maps test_publish_refuses_exposed_holdout_without_replacement", () => {
    const fixture = fixtures();
    const candidateDefinition = {
      ...fixture.candidateDefinition,
      cases: fixture.candidateDefinition.cases.slice(0, -1),
    };
    const approved = approveDrift(
      detectDrift(
        fixture.parentManifest,
        fixture.parentBundle,
        fixture.candidateBundle,
        candidateDefinition,
      ),
      "tester",
    );

    expect(() =>
      publishDrift(
        fixture.parentManifest,
        fixture.candidateBundle,
        candidateDefinition,
        approved,
      ),
    ).toThrow("every exposed holdout requires a replacement holdout case");
  });

  it("maps test_publish_requires_approved_proposal", () => {
    const fixture = fixtures();
    const proposal = detectDrift(
      fixture.parentManifest,
      fixture.parentBundle,
      fixture.candidateBundle,
      fixture.candidateDefinition,
    );

    expect(() =>
      publishDrift(
        fixture.parentManifest,
        fixture.candidateBundle,
        fixture.candidateDefinition,
        proposal,
      ),
    ).toThrow("corpus publication requires an approved drift proposal");
    expect(() =>
      publishDrift(
        fixture.parentManifest,
        fixture.candidateBundle,
        fixture.candidateDefinition,
        {
          ...proposal,
          status: "approved",
          approval: null,
        } as unknown as CorpusDriftProposal,
      ),
    ).toThrow("corpus publication requires an approved drift proposal");
  });

  it("refuses stale, changed, and tampered publication inputs", () => {
    const fixture = fixtures();
    const approved = approveDrift(
      detectDrift(
        fixture.parentManifest,
        fixture.parentBundle,
        fixture.candidateBundle,
        fixture.candidateDefinition,
      ),
      "tester",
    );

    expect(() =>
      publishDrift(
        {
          ...fixture.parentManifest,
          content_digest: `sha256:${"b".repeat(64)}`,
        },
        fixture.candidateBundle,
        fixture.candidateDefinition,
        approved,
      ),
    ).toThrow("drift proposal parent does not match the current corpus");
    expect(() =>
      publishDrift(
        fixture.parentManifest,
        fixture.candidateBundle,
        { ...fixture.candidateDefinition, version: "changed" },
        approved,
      ),
    ).toThrow("candidate definition does not match drift proposal");
    expect(() =>
      publishDrift(
        fixture.parentManifest,
        fixture.candidateBundle,
        fixture.candidateDefinition,
        {
          ...approved,
          proposed_changes: approved.proposed_changes.map((change, index) =>
            index === 0 ? { ...change, detail: "tampered" } : change,
          ),
        },
      ),
    ).toThrow("drift proposal digest does not match its contents");
  });

  it("requires the candidate to name the current parent", () => {
    const fixture = fixtures();
    const candidateDefinition = {
      ...fixture.candidateDefinition,
      parent_version: `sha256:${"c".repeat(64)}`,
    };
    const approved = approveDrift(
      detectDrift(
        fixture.parentManifest,
        fixture.parentBundle,
        fixture.candidateBundle,
        candidateDefinition,
      ),
      "tester",
    );

    expect(() =>
      publishDrift(
        fixture.parentManifest,
        fixture.candidateBundle,
        candidateDefinition,
        approved,
      ),
    ).toThrow(
      "candidate definition must name the current corpus as its parent",
    );
  });

  it.each([
    {
      name: "duplicate case",
      cases: (fixture: ReturnType<typeof fixtures>) => [
        ...fixture.candidateDefinition.cases,
        fixture.candidateDefinition.cases[0]!,
      ],
      bundle: (fixture: ReturnType<typeof fixtures>) => fixture.candidateBundle,
      message: "duplicate corpus case: case-1",
    },
    {
      name: "missing source run",
      cases: (fixture: ReturnType<typeof fixtures>) => [
        ...fixture.candidateDefinition.cases,
        corpusCase("case-4", "missing"),
      ],
      bundle: (fixture: ReturnType<typeof fixtures>) => fixture.candidateBundle,
      message: "source run not found: missing",
    },
    {
      name: "unaccepted source run",
      cases: (fixture: ReturnType<typeof fixtures>) => [
        ...fixture.candidateDefinition.cases,
        corpusCase("case-4", "run-4"),
      ],
      bundle: (fixture: ReturnType<typeof fixtures>) =>
        bundle(
          [
            ...fixture.candidateBundle.runs,
            run("run-4", "failed", { success: false }),
          ],
          "candidate-bundle",
        ),
      message: "source run is not accepted: run-4",
    },
  ])(
    "refuses a $name while compiling publication",
    ({ cases, bundle: nextBundle, message }) => {
      const fixture = fixtures();
      const candidateDefinition = {
        ...fixture.candidateDefinition,
        cases: cases(fixture),
      };
      const candidateBundle = nextBundle(fixture);
      const approved = approveDrift(
        detectDrift(
          fixture.parentManifest,
          fixture.parentBundle,
          candidateBundle,
          candidateDefinition,
        ),
        "tester",
      );

      expect(() =>
        publishDrift(
          fixture.parentManifest,
          candidateBundle,
          candidateDefinition,
          approved,
        ),
      ).toThrow(message);
    },
  );
});

describe("proposed mutation-closing tests", () => {
  it("pins every field covered by the proposal digest", () => {
    const fixture = fixtures();
    const proposal = detectDrift(
      fixture.parentManifest,
      fixture.parentBundle,
      fixture.candidateBundle,
      fixture.candidateDefinition,
    );
    const patches = [
      { version: "9" },
      { parent_corpus_version_id: `sha256:${"d".repeat(64)}` },
      { candidate_definition_digest: `sha256:${"e".repeat(64)}` },
      { exposed_holdout_case_ids: [] },
      { replacement_holdout_case_ids: [] },
      { signals: ["tool"] },
      { proposed_changes: [] },
    ];
    for (const patch of patches) {
      expect(() =>
        approveDrift(
          { ...proposal, ...patch } as unknown as CorpusDriftProposal,
          "tester",
        ),
      ).toThrow("drift proposal digest does not match its contents");
    }
  });

  it.each([
    "version",
    "parent_corpus_version_id",
    "candidate_definition_digest",
    "proposed_changes",
    "signals",
    "exposed_holdout_case_ids",
    "replacement_holdout_case_ids",
  ] as const)("refuses a proposal with $s omitted", (field) => {
    const fixture = fixtures();
    const proposal = detectDrift(
      fixture.parentManifest,
      fixture.parentBundle,
      fixture.candidateBundle,
      fixture.candidateDefinition,
    );
    const tampered = { ...proposal } as Record<string, unknown>;
    delete tampered[field];

    expect(() =>
      approveDrift(tampered as unknown as CorpusDriftProposal, "tester"),
    ).toThrow("drift proposal digest does not match its contents");
  });

  it.each([
    {
      name: "version",
      patch: (d: CorpusDefinition) => ({ ...d, version: "other" }),
    },
    {
      name: "corpus_id",
      patch: (d: CorpusDefinition) => ({ ...d, corpus_id: "other" }),
    },
    {
      name: "parent_version",
      patch: (d: CorpusDefinition) => ({
        ...d,
        parent_version: `sha256:${"f".repeat(64)}`,
      }),
    },
    {
      name: "case id",
      patch: (d: CorpusDefinition) => ({
        ...d,
        cases: [{ ...d.cases[0]!, case_id: "other-case" }, ...d.cases.slice(1)],
      }),
    },
    {
      name: "case pipeline family",
      patch: (d: CorpusDefinition) => ({
        ...d,
        cases: [
          { ...d.cases[0]!, pipeline_family: "repo-fix" as const },
          ...d.cases.slice(1),
        ],
      }),
    },
    {
      name: "case workload label",
      patch: (d: CorpusDefinition) => ({
        ...d,
        cases: [
          { ...d.cases[0]!, workload_label: "other" },
          ...d.cases.slice(1),
        ],
      }),
    },
    {
      name: "case risk",
      patch: (d: CorpusDefinition) => ({
        ...d,
        cases: [{ ...d.cases[0]!, risk: "high" as const }, ...d.cases.slice(1)],
      }),
    },
    {
      name: "case required evidence",
      patch: (d: CorpusDefinition) => ({
        ...d,
        cases: [
          { ...d.cases[0]!, required_evidence: "reference" as const },
          ...d.cases.slice(1),
        ],
      }),
    },
    {
      name: "case checks",
      patch: (d: CorpusDefinition) => ({
        ...d,
        cases: [
          { ...d.cases[0]!, checks: { other: true } },
          ...d.cases.slice(1),
        ],
      }),
    },
    {
      name: "case split",
      patch: (d: CorpusDefinition) => ({
        ...d,
        cases: [
          { ...d.cases[0]!, split: "holdout" as const },
          ...d.cases.slice(1),
        ],
      }),
    },
    {
      name: "case source_run_id",
      patch: (d: CorpusDefinition) => ({
        ...d,
        cases: [
          { ...d.cases[0]!, source_run_id: "run-2" },
          ...d.cases.slice(1),
        ],
      }),
    },
    {
      name: "case labels",
      patch: (d: CorpusDefinition) => ({
        ...d,
        cases: [
          {
            ...d.cases[0]!,
            labels: {
              recommendation: "safe" as const,
              required_abstention: false,
            },
          },
          ...d.cases.slice(1),
        ],
      }),
    },
  ])("refuses publication when the candidate $name changed", ({ patch }) => {
    const fixture = fixtures();
    const approved = approveDrift(
      detectDrift(
        fixture.parentManifest,
        fixture.parentBundle,
        fixture.candidateBundle,
        fixture.candidateDefinition,
      ),
      "tester",
    );

    expect(() =>
      publishDrift(
        fixture.parentManifest,
        fixture.candidateBundle,
        patch(fixture.candidateDefinition),
        approved,
      ),
    ).toThrow("candidate definition does not match drift proposal");
  });

  it.each([
    "version",
    "corpus_id",
    "parent_version",
    "cases",
    "case_id",
    "source_run_id",
    "pipeline_family",
    "workload_label",
    "split",
    "risk",
    "required_evidence",
    "checks",
  ] as const)("refuses a candidate with $s omitted", (field) => {
    const fixture = fixtures();
    const approved = approveDrift(
      detectDrift(
        fixture.parentManifest,
        fixture.parentBundle,
        fixture.candidateBundle,
        fixture.candidateDefinition,
      ),
      "tester",
    );
    const candidate = {
      ...fixture.candidateDefinition,
      cases: fixture.candidateDefinition.cases.map((corpusCase) => ({
        ...corpusCase,
      })),
    } as unknown as Record<string, unknown>;
    if (["version", "corpus_id", "parent_version", "cases"].includes(field)) {
      delete candidate[field];
    } else {
      const cases = candidate.cases as Array<Record<string, unknown>>;
      delete cases[0]![field];
    }

    expect(() =>
      publishDrift(
        fixture.parentManifest,
        fixture.candidateBundle,
        candidate as unknown as CorpusDefinition,
        approved,
      ),
    ).toThrow("candidate definition does not match drift proposal");
  });

  it("publishes a complete manifest bound to its source bundle", () => {
    const fixture = fixtures();
    const approved = approveDrift(
      detectDrift(
        fixture.parentManifest,
        fixture.parentBundle,
        fixture.candidateBundle,
        fixture.candidateDefinition,
      ),
      "tester",
    );
    const published = publishDrift(
      fixture.parentManifest,
      fixture.candidateBundle,
      fixture.candidateDefinition,
      approved,
    );
    const renamed = publishDrift(
      fixture.parentManifest,
      { ...fixture.candidateBundle, bundle_id: "other-bundle" },
      fixture.candidateDefinition,
      approved,
    );

    expect(published.manifest).toMatchObject({
      version: "2",
      corpus_id: "drift-fixture",
      corpus_version: "2",
      parent_version: parentDigest,
      source_bundle_id: "candidate-bundle",
    });
    expect(published.manifest.cases.map(({ case_id }) => case_id)).toEqual([
      "case-1",
      "case-2",
      "case-3",
    ]);
    expect(published.benchmark_cases).toMatchObject({
      version: "2",
      source_bundle_id: "candidate-bundle",
    });
    expect(renamed.manifest.content_digest).not.toBe(
      published.manifest.content_digest,
    );
  });

  it.each([
    { name: "version", patch: { version: "other" } },
    { name: "corpus_id", patch: { corpus_id: "other" } },
    { name: "corpus_version", patch: { corpus_version: "other" } },
    {
      name: "parent_version",
      patch: { parent_version: `sha256:${"f".repeat(64)}` },
    },
    { name: "source_bundle_id", patch: { source_bundle_id: "other" } },
    { name: "cases", patch: { cases: [] } },
    { name: "content_digest", patch: { content_digest: parentDigest } },
  ])("refuses a manifest with tampered $name", ({ patch }) => {
    const fixture = fixtures();
    const approved = approveDrift(
      detectDrift(
        fixture.parentManifest,
        fixture.parentBundle,
        fixture.candidateBundle,
        fixture.candidateDefinition,
      ),
      "tester",
    );
    const manifest = publishDrift(
      fixture.parentManifest,
      fixture.candidateBundle,
      fixture.candidateDefinition,
      approved,
    ).manifest;

    expect(() =>
      assertCorpusManifestIntegrity({ ...manifest, ...patch }),
    ).toThrow("corpus manifest digest does not match its contents");
  });

  it.each([
    "version",
    "corpus_id",
    "corpus_version",
    "parent_version",
    "source_bundle_id",
    "cases",
  ] as const)("refuses a manifest with $s omitted", (field) => {
    const fixture = fixtures();
    const approved = approveDrift(
      detectDrift(
        fixture.parentManifest,
        fixture.parentBundle,
        fixture.candidateBundle,
        fixture.candidateDefinition,
      ),
      "tester",
    );
    const manifest = publishDrift(
      fixture.parentManifest,
      fixture.candidateBundle,
      fixture.candidateDefinition,
      approved,
    ).manifest;
    const tampered = { ...manifest } as Record<string, unknown>;
    delete tampered[field];

    expect(() =>
      assertCorpusManifestIntegrity(tampered as unknown as CorpusManifest),
    ).toThrow("corpus manifest digest does not match its contents");
  });

  it("pins the corpus manifest digest algorithm to a golden vector", () => {
    const fixture = fixtures();
    const approved = approveDrift(
      detectDrift(
        fixture.parentManifest,
        fixture.parentBundle,
        fixture.candidateBundle,
        fixture.candidateDefinition,
      ),
      "tester",
    );

    expect(
      publishDrift(
        fixture.parentManifest,
        fixture.candidateBundle,
        fixture.candidateDefinition,
        approved,
      ).manifest.content_digest,
    ).toBe(
      "sha256:1690f498866cb87f50bf2c47ce3f3b148eb5bdc6fa783549604dc6ac670e7d1e",
    );
  });

  it("sorts compiled cases independently of definition order", () => {
    const fixture = fixtures();
    const candidateDefinition = {
      ...fixture.candidateDefinition,
      cases: [...fixture.candidateDefinition.cases].reverse(),
    };
    const approved = approveDrift(
      detectDrift(
        fixture.parentManifest,
        fixture.parentBundle,
        fixture.candidateBundle,
        candidateDefinition,
      ),
      "tester",
    );

    expect(
      publishDrift(
        fixture.parentManifest,
        fixture.candidateBundle,
        candidateDefinition,
        approved,
      ).manifest.cases.map(({ case_id }) => case_id),
    ).toEqual(["case-1", "case-2", "case-3"]);
  });

  it("keeps a latency change of exactly the threshold silent", () => {
    expect(
      proposalForRuns(
        run("run-1", "same", { duration_ms: 100 }),
        run("run-1", "same", { duration_ms: 120 }),
      ).signals,
    ).toEqual(["none"]);
  });

  it.each([
    { durationMs: 119.9, signals: ["none"] },
    { durationMs: 120.1, signals: ["latency"] },
  ])(
    "applies the 0.2 latency threshold to $durationMs ms",
    ({ durationMs, signals }) => {
      expect(
        proposalForRuns(
          run("run-1", "same", { duration_ms: 100 }),
          run("run-1", "same", { duration_ms: durationMs }),
        ).signals,
      ).toEqual(signals);
    },
  );

  it.each([
    { risk: "normal" as const, action: "relabel" },
    { risk: "high" as const, action: "red-team" },
  ])("labels $risk-risk run drift as $action", ({ risk, action }) => {
    const parentCase = corpusCase("case-1", "run-1", "working", { risk });
    const proposal = detectDrift(
      {
        version: "1",
        corpus_id: "drift-fixture",
        corpus_version: "1",
        parent_version: null,
        source_bundle_id: "parent-bundle",
        content_digest: parentDigest,
        cases: [parentCase],
      },
      bundle([run("run-1", "old")], "parent-bundle"),
      bundle([run("run-1", "new")], "candidate-bundle"),
      {
        version: "2",
        corpus_id: "drift-fixture",
        parent_version: parentDigest,
        cases: [parentCase],
      },
    );

    expect(proposal.proposed_changes).toEqual([
      {
        action,
        case_id: "case-1",
        signal: "input",
        detail: "source run shows input drift",
      },
    ]);
  });
});
