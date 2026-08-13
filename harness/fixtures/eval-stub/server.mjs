import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const METRIC_NAME = "output_similarity";
const RUBRIC_VERSION = "stub-similarity-v1";

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

function runState(experiment) {
  if (experiment.fail) return "failed";
  return experiment.polls <= experiment.pendingPolls ? "pending" : "complete";
}

function fetchedEvents(experiment) {
  const state = runState(experiment);
  return experiment.events.flatMap((event) => {
    if (event.id === experiment.omitCaseId) return [];
    if (state === "failed") {
      return [{ ...event, error: { message: "Seeded evaluator failure." } }];
    }
    if (state !== "complete") return [event];
    const score = similarity(event.output, event.expected);
    const scorers = Array.isArray(event.metadata.scorers)
      ? event.metadata.scorers.filter(
          (scorer) => typeof scorer === "string" && scorer.length > 0,
        )
      : [];
    const metricNames = scorers.length === 0 ? [METRIC_NAME] : scorers;
    const scores = Object.fromEntries(
      metricNames.map((metricName) => [metricName, score]),
    );
    const passDecisions = experiment.platformPassDecisions
      ? Object.fromEntries(
          metricNames.map((metricName) => [metricName, score === 1]),
        )
      : undefined;
    const rubricVersions = Object.fromEntries(
      metricNames.map((metricName) => [metricName, RUBRIC_VERSION]),
    );
    return [
      {
        ...event,
        scores,
        metadata: {
          ...event.metadata,
          ...(passDecisions === undefined
            ? {}
            : { pass_decisions: passDecisions }),
          rubric_versions: rubricVersions,
          ...(metricNames.length === 1 && experiment.platformPassDecisions
            ? { rubric_version: RUBRIC_VERSION, passed: score === 1 }
            : {}),
        },
      },
    ];
  });
}

export async function startEvalStub({
  port,
  pendingPolls = 1,
  fail = false,
  omitCaseId,
  reflectAuthError = false,
  malformedFetch = false,
  platformPassDecisions = true,
}) {
  const experiments = new Map();
  const hits = new Map();
  let nextExperiment = 1;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const hitKey = `${request.method ?? "UNKNOWN"} ${url.pathname}`;
    hits.set(hitKey, (hits.get(hitKey) ?? 0) + 1);

    if (request.method === "GET" && url.pathname === "/v1/project") {
      json(response, 200, { objects: [] });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/experiment") {
      if (reflectAuthError) {
        json(response, 500, {
          error: `Reflected credential: ${request.headers.authorization ?? "missing"}`,
        });
        return;
      }
      let body;
      try {
        body = await readJson(request);
      } catch {
        json(response, 400, { error: "Request body must be valid JSON." });
        return;
      }
      if (typeof body.project_id !== "string" || body.project_id.length === 0) {
        json(response, 400, { error: "project_id is required." });
        return;
      }
      const id = `00000000-0000-4000-8000-${String(nextExperiment).padStart(12, "0")}`;
      nextExperiment += 1;
      const experiment = {
        id,
        projectId: body.project_id,
        name: typeof body.name === "string" ? body.name : id,
        events: [],
        polls: 0,
        pendingPolls,
        fail,
        omitCaseId,
        malformedFetch,
        platformPassDecisions,
      };
      experiments.set(id, experiment);
      json(response, 200, {
        id,
        project_id: experiment.projectId,
        name: experiment.name,
        public: false,
        created: "2026-01-01T00:00:00.000Z",
        metadata: {},
        tags: [],
      });
      return;
    }

    const match = /^\/v1\/experiment\/([^/]+)\/(insert|fetch|summarize)$/.exec(
      url.pathname,
    );
    if (match === null) {
      json(response, 404, { error: "Not found." });
      return;
    }
    const experiment = experiments.get(match[1]);
    if (experiment === undefined) {
      json(response, 404, { error: "Experiment not found." });
      return;
    }

    if (request.method === "POST" && match[2] === "insert") {
      let body;
      try {
        body = await readJson(request);
      } catch {
        json(response, 400, { error: "Request body must be valid JSON." });
        return;
      }
      if (!Array.isArray(body.events)) {
        json(response, 400, { error: "events must be an array." });
        return;
      }
      experiment.events = body.events.map((event, index) => ({
        id:
          typeof event.id === "string"
            ? event.id
            : createHash("sha256")
                .update(`${experiment.id}:${index}`)
                .digest("hex"),
        experiment_id: experiment.id,
        input: event.input ?? null,
        expected: event.expected ?? null,
        output: event.output ?? null,
        metadata: event.metadata ?? {},
        is_root: true,
      }));
      json(response, 200, {
        row_ids: experiment.events.map(({ id }) => id),
      });
      return;
    }

    if (
      (request.method === "GET" || request.method === "POST") &&
      match[2] === "fetch"
    ) {
      if (experiment.malformedFetch) {
        json(response, 200, { events: "not-an-array" });
        return;
      }
      experiment.polls += 1;
      json(response, 200, { events: fetchedEvents(experiment) });
      return;
    }

    if (request.method === "GET" && match[2] === "summarize") {
      const events = fetchedEvents(experiment);
      const scores = events.flatMap((event) =>
        typeof event.scores?.[METRIC_NAME] === "number"
          ? [event.scores[METRIC_NAME]]
          : [],
      );
      json(response, 200, {
        project_name: "rightmodeler-stub",
        experiment_name: experiment.name,
        project_url: `http://127.0.0.1/projects/${experiment.projectId}`,
        experiment_url: `http://127.0.0.1/experiments/${experiment.id}`,
        comparison_experiment_name: null,
        scores:
          scores.length === 0
            ? {}
            : {
                [METRIC_NAME]: {
                  score:
                    scores.reduce((total, score) => total + score, 0) /
                    scores.length,
                },
              },
        metrics: {},
      });
      return;
    }

    json(response, 405, { error: "Method not allowed." });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    port: address.port,
    getHitCount: (method, path) => hits.get(`${method} ${path}`) ?? 0,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function createExperiment(baseUrl, name) {
  const response = await fetch(`${baseUrl}/v1/experiment`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project_id: "00000000-0000-4000-8000-000000000001",
      name,
    }),
  });
  if (!response.ok) throw new Error(`Create failed with ${response.status}.`);
  return response.json();
}

async function insertCases(baseUrl, experimentId, events) {
  const response = await fetch(
    `${baseUrl}/v1/experiment/${experimentId}/insert`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events }),
    },
  );
  if (!response.ok) throw new Error(`Insert failed with ${response.status}.`);
}

async function fetchEvents(baseUrl, experimentId) {
  const response = await fetch(
    `${baseUrl}/v1/experiment/${experimentId}/fetch`,
  );
  if (!response.ok) throw new Error(`Fetch failed with ${response.status}.`);
  return response.json();
}

async function selftest() {
  const stub = await startEvalStub({ port: 0, pendingPolls: 2 });
  const baseUrl = `http://127.0.0.1:${stub.port}`;
  try {
    const events = [
      {
        id: "case-1",
        input: { prompt: "capital" },
        expected: "Paris",
        output: "Paris",
        metadata: {
          case_id: "case-1",
          scorers: [METRIC_NAME, "secondary_similarity"],
        },
      },
      {
        id: "case-2",
        input: { prompt: "capital" },
        expected: "Paris",
        output: "Parish",
        metadata: {
          case_id: "case-2",
          scorers: [METRIC_NAME, "secondary_similarity"],
        },
      },
    ];
    const first = await createExperiment(baseUrl, "selftest-one");
    await insertCases(baseUrl, first.id, events);
    for (let poll = 0; poll < 2; poll += 1) {
      const pending = await fetchEvents(baseUrl, first.id);
      if (pending.events.some((event) => event.scores !== undefined)) {
        throw new Error("Expected the configured pending lifecycle.");
      }
    }
    const complete = await fetchEvents(baseUrl, first.id);
    if (complete.events[0]?.scores?.[METRIC_NAME] !== 1) {
      throw new Error("Expected an exact match to score 1.");
    }
    if (complete.events[0]?.scores?.secondary_similarity !== 1) {
      throw new Error("Expected every configured scorer to complete.");
    }

    const second = await createExperiment(baseUrl, "selftest-two");
    await insertCases(baseUrl, second.id, events);
    await fetchEvents(baseUrl, second.id);
    await fetchEvents(baseUrl, second.id);
    const repeated = await fetchEvents(baseUrl, second.id);
    if (
      JSON.stringify(complete.events.map((event) => event.scores)) !==
      JSON.stringify(repeated.events.map((event) => event.scores))
    ) {
      throw new Error("Expected deterministic scores.");
    }

    const summary = await fetch(
      `${baseUrl}/v1/experiment/${first.id}/summarize?summarize_scores=true`,
    ).then((response) => response.json());
    if (typeof summary.scores?.[METRIC_NAME]?.score !== "number") {
      throw new Error("Expected a score summary.");
    }
    console.log("ok");
  } finally {
    await stub.close();
  }

  const failingStub = await startEvalStub({
    port: 0,
    pendingPolls: 0,
    fail: true,
  });
  const failingBaseUrl = `http://127.0.0.1:${failingStub.port}`;
  try {
    const experiment = await createExperiment(failingBaseUrl, "selftest-fail");
    await insertCases(failingBaseUrl, experiment.id, [
      {
        id: "failed-case",
        input: "input",
        expected: "expected",
        output: "output",
      },
    ]);
    const failed = await fetchEvents(failingBaseUrl, experiment.id);
    if (failed.events[0]?.error?.message !== "Seeded evaluator failure.") {
      throw new Error("Expected the seeded failure state.");
    }
  } finally {
    await failingStub.close();
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
    const pendingIndex = process.argv.indexOf("--pending-polls");
    const stub = await startEvalStub({
      port:
        portIndex === -1
          ? 0
          : Number.parseInt(process.argv[portIndex + 1] ?? "0", 10),
      pendingPolls:
        pendingIndex === -1
          ? 1
          : Number.parseInt(process.argv[pendingIndex + 1] ?? "1", 10),
      fail: process.argv.includes("--fail"),
    });
    console.log(stub.port);
  }
}
