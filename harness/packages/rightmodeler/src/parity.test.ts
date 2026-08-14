import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  jsonValueSchema,
  type JsonValue,
} from "@rightmodeler/core";
import {
  detectDrift,
  diagnoseRemediationEvidence,
  type CorpusCaseDefinition,
  type CorpusDefinition,
  type CorpusManifest,
  type DiagnosisSnapshot,
  type HistoricalRunBundle,
  type RemediationProposedChange,
} from "@rightmodeler/kernel";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const pipelineRoot = fileURLToPath(
  new URL("../../../../apps/pipeline", import.meta.url),
);
const pipelineSource = fileURLToPath(
  new URL("../../../../apps/pipeline/src/pipeline", import.meta.url),
);
const vectorsPath = fileURLToPath(
  new URL(
    "../../../fixtures/canonicalization/rfc8785-vectors.json",
    import.meta.url,
  ),
);
const manifestPath = fileURLToPath(
  new URL("../../../docs/parity.md", import.meta.url),
);

interface CanonicalizationVector {
  readonly name: string;
  readonly value: JsonValue;
  readonly canonical: string;
  readonly sha256: string;
}

const canonicalizationVectors = parseVectors(
  JSON.parse(readFileSync(vectorsPath, "utf8")) as unknown,
);

const pythonScript = String.raw`
import json
import sys

from pipeline.diagnosis import diagnose_snapshot
from pipeline.drift import detect_drift

request = json.load(sys.stdin)
operation = request["operation"]
arguments = request["arguments"]

if operation == "detect_drift":
    result = detect_drift(*arguments)
elif operation == "diagnose_snapshot":
    result = diagnose_snapshot(*arguments)
else:
    raise ValueError(f"unsupported parity operation: {operation}")

print(json.dumps(result, separators=(",", ":")))
`;

const forcePythonSkip =
  process.env.RIGHTMODELER_PARITY_FORCE_PYTHON_SKIP === "1";
const uvProbe = forcePythonSkip
  ? undefined
  : spawnSync("uv", ["--version"], { encoding: "utf8" });
const pythonAvailable = !forcePythonSkip && uvProbe?.status === 0;
const pythonSkipReason = forcePythonSkip
  ? "forced by RIGHTMODELER_PARITY_FORCE_PYTHON_SKIP"
  : uvProbe?.error !== undefined
    ? uvProbe.error.message
    : `uv exited with status ${uvProbe?.status ?? "unknown"}: ${uvProbe?.stderr.trim() || "(no stderr)"}`;

if (!pythonAvailable && process.env.CI)
  throw new Error(
    `[parity] Python differential is mandatory in CI: ${pythonSkipReason}`,
  );
if (!pythonAvailable) {
  console.warn(`[parity] SKIPPED Python differential: ${pythonSkipReason}`);
}

describe("parity manifest", () => {
  it("mentions every legacy Python module", () => {
    const manifest = readFileSync(manifestPath, "utf8");
    const modules = readdirSync(pipelineSource)
      .filter((name) => name.endsWith(".py"))
      .sort();

    for (const moduleName of modules) {
      expect(manifest, `missing module coverage for ${moduleName}`).toContain(
        `\`${moduleName}\``,
      );
    }
    expect(manifest).not.toMatch(/\|\s*(?:unclassified|todo|tbd)\s*\|/iu);
  });
});

describe("Python availability gate", () => {
  it("fails the parity suite when Python is unavailable in CI", () => {
    const result = spawnSync(
      "pnpm",
      ["exec", "vitest", "run", fileURLToPath(import.meta.url)],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          FORCE_COLOR: "0",
          RIGHTMODELER_PARITY_FORCE_PYTHON_SKIP: "1",
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "[parity] Python differential is mandatory in CI: forced by RIGHTMODELER_PARITY_FORCE_PYTHON_SKIP",
    );
  });
});

describe("RFC 8785 canonicalization", () => {
  it.each(canonicalizationVectors)(
    "matches $name bytes and digest",
    (vector) => {
      const actual = canonicalJson(vector.value);

      expect(actual).toBe(vector.canonical);
      expect(createHash("sha256").update(actual, "utf8").digest("hex")).toBe(
        vector.sha256,
      );
    },
  );
});

describe.skipIf(!pythonAvailable)(
  `Python preserve differential${pythonAvailable ? "" : ` (${pythonSkipReason})`}`,
  () => {
    it("matches drift classification fields on the same artifacts", () => {
      const parentCase = corpusCase("case-1", "run-1", "holdout");
      const candidateCase = corpusCase("case-1", "run-1", "working");
      const replacementCase = corpusCase("case-2", "run-2", "holdout");
      const parentManifest: CorpusManifest = {
        version: "1",
        corpus_id: "parity",
        corpus_version: "1",
        parent_version: null,
        source_bundle_id: "parent",
        content_digest: `sha256:${"a".repeat(64)}`,
        cases: [parentCase],
      };
      const parentBundle: HistoricalRunBundle = {
        version: "1",
        bundle_id: "parent",
        runs: [
          historicalRun("run-1", "old prompt", {
            tool_calls: [{ name: "lookup", arguments: { id: "1" } }],
            evaluator: "judge-a",
            evaluator_version: "1",
            success: true,
            retry_count: 0,
            trajectory: ["lookup", "answer"],
          }),
        ],
      };
      const candidateBundle: HistoricalRunBundle = {
        version: "1",
        bundle_id: "candidate",
        runs: [
          historicalRun("run-1", "new prompt", {
            model: "acme/small",
            tool_calls: [{ name: "search", arguments: { id: "2" } }],
            evaluator: "judge-b",
            evaluator_version: "2",
            success: false,
            cost_usd: 0.3,
            duration_ms: 150,
            retry_count: 1,
            trajectory: ["search", "recover", "answer"],
          }),
          historicalRun("run-2", "replacement prompt"),
        ],
      };
      const candidateDefinition: CorpusDefinition = {
        version: "2",
        corpus_id: "parity",
        parent_version: parentManifest.content_digest,
        cases: [candidateCase, replacementCase],
      };

      const typescript = detectDrift(
        parentManifest,
        parentBundle,
        candidateBundle,
        candidateDefinition,
      );
      const python = runPython<ReturnType<typeof detectDrift>>("detect_drift", [
        parentManifest,
        parentBundle,
        candidateBundle,
        candidateDefinition,
      ]);

      expect(typescript.signals).toEqual([
        "acceptance",
        "cost",
        "evaluator",
        "input",
        "latency",
        "model",
        "retry",
        "tool",
        "trajectory",
      ]);
      expect(driftProjection(typescript)).toEqual(driftProjection(python));
    });

    it.each([
      {
        name: "no drift",
        candidateValue: 100,
        expectedSignals: ["none"],
      },
      {
        name: "exactly at the 20% boundary",
        candidateValue: 120,
        expectedSignals: ["none"],
      },
      {
        name: "just above the 20% boundary",
        candidateValue: 121,
        expectedSignals: ["cost", "latency"],
      },
    ])(
      "matches $name with the latency fallback",
      ({ candidateValue, expectedSignals }) => {
        const parentCase = corpusCase("case-1", "run-1", "working");
        const parentManifest: CorpusManifest = {
          version: "1",
          corpus_id: "parity-boundary",
          corpus_version: "1",
          parent_version: null,
          source_bundle_id: "parent-boundary",
          content_digest: `sha256:${"d".repeat(64)}`,
          cases: [parentCase],
        };
        const parentBundle: HistoricalRunBundle = {
          version: "1",
          bundle_id: "parent-boundary",
          runs: [
            historicalRun("run-1", "same prompt", {
              cost_usd: 100,
              duration_ms: undefined,
              latency_ms: 100,
            }),
          ],
        };
        const candidateBundle: HistoricalRunBundle = {
          version: "1",
          bundle_id: "candidate-boundary",
          runs: [
            historicalRun("run-1", "same prompt", {
              cost_usd: candidateValue,
              duration_ms: undefined,
              latency_ms: candidateValue,
            }),
          ],
        };
        const candidateDefinition: CorpusDefinition = {
          version: "2",
          corpus_id: "parity-boundary",
          parent_version: parentManifest.content_digest,
          cases: [parentCase],
        };

        const typescript = detectDrift(
          parentManifest,
          parentBundle,
          candidateBundle,
          candidateDefinition,
        );
        const python = runPython<ReturnType<typeof detectDrift>>(
          "detect_drift",
          [parentManifest, parentBundle, candidateBundle, candidateDefinition],
        );

        expect(typescript.signals).toEqual(expectedSignals);
        expect(driftProjection(typescript)).toEqual(driftProjection(python));
      },
    );

    it("matches diagnosis and remediation evidence fields on the same snapshot", () => {
      const baseline = diagnosisSnapshot(`sha256:${"a".repeat(64)}`, [
        { id: "quality", status: "fail" },
        { id: "speed", status: "pass" },
        { id: "standard-benchmark", status: "fail" },
      ]);
      const postFix = diagnosisSnapshot(`sha256:${"b".repeat(64)}`, [
        { id: "quality", status: "pass" },
        { id: "speed", status: "pass" },
        { id: "standard-benchmark", status: "pass" },
      ]);
      const holdout = diagnosisSnapshot(`sha256:${"c".repeat(64)}`, [
        { id: "standard-benchmark", status: "pass" },
      ]);
      const proposal: RemediationProposedChange = {
        type: "configuration",
        content: "require the structured status field",
        affected_files: ["src/evaluator.ts"],
        validation_commands: [
          {
            name: "tests",
            command: ["pnpm", "test"],
            timeout_seconds: 60,
          },
        ],
      };
      const validation = {
        status: "passed" as const,
        commands: ["tests"],
        evidence_refs: ["ci/1"],
      };

      const typescript = expectDiagnosisParity({
        baseline,
        proposal,
        postFix,
        holdout,
        validation,
      });

      expect(typescript.status).toBe("proven");
    });

    it("matches diagnosis precedence, trigger normalization, defaults, and regressions", () => {
      const proposal: RemediationProposedChange = {
        type: "configuration",
        content: "adjust candidate selection",
        affected_files: ["src/z.ts", "src/a.ts", "src/a.ts"],
        validation_commands: [],
      };
      const cases: ReadonlyArray<{
        readonly input: Parameters<typeof diagnoseRemediationEvidence>[0];
        readonly issueClass: string;
        readonly triggerCaseIds: readonly string[];
      }> = [
        {
          input: {
            baseline: diagnosisSnapshot(
              `sha256:${"d".repeat(64)}`,
              [
                { id: "quality", status: "fail" },
                { id: "confidence", status: "indeterminate" },
              ],
              {
                cases: [
                  diagnosisCase("z", "ingestion_decode_failed"),
                  diagnosisCase("a", "replay_timeout"),
                  diagnosisCase("a", "ingestion_parse_failed"),
                ],
                confidenceStatus: "review",
              },
            ),
            proposal,
          },
          issueClass: "ingestion",
          triggerCaseIds: ["a", "z"],
        },
        {
          input: {
            baseline: diagnosisSnapshot(`sha256:${"e".repeat(64)}`, [], {
              cases: [
                diagnosisCase("z", "unknown_failure"),
                diagnosisCase("a", "replay_timeout"),
              ],
            }),
          },
          issueClass: "replay",
          triggerCaseIds: ["a", "z"],
        },
        {
          input: {
            baseline: diagnosisSnapshot(
              `sha256:${"f".repeat(64)}`,
              [
                { id: "recommendation-precision", status: "fail" },
                { id: "speed", status: "pass" },
              ],
              { cases: [diagnosisCase("selection", "unknown_failure")] },
            ),
            proposal,
            postFix: diagnosisSnapshot(`sha256:${"1".repeat(64)}`, [
              { id: "recommendation-precision", status: "pass" },
              { id: "speed", status: "fail" },
            ]),
          },
          issueClass: "candidate-selection",
          triggerCaseIds: ["selection"],
        },
      ];

      const [ingestion, replay, selection] = cases.map(
        ({ input, issueClass, triggerCaseIds }) => {
          const evidence = expectDiagnosisParity(input);
          expect(evidence.issue_class).toBe(issueClass);
          expect(evidence.trigger_case_ids).toEqual(triggerCaseIds);
          return evidence;
        },
      );

      expect(ingestion?.status).toBe("draft");
      expect(ingestion?.proof.baseline_gate_statuses).toEqual({
        confidence: "review",
        quality: "fail",
      });
      expect(replay?.proof.target_gate_ids).toEqual(["standard-benchmark"]);
      expect(replay?.status).toBe("review");
      expect(selection?.proposed_change.affected_files).toEqual([
        "src/a.ts",
        "src/z.ts",
      ]);
      expect(selection?.proof.regressed_gate_ids).toEqual(["speed"]);
      expect(selection?.status).toBe("review");
    });

    it("runs the Python canonicalization vectors against the production digest", () => {
      const result = spawnSync(
        "uv",
        [
          "run",
          "--locked",
          "--project",
          pipelineRoot,
          "pytest",
          `${pipelineRoot}/tests/test_canonicalization_vectors.py`,
          "-q",
        ],
        { cwd: repositoryRoot, encoding: "utf8" },
      );

      expect(
        result.status,
        `Python canonicalization failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toBe(0);
    });
  },
);

function parseVectors(value: unknown): CanonicalizationVector[] {
  if (!Array.isArray(value))
    throw new TypeError("Canonicalization vectors must be an array");
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new TypeError("Canonicalization vector must be an object");
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.name !== "string" ||
      typeof record.canonical !== "string" ||
      typeof record.sha256 !== "string"
    ) {
      throw new TypeError("Canonicalization vector metadata is invalid");
    }
    return {
      name: record.name,
      value: jsonValueSchema.parse(record.value),
      canonical: record.canonical,
      sha256: record.sha256,
    };
  });
}

function runPython<T>(operation: string, args: readonly unknown[]): T {
  const result = spawnSync(
    "uv",
    [
      "run",
      "--locked",
      "--project",
      pipelineRoot,
      "python",
      "-c",
      pythonScript,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      input: JSON.stringify({ operation, arguments: args }),
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Python ${operation} failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout) as T;
}

function corpusCase(
  caseId: string,
  sourceRunId: string,
  split: "working" | "holdout",
): CorpusCaseDefinition {
  return {
    case_id: caseId,
    source_run_id: sourceRunId,
    pipeline_family: "structured-check",
    workload_label: "parity",
    split,
    risk: "normal",
    required_evidence: "deterministic",
    checks: { required_fields: ["status"] },
  };
}

function historicalRun(
  id: string,
  prompt: string,
  overrides: Partial<HistoricalRunBundle["runs"][number]> = {},
): HistoricalRunBundle["runs"][number] {
  return {
    id,
    prompt,
    model: "acme/large",
    success: true,
    cost_usd: 0.1,
    duration_ms: 100,
    ...overrides,
  };
}

function driftProjection(proposal: ReturnType<typeof detectDrift>) {
  expect(proposal.candidate_definition_digest).toMatch(
    /^sha256:[a-f0-9]{64}$/u,
  );
  expect(proposal.proposal_id).toMatch(/^sha256:[a-f0-9]{64}$/u);
  return {
    version: proposal.version,
    parentCorpusVersionId: proposal.parent_corpus_version_id,
    status: proposal.status,
    changes: proposal.proposed_changes,
    signals: proposal.signals,
    exposedHoldoutCaseIds: proposal.exposed_holdout_case_ids,
    replacementHoldoutCaseIds: proposal.replacement_holdout_case_ids,
    approval: proposal.approval,
  };
}

function diagnosisSnapshot(
  snapshotId: string,
  gates: DiagnosisSnapshot["gates"],
  options: {
    readonly cases?: DiagnosisSnapshot["cases"];
    readonly confidenceStatus?: DiagnosisSnapshot["confidenceStatus"];
  } = {},
): DiagnosisSnapshot {
  return {
    snapshotId,
    gates,
    confidenceStatus: options.confidenceStatus ?? "pass",
    replayObserved: false,
    cases: options.cases ?? [diagnosisCase("case-1", "invalid_json")],
  };
}

function diagnosisCase(
  caseId: string,
  failureCode: string,
): DiagnosisSnapshot["cases"][number] {
  return {
    caseId,
    pipelineFamily: "structured-check",
    terminalVerdict: "fail",
    failureCode,
    evidenceRefs: [`candidate/${caseId}`],
  };
}

function expectDiagnosisParity(
  input: Parameters<typeof diagnoseRemediationEvidence>[0],
) {
  const typescript = diagnoseRemediationEvidence(input);
  const python = runPython<ReturnType<typeof diagnoseRemediationEvidence>>(
    "diagnose_snapshot",
    [
      pythonSnapshot(input.baseline),
      input.proposal ?? null,
      input.postFix === undefined ? null : pythonSnapshot(input.postFix),
      input.holdout === undefined ? null : pythonSnapshot(input.holdout),
      input.validation ?? null,
    ],
  );
  const { evidence_id: typescriptEvidenceId, ...typescriptFields } = typescript;
  const { evidence_id: pythonEvidenceId, ...pythonFields } = python;

  expect(typescriptEvidenceId).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(pythonEvidenceId).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(typescriptFields).toEqual(pythonFields);
  return typescript;
}

function pythonSnapshot(snapshot: DiagnosisSnapshot) {
  return {
    snapshot_id: snapshot.snapshotId,
    gates: snapshot.gates,
    scorecards: { confidence: { status: snapshot.confidenceStatus } },
    case_verdicts: snapshot.cases.map((item) => ({
      case_id: item.caseId,
      pipeline_family: item.pipelineFamily,
      terminal_verdict: item.terminalVerdict,
      failure_code: item.failureCode,
      evidence_refs: item.evidenceRefs,
    })),
  };
}
