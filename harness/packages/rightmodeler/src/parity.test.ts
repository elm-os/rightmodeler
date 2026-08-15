import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import {
  canonicalJson,
  jsonValueSchema,
  type JsonValue,
} from "@rightmodeler/core";
import { describe, expect, it } from "vitest";

const vectorsPath = new URL(
  "../../../fixtures/canonicalization/rfc8785-vectors.json",
  import.meta.url,
);
const manifestPath = new URL("../../../docs/parity.md", import.meta.url);

const expectedManifestRows = `
BB1:change BB2:change BB3:change BB4:change
A1:change A2:retire A3:retire A4:change A5:retire A6:retire A7:change A8:retire A9:change A10:change
C1:change C2:change C3:change C4:change C5:change C6:change C7:change C8:change
D1:preserve D2:preserve D3:preserve D4:preserve D5:preserve D6:preserve D7:preserve D8:change
DR1:preserve DR2:preserve DR3:preserve DR4:preserve DR5:preserve DR6:preserve DR7:preserve DR8:change DR9:change
E1:retire E2:retire E3:retire E4:retire E5:retire
F1:change F2:change F3:change F4:change F5:change F6:retire F7:change
RF1:change RF2:change RF3:change RF4:change RF5:change RF6:change RF7:change RF8:change RF9:retire RF10:change RF11:change RF12:retire RF13:change
RM1:change RM2:change RM3:change RM4:change RM5:change RM6:change RM7:change RM8:change RM9:change RM10:change RM11:change RM12:change
SC1:change SC2:retire SC3:change SC4:change SC5:change SC6:change SC7:change SC8:change SC9:change SC10:change SC11:retire SC12:change SC13:change SC14:change SC15:change SC16:change SC17:change SC18:change
SN1:change SN2:change SN3:change SN4:change SN5:change SN6:retire SN7:change
ST1:change ST2:change ST3:retire ST4:retire ST5:change ST6:retire ST7:change ST8:change ST9:change
T1:change T2:change T3:change T4:change T5:change T6:change T7:change T8:change T9:retire T10:change T11:change
`
  .trim()
  .split(/\s+/u);

const typescriptSurfaces = [
  ["e2e.test.ts", new URL("e2e.test.ts", import.meta.url)],
  [
    "selection.test.ts",
    new URL("../../kernel/src/selection.test.ts", import.meta.url),
  ],
  ["data.test.ts", new URL("data/data.test.ts", import.meta.url)],
  [
    "aggregation.test.ts",
    new URL("../../kernel/src/aggregation.test.ts", import.meta.url),
  ],
  [
    "core/src/store.test.ts",
    new URL("../../core/src/store.test.ts", import.meta.url),
  ],
  [
    "core/src/facts.test.ts",
    new URL("../../core/src/facts.test.ts", import.meta.url),
  ],
  [
    "contract-validation.test.ts",
    new URL("contract-validation.test.ts", import.meta.url),
  ],
  ["parity.test.ts", new URL("parity.test.ts", import.meta.url)],
  [
    "kernel/src/drift.test.ts",
    new URL("../../kernel/src/drift.test.ts", import.meta.url),
  ],
  [
    "diagnosis.test.ts",
    new URL("../../kernel/src/diagnosis.test.ts", import.meta.url),
  ],
  ["drift.test.ts", new URL("../../kernel/src/drift.test.ts", import.meta.url)],
  ["rightmodeler/drift.test.ts", new URL("drift.test.ts", import.meta.url)],
  [
    "apply/orchestrator.test.ts",
    new URL("apply/orchestrator.test.ts", import.meta.url),
  ],
  [
    "apply/difflint.test.ts",
    new URL("apply/difflint.test.ts", import.meta.url),
  ],
  [
    "apply/remediation.test.ts",
    new URL("apply/remediation.test.ts", import.meta.url),
  ],
  [
    "watch/aggregate.test.ts",
    new URL("watch/aggregate.test.ts", import.meta.url),
  ],
  ["gates.test.ts", new URL("../../kernel/src/gates.test.ts", import.meta.url)],
  [
    "statistics.test.ts",
    new URL("../../kernel/src/statistics.test.ts", import.meta.url),
  ],
  [
    "replay/src/index.test.ts",
    new URL("../../replay/src/index.test.ts", import.meta.url),
  ],
  [
    "replay/src/driver-modeb.test.ts",
    new URL("../../replay/src/driver-modeb.test.ts", import.meta.url),
  ],
  [
    "kernel/src/diagnosis.ts:139-143",
    new URL("../../kernel/src/diagnosis.ts", import.meta.url),
  ],
  [
    "kernel/src/diagnosis.ts:360-361",
    new URL("../../kernel/src/diagnosis.ts", import.meta.url),
  ],
  [
    "kernel/src/judge.test.ts",
    new URL("../../kernel/src/judge.test.ts", import.meta.url),
  ],
  [
    "replay/src/confirm.test.ts",
    new URL("../../replay/src/confirm.test.ts", import.meta.url),
  ],
  [
    "replay/src/proxy/proxy.test.ts",
    new URL("../../replay/src/proxy/proxy.test.ts", import.meta.url),
  ],
] as const;

interface CanonicalizationVector {
  readonly name: string;
  readonly value: JsonValue;
  readonly canonical: string;
  readonly sha256: string;
}

const canonicalizationVectors = parseVectors(
  JSON.parse(readFileSync(vectorsPath, "utf8")) as unknown,
);

describe("parity manifest", () => {
  it("keeps every E2 classification row bound to surviving TypeScript surfaces", () => {
    const manifest = readFileSync(manifestPath, "utf8");
    const rowLines = manifest
      .split("\n")
      .filter((line) => /^\|\s*[A-Z]+\d+\s*\|/u.test(line));
    const rows = rowLines.map((line) => {
      const match =
        /^\|\s*([A-Z]+\d+)\s*\|\s*(preserve|change|retire)\s*\|/u.exec(line);
      if (match === null) throw new TypeError(`Malformed parity row: ${line}`);
      return { id: match[1], classification: match[2], line };
    });

    expect(
      rows.map(({ id, classification }) => `${id}:${classification}`),
    ).toEqual(expectedManifestRows);
    expect(new Set(rows.map(({ id }) => id)).size).toBe(rows.length);
    expect(manifest).not.toMatch(/\|\s*(?:unclassified|todo|tbd)\s*\|/iu);

    for (const row of rows) {
      if (row.classification === "retire") {
        expect(row.line, `${row.id} must name its retired consumer`).toContain(
          "No consumer",
        );
      } else {
        expect(row.line, `${row.id} must cite TypeScript enforcement`).toMatch(
          /`[^`]+\.ts(?::\d+(?:-\d+)?)?`/u,
        );
      }
    }

    for (const [reference, surface] of typescriptSurfaces) {
      expect(
        manifest,
        `missing TypeScript enforcement reference ${reference}`,
      ).toContain(`\`${reference}\``);
      expect(
        existsSync(surface),
        `missing TypeScript surface ${reference}`,
      ).toBe(true);
    }
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
