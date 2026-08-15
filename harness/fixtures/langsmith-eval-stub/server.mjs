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

export async function startLangsmithEvalStub({
  port,
  pendingPolls = 1,
  reflectAuthError = false,
  malformedDataset = false,
  malformedRuns = false,
  fail = false,
} = {}) {
  const sessions = new Map();
  const runs = new Map();
  const hits = [];
  let nextSession = 1;

  const datasetExamples = [
    {
      id: "langsmith-item-1",
      dataset_id: "langsmith-dataset-1",
      inputs: { messages: [{ role: "user", content: "Capital?" }] },
      outputs: "Paris",
      metadata: {
        reference_verified: true,
        family: "qa",
        model: "curated",
      },
      created_at: "2026-01-01T00:00:00.000Z",
      modified_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "langsmith-item-2",
      dataset_id: "langsmith-dataset-1",
      inputs: { messages: [{ role: "user", content: "Unverified?" }] },
      outputs: "Observed",
      metadata: { family: "qa", model: "curated" },
      created_at: "2026-01-01T00:00:00.000Z",
      modified_at: "2026-01-01T00:00:00.000Z",
    },
  ];

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let body;
    if (request.method === "POST" || request.method === "PATCH") {
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

    if (request.method === "GET" && url.pathname === "/api/v1/datasets") {
      json(response, 200, []);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/v1/examples") {
      if (reflectAuthError) {
        json(response, 500, {
          error: `Reflected credential: ${request.headers["x-api-key"] ?? "missing"}`,
        });
        return;
      }
      if (malformedDataset) {
        json(response, 200, { examples: "not-an-array" });
        return;
      }
      const dataset = url.searchParams.get("dataset");
      json(
        response,
        200,
        dataset === "langsmith-dataset-1" ? datasetExamples : [],
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/v1/sessions") {
      if (reflectAuthError) {
        json(response, 500, {
          error: `Reflected credential: ${request.headers["x-api-key"] ?? "missing"}`,
        });
        return;
      }
      if (typeof body.reference_dataset_id !== "string") {
        json(response, 400, { error: "reference_dataset_id is required." });
        return;
      }
      const id = `00000000-0000-4000-8000-${String(nextSession).padStart(12, "0")}`;
      nextSession += 1;
      sessions.set(id, {
        id,
        name: body.name,
        datasetId: body.reference_dataset_id,
        polls: 0,
        rules: [],
      });
      json(response, 200, { id, name: body.name });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/v1/runs") {
      runs.set(body.id, { ...body, outputs: null });
      json(response, 200, { id: body.id });
      return;
    }

    const runMatch = /^\/api\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (request.method === "PATCH" && runMatch !== null) {
      const run = runs.get(runMatch[1]);
      if (run === undefined) {
        json(response, 404, { error: "Run not found." });
        return;
      }
      runs.set(runMatch[1], { ...run, ...body });
      json(response, 200, { id: runMatch[1] });
      return;
    }

    const sessionMatch = /^\/api\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
    if (request.method === "PATCH" && sessionMatch !== null) {
      if (!sessions.has(sessionMatch[1])) {
        json(response, 404, { error: "Session not found." });
        return;
      }
      json(response, 200, { id: sessionMatch[1] });
      return;
    }

    const evaluateMatch =
      /^\/api\/v1\/runs\/experiments\/([^/]+)\/evaluate$/.exec(url.pathname);
    if (request.method === "POST" && evaluateMatch !== null) {
      const session = sessions.get(evaluateMatch[1]);
      if (session === undefined) {
        json(response, 404, { error: "Session not found." });
        return;
      }
      session.rules.push(body.rule_id);
      json(response, 200, {});
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/v1/runs/query") {
      if (malformedRuns) {
        json(response, 200, { runs: "not-an-array" });
        return;
      }
      const session = sessions.get(body.session?.[0]);
      if (session === undefined) {
        json(response, 200, { runs: [] });
        return;
      }
      session.polls += 1;
      const complete = session.polls > pendingPolls;
      const sessionRuns = [...runs.values()].filter(
        (run) => run.session_id === session.id,
      );
      json(response, 200, {
        runs: sessionRuns.map((run) => {
          const expected = run.extra?.metadata?.rightmodeler_expected;
          const score = similarity(run.outputs, expected);
          return {
            id: run.id,
            reference_example_id: run.reference_example_id,
            error: fail ? "Seeded evaluator failure." : null,
            feedback_stats:
              complete && !fail
                ? Object.fromEntries(
                    session.rules.map((rule) => [
                      rule,
                      {
                        avg: score,
                        pass: score === 1,
                        rubric_version: "langsmith-stub-v1",
                      },
                    ]),
                  )
                : {},
          };
        }),
      });
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
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function selftest() {
  const stub = await startLangsmithEvalStub({ port: 0 });
  try {
    const baseUrl = `http://127.0.0.1:${stub.port}`;
    const datasets = await fetch(`${baseUrl}/api/v1/datasets?limit=1`).then(
      (response) => response.json(),
    );
    if (!Array.isArray(datasets)) {
      throw new Error("Expected a deterministic dataset listing.");
    }
    const examples = await fetch(
      `${baseUrl}/api/v1/examples?dataset=langsmith-dataset-1`,
    ).then((response) => response.json());
    if (examples.length !== 2) {
      throw new Error("Expected deterministic dataset examples.");
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
    const stub = await startLangsmithEvalStub({
      port:
        portIndex === -1
          ? 0
          : Number.parseInt(process.argv[portIndex + 1] ?? "0", 10),
    });
    console.log(stub.port);
  }
}
