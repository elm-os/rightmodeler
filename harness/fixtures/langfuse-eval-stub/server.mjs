import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function attributes(span) {
  return Object.fromEntries(
    (span.attributes ?? []).map(({ key, value }) => [key, value?.stringValue]),
  );
}

function similarity(output, expected) {
  const left = JSON.stringify(output);
  const right = JSON.stringify(expected);
  const length = Math.max(left.length, right.length);
  if (length === 0) return 1;
  let matches = 0;
  for (let index = 0; index < length; index += 1) {
    if (left[index] === right[index]) matches += 1;
  }
  return matches / length;
}

export async function startLangfuseEvalStub({
  port,
  pendingPolls = 1,
  reflectAuthError = false,
  malformedDataset = false,
  malformedScores = false,
} = {}) {
  const experiments = new Map();
  const datasets = new Map([
    [
      "verified-cases",
      [
        {
          id: "langfuse-item-1",
          datasetId: "langfuse-dataset-1",
          datasetName: "verified-cases",
          status: "ACTIVE",
          input: { messages: [{ role: "user", content: "Capital?" }] },
          expectedOutput: "Paris",
          metadata: {
            reference_verified: true,
            family: "qa",
            model: "curated",
          },
          sourceTraceId: null,
          sourceObservationId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          mediaReferences: [],
        },
        {
          id: "langfuse-item-2",
          datasetId: "langfuse-dataset-1",
          datasetName: "verified-cases",
          status: "ACTIVE",
          input: { messages: [{ role: "user", content: "Unverified?" }] },
          expectedOutput: "Observed",
          metadata: { family: "qa", model: "curated" },
          sourceTraceId: null,
          sourceObservationId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          mediaReferences: [],
        },
      ],
    ],
  ]);
  const hits = [];
  const createdScores = [];

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let body;
    if (request.method === "POST") {
      try {
        body = await readJson(request);
      } catch {
        json(response, 400, { error: "Request body must be valid JSON." });
        return;
      }
    }
    hits.push({
      method: request.method ?? "UNKNOWN",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
    });

    if (request.method === "GET" && url.pathname === "/api/public/health") {
      json(response, 200, { status: "OK" });
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/public/otel/v1/traces"
    ) {
      if (reflectAuthError) {
        json(response, 500, {
          error: `Reflected credential: ${request.headers.authorization ?? "missing"}`,
        });
        return;
      }
      const spans = (body.resourceSpans ?? []).flatMap((resource) =>
        (resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []),
      );
      for (const span of spans) {
        const fields = attributes(span);
        const experimentId = fields["langfuse.experiment.id"];
        const experiment = experiments.get(experimentId) ?? {
          polls: 0,
          spans: [],
        };
        experiment.spans.push({ span, fields });
        experiments.set(experimentId, experiment);
      }
      json(response, 200, { partialSuccess: {} });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/public/v3/scores") {
      if (malformedScores) {
        json(response, 200, { data: "not-an-array", meta: {} });
        return;
      }
      const requestedTraces = new Set(
        (url.searchParams.get("traceId") ?? "").split(","),
      );
      const requestedNames = (url.searchParams.get("name") ?? "")
        .split(",")
        .filter(Boolean);
      const experiment = [...experiments.values()].find((candidate) =>
        candidate.spans.some(({ span }) => requestedTraces.has(span.traceId)),
      );
      if (experiment === undefined) {
        json(response, 200, { data: [], meta: { limit: 100, cursor: null } });
        return;
      }
      experiment.polls += 1;
      if (experiment.polls <= pendingPolls) {
        json(response, 200, { data: [], meta: { limit: 100, cursor: null } });
        return;
      }
      const data = experiment.spans.flatMap(({ span, fields }) => {
        if (!requestedTraces.has(span.traceId)) return [];
        const expected = JSON.parse(
          fields["langfuse.experiment.item.expected_output"] ?? "null",
        );
        const output = JSON.parse(
          fields["langfuse.observation.output"] ?? "null",
        );
        const score = similarity(output, expected);
        return requestedNames.map((name) => ({
          id: `${span.traceId}-${name}`,
          projectId: "langfuse-project-1",
          name,
          value: score,
          dataType: "NUMERIC",
          source: "EVAL",
          timestamp: "2026-01-01T00:00:00.000Z",
          environment: "default",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          metadata: {
            passed: score === 1,
            rubricVersion: "langfuse-stub-v1",
          },
          subject: {
            kind: "observation",
            id: span.spanId,
            traceId: span.traceId,
          },
        }));
      });
      json(response, 200, { data, meta: { limit: 100, cursor: null } });
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/api/public/dataset-items"
    ) {
      if (reflectAuthError) {
        json(response, 500, {
          error: `Reflected credential: ${request.headers.authorization ?? "missing"}`,
        });
        return;
      }
      if (malformedDataset) {
        json(response, 200, {
          data: "not-an-array",
          meta: { page: 1, totalPages: 1 },
        });
        return;
      }
      const items = datasets.get(url.searchParams.get("datasetName")) ?? [];
      json(response, 200, {
        data: items,
        meta: { page: 1, limit: 100, totalItems: items.length, totalPages: 1 },
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/public/scores") {
      if (reflectAuthError) {
        json(response, 500, {
          error: `Reflected credential: ${request.headers.authorization ?? "missing"}`,
        });
        return;
      }
      createdScores.push(body);
      json(response, 200, { id: `created-score-${createdScores.length}` });
      return;
    }

    json(response, 404, { error: "Not found." });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port ?? 0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    getHits: () => [...hits],
    getCreatedScores: () => [...createdScores],
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function selftest() {
  const stub = await startLangfuseEvalStub({ port: 0, pendingPolls: 1 });
  try {
    const baseUrl = `http://127.0.0.1:${stub.port}`;
    const health = await fetch(`${baseUrl}/api/public/health`);
    if (!health.ok)
      throw new Error("Expected health endpoint to be available.");
    const dataset = await fetch(
      `${baseUrl}/api/public/dataset-items?datasetName=verified-cases`,
    ).then((response) => response.json());
    if (dataset.data.length !== 2) {
      throw new Error("Expected deterministic dataset items.");
    }
    console.log("ok");
  } finally {
    await stub.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.includes("--selftest")) {
    await selftest();
  } else {
    const portIndex = process.argv.indexOf("--port");
    const stub = await startLangfuseEvalStub({
      port:
        portIndex === -1
          ? 0
          : Number.parseInt(process.argv[portIndex + 1] ?? "0", 10),
    });
    console.log(stub.port);
  }
}
