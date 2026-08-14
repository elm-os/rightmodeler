import invalidBenchmarkCases from "../../../../packages/contracts/fixtures/benchmark-cases.invalid.json" with { type: "json" };
import validBenchmarkCases from "../../../../packages/contracts/fixtures/benchmark-cases.valid.json" with { type: "json" };
import invalidDriftProposal from "../../../../packages/contracts/fixtures/corpus-drift-proposal.invalid.json" with { type: "json" };
import validDriftProposal from "../../../../packages/contracts/fixtures/corpus-drift-proposal.valid.json" with { type: "json" };
import invalidCorpusManifest from "../../../../packages/contracts/fixtures/corpus-manifest.invalid.json" with { type: "json" };
import validCorpusManifest from "../../../../packages/contracts/fixtures/corpus-manifest.valid.json" with { type: "json" };
import invalidRemediationEvidence from "../../../../packages/contracts/fixtures/remediation-evidence.invalid.json" with { type: "json" };
import validRemediationEvidence from "../../../../packages/contracts/fixtures/remediation-evidence.valid.json" with { type: "json" };
import invalidRemediationLifecycle from "../../../../packages/contracts/fixtures/remediation-lifecycle.invalid.json" with { type: "json" };
import validRemediationLifecycle from "../../../../packages/contracts/fixtures/remediation-lifecycle.valid.json" with { type: "json" };

import type { Store } from "@rightmodeler/core";
import { describe, expect, it } from "vitest";

import {
  assertContractArtifact,
  putContractArtifact,
  type ContractArtifactName,
} from "./contract-validation.js";

const fixtures = [
  {
    name: "benchmark-cases",
    valid: validBenchmarkCases,
    invalid: invalidBenchmarkCases,
    code: "invalid_benchmark_cases",
  },
  {
    name: "corpus-drift-proposal",
    valid: validDriftProposal,
    invalid: invalidDriftProposal,
    code: "invalid_corpus_drift_proposal",
  },
  {
    name: "corpus-manifest",
    valid: validCorpusManifest,
    invalid: invalidCorpusManifest,
    code: "invalid_corpus_manifest",
  },
  {
    name: "remediation-evidence",
    valid: validRemediationEvidence,
    invalid: invalidRemediationEvidence,
    code: "invalid_remediation_evidence",
  },
  {
    name: "remediation-lifecycle",
    valid: validRemediationLifecycle,
    invalid: invalidRemediationLifecycle,
    code: "invalid_remediation_lifecycle",
  },
] as const satisfies readonly {
  readonly name: ContractArtifactName;
  readonly valid: unknown;
  readonly invalid: unknown;
  readonly code: string;
}[];

describe("contract artifact validation", () => {
  it.each(fixtures)(
    "validates $name against its contract schema",
    (fixture) => {
      expect(() =>
        assertContractArtifact(fixture.name, fixture.valid),
      ).not.toThrow();
    },
  );

  it.each(fixtures)("names an invalid $name artifact", (fixture) => {
    expect(() => assertContractArtifact(fixture.name, fixture.invalid)).toThrow(
      expect.objectContaining({ code: fixture.code }),
    );
  });

  it("refuses an invalid artifact before writing it", async () => {
    let writes = 0;
    const store: Store = {
      get: async () => null,
      list: async () => [],
      putImmutable: async () => {
        writes += 1;
      },
      compareAndSwap: async () => false,
    };

    await expect(
      putContractArtifact(
        store,
        "project/contracts/invalid.json",
        "remediation-evidence",
        invalidRemediationEvidence,
      ),
    ).rejects.toMatchObject({ code: "invalid_remediation_evidence" });
    expect(writes).toBe(0);
  });
});
