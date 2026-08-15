import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, FsStore } from "@rightmodeler/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildCorpus,
  openAiJsonlAdapter,
  scrubRuns,
  writeCorpus,
} from "./data/index.js";
import {
  approveDriftProposal,
  publishDriftProposal,
  runDrift,
} from "./drift.js";
import {
  resolveCheckpointedPipelineCorpus,
  resolvePipelineCorpus,
} from "./pipeline.js";
import { writeCheckpoint } from "./state.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function record(model: string, prompt: string): Record<string, unknown> {
  return {
    case_id: "trace-1",
    timestamp: "2026-08-14T12:00:00.000Z",
    name: "support",
    model,
    messages: [{ role: "user", content: prompt }],
    response: {
      model,
      choices: [{ message: { role: "assistant", content: "resolved" } }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    },
  };
}

function runs(records: readonly Record<string, unknown>[]) {
  return scrubRuns(openAiJsonlAdapter.adapt(records)).runs;
}

describe("pipeline active corpus resolution", () => {
  it("selects the active version for corpus and keeps downstream stages on their checkpointed version", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-active-corpus-"));
    roots.push(root);
    const repo = join(root, "repo");
    const storeRoot = join(root, "store");
    await mkdir(repo);
    const store = new FsStore(storeRoot);
    const parentRuns = runs([record("acme/large-1", "old prompt")]);
    const parent = buildCorpus(parentRuns, { seed: 42 });
    await writeCorpus(store, "project", parent);
    const outputKey = "project/setup/corpus-active-fixture.json";
    await store.putImmutable(
      outputKey,
      Buffer.from(
        canonicalJson({
          corpusVersionId: parent.corpusVersionId,
          seed: parent.seed,
          caseCount: parent.cases.length,
          strata: parent.strata.map((stratum) => ({ ...stratum })),
        }),
        "utf8",
      ),
    );
    await writeCheckpoint(store, "project", "corpus", {
      inputDigest: "fixture",
      outputKey,
      completedAt: "2026-08-14T12:00:00.000Z",
    });

    const candidateRecords = [record("acme/small-1", "new prompt")];
    const tracePath = join(root, "candidate.jsonl");
    await writeFile(
      tracePath,
      candidateRecords.map((item) => JSON.stringify(item)).join("\n"),
      "utf8",
    );
    const proposed = await runDrift({
      repo,
      store: storeRoot,
      traces: tracePath,
    });
    await approveDriftProposal({
      repo,
      store: storeRoot,
      proposalId: proposed.proposal.proposal_id,
      actor: "reviewer",
    });
    const published = await publishDriftProposal({
      repo,
      store: storeRoot,
      proposalId: proposed.proposal.proposal_id,
    });

    const resolved = await resolvePipelineCorpus(
      { repo, store, storeRoot, projectId: "project" },
      parentRuns,
    );
    const checkpointed = await resolveCheckpointedPipelineCorpus({
      repo,
      store,
      storeRoot,
      projectId: "project",
    });
    const manifestEntry = await store.get(published.manifestKey);
    expect(manifestEntry).not.toBeNull();
    const manifest = JSON.parse(
      Buffer.from(manifestEntry!.body).toString("utf8"),
    ) as { cases: Array<{ case_id: string }> };

    expect(resolved.corpusVersionId).toBe(published.corpusVersionId);
    expect(resolved.cases.map(({ caseId }) => caseId)).toEqual(
      manifest.cases.map(({ case_id }) => case_id),
    );
    expect(resolved.cases.map(({ content }) => content.model)).toEqual([
      "acme/small-1",
    ]);
    expect(resolved.cases[0]?.observation?.usage.inputTokens).toBe(12);
    expect(checkpointed.corpusVersionId).toBe(parent.corpusVersionId);
    expect(checkpointed.cases.map(({ caseId }) => caseId)).toEqual(
      parent.cases.map(({ caseId }) => caseId),
    );
  });
});
