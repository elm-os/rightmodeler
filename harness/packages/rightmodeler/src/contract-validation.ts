import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import benchmarkCasesSchema from "../../../../packages/contracts/schemas/benchmark-cases.schema.json" with { type: "json" };
import corpusDriftProposalSchema from "../../../../packages/contracts/schemas/corpus-drift-proposal.schema.json" with { type: "json" };
import corpusManifestSchema from "../../../../packages/contracts/schemas/corpus-manifest.schema.json" with { type: "json" };
import remediationEvidenceSchema from "../../../../packages/contracts/schemas/remediation-evidence.schema.json" with { type: "json" };
import remediationLifecycleSchema from "../../../../packages/contracts/schemas/remediation-lifecycle.schema.json" with { type: "json" };

import { canonicalJson, jsonValueSchema, type Store } from "@rightmodeler/core";

export type ContractArtifactName =
  | "benchmark-cases"
  | "corpus-drift-proposal"
  | "corpus-manifest"
  | "remediation-evidence"
  | "remediation-lifecycle";

const refusalCodes = {
  "benchmark-cases": "invalid_benchmark_cases",
  "corpus-drift-proposal": "invalid_corpus_drift_proposal",
  "corpus-manifest": "invalid_corpus_manifest",
  "remediation-evidence": "invalid_remediation_evidence",
  "remediation-lifecycle": "invalid_remediation_lifecycle",
} as const satisfies Record<ContractArtifactName, string>;

export class ContractArtifactValidationError extends Error {
  readonly code: (typeof refusalCodes)[ContractArtifactName];

  constructor(name: ContractArtifactName, errors: readonly ErrorObject[]) {
    super(`${name} contract validation failed: ${formatErrors(errors)}`);
    this.name = "ContractArtifactValidationError";
    this.code = refusalCodes[name];
  }
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: false,
});

const validators: Record<ContractArtifactName, ValidateFunction> = {
  "benchmark-cases": ajv.compile(benchmarkCasesSchema),
  "corpus-drift-proposal": ajv.compile(corpusDriftProposalSchema),
  "corpus-manifest": ajv.compile(corpusManifestSchema),
  "remediation-evidence": ajv.compile(remediationEvidenceSchema),
  "remediation-lifecycle": ajv.compile(remediationLifecycleSchema),
};

export function assertContractArtifact(
  name: ContractArtifactName,
  value: unknown,
): void {
  const validate = validators[name];
  if (validate(value)) return;
  throw new ContractArtifactValidationError(name, validate.errors ?? []);
}

export async function putContractArtifact(
  store: Store,
  key: string,
  name: ContractArtifactName,
  value: unknown,
): Promise<void> {
  assertContractArtifact(name, value);
  await store.putImmutable(
    key,
    Buffer.from(canonicalJson(jsonValueSchema.parse(value)), "utf8"),
  );
}

function formatErrors(errors: readonly ErrorObject[]): string {
  if (errors.length === 0) return "unknown schema mismatch";
  return errors
    .map(({ instancePath, message }) => `${instancePath || "/"} ${message}`)
    .join("; ");
}
