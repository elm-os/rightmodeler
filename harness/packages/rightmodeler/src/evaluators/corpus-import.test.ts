import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FsStore } from "@rightmodeler/core";
import { afterEach, describe, expect, it } from "vitest";

import { referenceCeilings } from "../data/audit.js";
import {
  importCorpus,
  writeImportedCorpus,
  type CorpusImportConfig,
} from "./corpus-import.js";

const braintrustStubUrl = new URL(
  "../../../../fixtures/eval-stub/server.mjs",
  import.meta.url,
).href;
const langfuseStubUrl = new URL(
  "../../../../fixtures/langfuse-eval-stub/server.mjs",
  import.meta.url,
).href;
const langsmithStubUrl = new URL(
  "../../../../fixtures/langsmith-eval-stub/server.mjs",
  import.meta.url,
).href;
const apiKeyEnv = "RIGHTMODELER_CORPUS_IMPORT_KEY";
const publicKeyEnv = "RIGHTMODELER_CORPUS_IMPORT_PUBLIC_KEY";
const apiKey = "corpus-import-key-canary-must-never-persist";
const publicKey = "corpus-import-public-canary-must-never-persist";

interface Stub {
  readonly port: number;
  close(): Promise<void>;
}

const openStubs: Stub[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env[apiKeyEnv];
  delete process.env[publicKeyEnv];
  await Promise.all(openStubs.splice(0).map((stub) => stub.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.each(["braintrust", "langsmith", "langfuse"] as const)(
  "%s corpus import",
  (provider) => {
    it("builds a content-addressed immutable corpus with verified provenance", async () => {
      const config = await startProvider(provider);
      const corpus = await importCorpus(config, { seed: 42 });

      expect(corpus.cases).toHaveLength(2);
      expect(new Set(corpus.cases.map(({ caseId }) => caseId)).size).toBe(2);
      expect(corpus.cases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            caseId: expect.any(String),
            split: expect.stringMatching(/^(shortlist|holdout)$/),
            content: expect.objectContaining({
              referenceSource: "curated",
              referenceProvider: provider,
            }),
          }),
        ]),
      );
      expect(
        corpus.cases.filter(({ content }) => content.referenceVerified),
      ).toHaveLength(1);
      const audit = {
        perFamily: {
          qa: {
            n: 10,
            disagreement: 0.2,
            wilsonLow: 0.05,
            wilsonHigh: 0.5,
            referenceAgreementPoint: 0.8,
          },
        },
      };
      const verifiedCeiling = referenceCeilings(
        corpus.cases.map(({ content }) => content),
        audit,
      )[0]!;
      const unverifiedCeiling = referenceCeilings(
        corpus.cases.map(({ content }) => ({
          ...content,
          referenceVerified: false,
        })),
        audit,
      )[0]!;
      expect(verifiedCeiling).toMatchObject({
        multiplier: 0.9,
        baseMultiplier: 0.8,
        baseSource: "audit",
        referenceCount: 2,
        verifiedCuratedReferences: 1,
      });
      expect(verifiedCeiling.multiplier).toBeGreaterThan(
        unverifiedCeiling.multiplier,
      );
      expect(unverifiedCeiling.multiplier).toBe(0.8);
      expect(JSON.stringify(corpus)).not.toContain(apiKey);
      expect(JSON.stringify(corpus)).not.toContain(publicKey);

      const root = await mkdtemp(join(tmpdir(), "rightmodeler-import-"));
      temporaryDirectories.push(root);
      const store = new FsStore(root);
      await writeImportedCorpus(store, "project", corpus);
      await writeImportedCorpus(store, "project", corpus);
      expect(await store.list("project/cases/")).toHaveLength(2);
      expect(await store.list("project/corpus/")).toEqual([
        `project/corpus/corpus-${corpus.corpusVersionId}.json`,
      ]);
    });

    it("redacts a provider-reflected credential from import errors", async () => {
      const config = await startProvider(provider, { reflectAuthError: true });

      const message = await importError(config);

      expect(message).toContain("[redacted]");
      expect(message).not.toContain(apiKey);
      expect(message).not.toContain(publicKey);
      if (provider === "langfuse") {
        expect(message).not.toContain(
          Buffer.from(`${publicKey}:${apiKey}`, "utf8").toString("base64"),
        );
      }
    });

    it("fails loudly when the provider returns a malformed dataset", async () => {
      const config = await startProvider(provider, { malformedDataset: true });

      await expect(importCorpus(config, { seed: 42 })).rejects.toThrow();
    });
  },
);

async function startProvider(
  provider: "braintrust" | "langsmith" | "langfuse",
  options: {
    readonly reflectAuthError?: boolean;
    readonly malformedDataset?: boolean;
  } = {},
): Promise<CorpusImportConfig> {
  process.env[apiKeyEnv] = apiKey;
  process.env[publicKeyEnv] = publicKey;
  if (provider === "braintrust") {
    const module = (await import(braintrustStubUrl)) as {
      startEvalStub(options: {
        port: number;
        reflectAuthError?: boolean;
        malformedDataset?: boolean;
      }): Promise<Stub>;
    };
    const stub = await module.startEvalStub({ port: 0, ...options });
    openStubs.push(stub);
    return {
      provider,
      dataset: "braintrust-dataset-1",
      baseUrl: `http://127.0.0.1:${stub.port}`,
      apiKeyEnv,
    };
  }
  if (provider === "langsmith") {
    const module = (await import(langsmithStubUrl)) as {
      startLangsmithEvalStub(options: {
        port: number;
        reflectAuthError?: boolean;
        malformedDataset?: boolean;
      }): Promise<Stub>;
    };
    const stub = await module.startLangsmithEvalStub({ port: 0, ...options });
    openStubs.push(stub);
    return {
      provider,
      dataset: "langsmith-dataset-1",
      baseUrl: `http://127.0.0.1:${stub.port}`,
      apiKeyEnv,
    };
  }
  const module = (await import(langfuseStubUrl)) as {
    startLangfuseEvalStub(options: {
      port: number;
      reflectAuthError?: boolean;
      malformedDataset?: boolean;
    }): Promise<Stub>;
  };
  const stub = await module.startLangfuseEvalStub({ port: 0, ...options });
  openStubs.push(stub);
  return {
    provider,
    dataset: "verified-cases",
    baseUrl: `http://127.0.0.1:${stub.port}`,
    apiKeyEnv,
    publicKeyEnv,
  };
}

async function importError(config: CorpusImportConfig): Promise<string> {
  try {
    await importCorpus(config, { seed: 42 });
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
