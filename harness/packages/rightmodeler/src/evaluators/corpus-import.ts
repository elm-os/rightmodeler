import {
  canonicalJson,
  caseKey,
  computeRunSpecDigest,
  type JsonValue,
  type Store,
} from "@rightmodeler/core";
import { assignSplits, type CorpusSplit } from "@rightmodeler/kernel";
import { z } from "zod";

import {
  apiRoot,
  environmentSecret,
  requireText,
  responseJson,
} from "./shared.js";

export type CorpusImportProvider = "braintrust" | "langfuse" | "langsmith";

export interface CorpusImportConfig {
  readonly provider: CorpusImportProvider;
  readonly dataset: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly publicKeyEnv?: string;
}

export interface ImportedCorpusCaseContent {
  readonly family: string;
  readonly model: string;
  readonly systemPrompt?: string;
  readonly messages: JsonValue[];
  readonly output: JsonValue;
  readonly trajectoryId: string;
  readonly stepIndex: number;
  readonly referenceSource: "curated";
  readonly referenceVerified: boolean;
  readonly referenceProvider: CorpusImportProvider;
  readonly referenceItemId: string;
}

export interface ImportedCorpusCase {
  readonly caseId: string;
  readonly content: ImportedCorpusCaseContent;
  readonly split: CorpusSplit;
}

export interface ImportedCorpus {
  readonly corpusVersionId: string;
  readonly seed: number;
  readonly cases: readonly ImportedCorpusCase[];
  readonly strata: readonly {
    readonly family: string;
    readonly corpusShare: number;
    readonly trafficShare: number;
  }[];
}

interface ProviderItem {
  readonly id: string;
  readonly input: JsonValue;
  readonly expected: JsonValue;
  readonly metadata: Readonly<Record<string, unknown>>;
}

const braintrustItemSchema = z.object({
  id: z.string().min(1),
  input: z.json(),
  expected: z.json(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
const braintrustPageSchema = z.object({
  events: z.array(braintrustItemSchema),
  cursor: z.string().nullable().optional(),
});
const langsmithItemSchema = z.object({
  id: z.string().min(1),
  inputs: z.json(),
  outputs: z.json(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
const langfuseItemSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["ACTIVE", "ARCHIVED"]),
  input: z.json(),
  expectedOutput: z.json(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
const langfusePageSchema = z.object({
  data: z.array(langfuseItemSchema),
  meta: z.object({
    page: z.number().int().positive(),
    totalPages: z.number().int().nonnegative(),
  }),
});

export async function importCorpus(
  config: CorpusImportConfig,
  options: { readonly seed: number },
): Promise<ImportedCorpus> {
  requireText(config.dataset, "Corpus import dataset");
  requireText(config.baseUrl, "Corpus import baseUrl");
  requireText(config.apiKeyEnv, "Corpus import apiKeyEnv");
  const items = await fetchProviderItems(config);
  if (items.length === 0) {
    throw new Error(
      `Cannot import an empty ${config.provider} dataset: ${config.dataset}`,
    );
  }
  const unique = new Map<string, ImportedCorpusCase>();
  for (const item of items) {
    const content = importedContent(config.provider, item);
    const caseId = computeRunSpecDigest(contentJson(content));
    unique.set(caseId, { caseId, content, split: "shortlist" });
  }
  const unsplitCases = [...unique.values()];
  const splits = assignSplits(
    unsplitCases.map(({ caseId }) => caseId),
    options.seed,
  );
  const cases = unsplitCases.map((item) => ({
    ...item,
    split: splits[item.caseId]!,
  }));
  cases.sort((left, right) => left.caseId.localeCompare(right.caseId));
  const counts = new Map<string, number>();
  for (const item of cases) {
    counts.set(item.content.family, (counts.get(item.content.family) ?? 0) + 1);
  }
  const strata = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([family, count]) => ({
      family,
      corpusShare: count / cases.length,
      trafficShare: count / cases.length,
    }));
  return {
    corpusVersionId: computeRunSpecDigest(cases.map(({ caseId }) => caseId)),
    seed: options.seed,
    cases,
    strata,
  };
}

export async function writeImportedCorpus(
  store: Store,
  projectId: string,
  corpus: ImportedCorpus,
): Promise<void> {
  for (const item of corpus.cases) {
    await store.putImmutable(
      caseKey(projectId, item.caseId),
      Buffer.from(canonicalJson(contentJson(item.content)), "utf8"),
    );
  }
  await store.putImmutable(
    `${projectId}/corpus/corpus-${corpus.corpusVersionId}.json`,
    Buffer.from(
      canonicalJson({
        corpusVersionId: corpus.corpusVersionId,
        seed: corpus.seed,
        cases: corpus.cases.map(({ caseId, content, split }) => ({
          caseId,
          family: content.family,
          split,
          referenceSource: content.referenceSource,
          referenceVerified: content.referenceVerified,
          referenceProvider: content.referenceProvider,
          referenceItemId: content.referenceItemId,
        })),
        strata: corpus.strata.map((item) => ({ ...item })),
      }),
      "utf8",
    ),
  );
}

async function fetchProviderItems(
  config: CorpusImportConfig,
): Promise<readonly ProviderItem[]> {
  const auth = providerAuth(config);
  const request = async (path: string): Promise<unknown> => {
    const response = await fetch(apiRoot(config.baseUrl, path), {
      headers: auth.headers,
    });
    return responseJson(
      response,
      `${providerName(config.provider)} corpus`,
      auth.secrets,
    );
  };
  switch (config.provider) {
    case "braintrust": {
      const latest = new Map<string, ProviderItem>();
      let cursor: string | undefined;
      do {
        const query = new URLSearchParams({ limit: "100" });
        if (cursor !== undefined) query.set("cursor", cursor);
        const page = braintrustPageSchema.parse(
          await request(
            `/v1/dataset/${encodeURIComponent(config.dataset)}/fetch?${query.toString()}`,
          ),
        );
        for (const event of page.events) {
          if (!latest.has(event.id)) {
            latest.set(event.id, {
              id: event.id,
              input: event.input,
              expected: event.expected,
              metadata: event.metadata,
            });
          }
        }
        cursor = page.cursor ?? undefined;
      } while (cursor !== undefined);
      return [...latest.values()];
    }
    case "langsmith": {
      const items: ProviderItem[] = [];
      let offset = 0;
      for (;;) {
        const query = new URLSearchParams({
          dataset: config.dataset,
          limit: "100",
          offset: String(offset),
        });
        const page = z
          .array(langsmithItemSchema)
          .parse(await request(`/api/v1/examples?${query.toString()}`));
        items.push(
          ...page.map((item) => ({
            id: item.id,
            input: item.inputs,
            expected: item.outputs,
            metadata: item.metadata,
          })),
        );
        if (page.length < 100) return items;
        offset += page.length;
      }
    }
    case "langfuse": {
      const items: ProviderItem[] = [];
      let pageNumber = 1;
      for (;;) {
        const query = new URLSearchParams({
          datasetName: config.dataset,
          page: String(pageNumber),
          limit: "100",
        });
        const page = langfusePageSchema.parse(
          await request(`/api/public/dataset-items?${query.toString()}`),
        );
        items.push(
          ...page.data.flatMap((item) =>
            item.status === "ARCHIVED"
              ? []
              : [
                  {
                    id: item.id,
                    input: item.input,
                    expected: item.expectedOutput,
                    metadata: item.metadata,
                  },
                ],
          ),
        );
        if (pageNumber >= page.meta.totalPages) return items;
        pageNumber += 1;
      }
    }
  }
}

function providerAuth(config: CorpusImportConfig): {
  readonly headers: Readonly<Record<string, string>>;
  readonly secrets: readonly string[];
} {
  const apiKey = environmentSecret(config.apiKeyEnv, "Corpus provider API key");
  if (config.provider === "langfuse") {
    if (config.publicKeyEnv === undefined) {
      throw new Error("Langfuse corpus import requires publicKeyEnv");
    }
    const publicKey = environmentSecret(
      config.publicKeyEnv,
      "Corpus provider public key",
    );
    const encoded = Buffer.from(`${publicKey}:${apiKey}`, "utf8").toString(
      "base64",
    );
    return {
      headers: { authorization: `Basic ${encoded}` },
      secrets: [publicKey, apiKey, encoded, `Basic ${encoded}`],
    };
  }
  return config.provider === "braintrust"
    ? {
        headers: { authorization: `Bearer ${apiKey}` },
        secrets: [apiKey],
      }
    : { headers: { "x-api-key": apiKey }, secrets: [apiKey] };
}

function importedContent(
  provider: CorpusImportProvider,
  item: ProviderItem,
): ImportedCorpusCaseContent {
  const input = objectValue(item.input);
  const messages = Array.isArray(input?.messages)
    ? input.messages.map((message) => z.json().parse(message))
    : [
        {
          role: "user",
          content:
            typeof item.input === "string"
              ? item.input
              : canonicalJson(item.input),
        },
      ];
  const systemPrompt =
    stringValue(input?.systemPrompt) ??
    stringValue(input?.system) ??
    stringValue(item.metadata.systemPrompt);
  return {
    family: stringValue(item.metadata.family) ?? "unclassified",
    model: stringValue(item.metadata.model) ?? "curated-reference",
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    messages,
    output: item.expected,
    trajectoryId: `${provider}:${item.id}`,
    stepIndex:
      typeof item.metadata.stepIndex === "number" &&
      Number.isSafeInteger(item.metadata.stepIndex) &&
      item.metadata.stepIndex >= 0
        ? item.metadata.stepIndex
        : 0,
    referenceSource: "curated",
    referenceVerified: item.metadata.reference_verified === true,
    referenceProvider: provider,
    referenceItemId: item.id,
  };
}

function contentJson(content: ImportedCorpusCaseContent): JsonValue {
  return {
    family: content.family,
    model: content.model,
    ...(content.systemPrompt === undefined
      ? {}
      : { systemPrompt: content.systemPrompt }),
    messages: content.messages,
    output: content.output,
    trajectoryId: content.trajectoryId,
    stepIndex: content.stepIndex,
    referenceSource: content.referenceSource,
    referenceVerified: content.referenceVerified,
    referenceProvider: content.referenceProvider,
    referenceItemId: content.referenceItemId,
  };
}

function objectValue(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function providerName(provider: CorpusImportProvider): string {
  return provider === "langsmith"
    ? "LangSmith"
    : provider === "langfuse"
      ? "Langfuse"
      : "Braintrust";
}
