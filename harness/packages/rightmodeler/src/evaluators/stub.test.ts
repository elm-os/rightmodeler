import { describe, expect, it } from "vitest";

const stubModuleUrl = new URL(
  "../../../../fixtures/eval-stub/server.mjs",
  import.meta.url,
).href;

interface StubServer {
  readonly port: number;
  close(): Promise<void>;
}

interface StubModule {
  startEvalStub(options: {
    port: number;
    pendingPolls?: number;
    fail?: boolean;
  }): Promise<StubServer>;
}

interface EventResult {
  readonly error?: { readonly message?: string };
  readonly scores?: Readonly<Record<string, number>>;
}

async function startStub(options: {
  pendingPolls?: number;
  fail?: boolean;
}): Promise<StubServer> {
  const module = (await import(stubModuleUrl)) as StubModule;
  return module.startEvalStub({ port: 0, ...options });
}

async function requestJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, init);
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function launch(baseUrl: string, name: string): Promise<string> {
  const created = await requestJson(`${baseUrl}/v1/experiment`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project_id: "00000000-0000-4000-8000-000000000001",
      name,
    }),
  });
  expect(created.status).toBe(200);
  const id = created.body.id;
  expect(typeof id).toBe("string");

  const inserted = await requestJson(
    `${baseUrl}/v1/experiment/${String(id)}/insert`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            id: "case-1",
            input: { prompt: "capital" },
            expected: "Paris",
            output: "Paris",
            metadata: { case_id: "case-1" },
          },
          {
            id: "case-2",
            input: { prompt: "capital" },
            expected: "Paris",
            output: "Parish",
            metadata: { case_id: "case-2" },
          },
        ],
      }),
    },
  );
  expect(inserted.status).toBe(200);
  expect(inserted.body.row_ids).toEqual(["case-1", "case-2"]);
  return String(id);
}

async function fetchEvents(
  baseUrl: string,
  experimentId: string,
): Promise<readonly EventResult[]> {
  const fetched = await requestJson(
    `${baseUrl}/v1/experiment/${experimentId}/fetch`,
  );
  expect(fetched.status).toBe(200);
  expect(Array.isArray(fetched.body.events)).toBe(true);
  return fetched.body.events as EventResult[];
}

describe("evaluator fixture", () => {
  it("keeps results pending for the configured polls and scores deterministically", async () => {
    const stub = await startStub({ pendingPolls: 2 });
    const baseUrl = `http://127.0.0.1:${stub.port}`;
    try {
      const firstId = await launch(baseUrl, "first");
      expect(await fetchEvents(baseUrl, firstId)).toEqual([
        expect.not.objectContaining({ scores: expect.anything() }),
        expect.not.objectContaining({ scores: expect.anything() }),
      ]);
      expect(await fetchEvents(baseUrl, firstId)).toEqual([
        expect.not.objectContaining({ scores: expect.anything() }),
        expect.not.objectContaining({ scores: expect.anything() }),
      ]);
      const firstScores = (await fetchEvents(baseUrl, firstId)).map(
        ({ scores }) => scores,
      );
      expect(firstScores[0]?.output_similarity).toBe(1);
      expect(firstScores[1]?.output_similarity).toBeLessThan(1);

      const secondId = await launch(baseUrl, "second");
      await fetchEvents(baseUrl, secondId);
      await fetchEvents(baseUrl, secondId);
      const secondScores = (await fetchEvents(baseUrl, secondId)).map(
        ({ scores }) => scores,
      );
      expect(secondScores).toEqual(firstScores);
    } finally {
      await stub.close();
    }
  });

  it("exposes the configured failed-experiment path", async () => {
    const stub = await startStub({ fail: true });
    const baseUrl = `http://127.0.0.1:${stub.port}`;
    try {
      const experimentId = await launch(baseUrl, "failed");
      const events = await fetchEvents(baseUrl, experimentId);
      expect(events).toEqual([
        expect.objectContaining({
          error: { message: "Seeded evaluator failure." },
        }),
        expect.objectContaining({
          error: { message: "Seeded evaluator failure." },
        }),
      ]);
      expect(events.every(({ scores }) => scores === undefined)).toBe(true);
    } finally {
      await stub.close();
    }
  });

  it("requires the documented project identifier when creating an experiment", async () => {
    const stub = await startStub({});
    const baseUrl = `http://127.0.0.1:${stub.port}`;
    try {
      const response = await requestJson(`${baseUrl}/v1/experiment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "missing-project" }),
      });
      expect(response).toEqual({
        status: 400,
        body: { error: "project_id is required." },
      });
    } finally {
      await stub.close();
    }
  });
});
