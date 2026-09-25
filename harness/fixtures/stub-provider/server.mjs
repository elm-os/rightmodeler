import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const models = [
  {
    id: "acme/small-1",
    context_length: 128_000,
    pricing: { prompt: "0.0000002", completion: "0.0000008" },
    top_provider: { context_length: 128_000, max_completion_tokens: 16_384 },
    supported_parameters: ["max_tokens", "temperature"],
  },
  {
    id: "acme/lite-1",
    context_length: 128_000,
    pricing: { prompt: "0.0000001", completion: "0.0000004" },
    top_provider: { context_length: 128_000, max_completion_tokens: 4_096 },
    supported_parameters: ["max_tokens", "temperature"],
  },
  {
    id: "acme/large-1",
    context_length: 128_000,
    pricing: { prompt: "0.000001", completion: "0.000003" },
    top_provider: { context_length: 128_000, max_completion_tokens: 16_384 },
    supported_parameters: ["max_tokens", "temperature"],
  },
  {
    id: "acme/max-1",
    context_length: 128_000,
    pricing: { prompt: "0.000002", completion: "0.000006" },
    top_provider: { context_length: 128_000, max_completion_tokens: 16_384 },
    supported_parameters: ["max_tokens", "temperature"],
  },
  {
    id: "zeta/judge-1",
    context_length: 128_000,
    pricing: { prompt: "0.000004", completion: "0.000012" },
    top_provider: { context_length: 128_000, max_completion_tokens: 16_384 },
    supported_parameters: ["structured_outputs"],
  },
  {
    id: "yotta/judge-2",
    context_length: 64_000,
    pricing: { prompt: "0.000002", completion: "0.000006" },
    top_provider: { context_length: 64_000, max_completion_tokens: 16_384 },
    supported_parameters: [],
  },
];

const freeModel = {
  id: "acme/free-1",
  context_length: 128_000,
  pricing: { prompt: "0", completion: "0" },
  top_provider: { context_length: 128_000, max_completion_tokens: 16_384 },
  supported_parameters: ["max_tokens", "temperature"],
};

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startStubProvider({
  port,
  bareModelIds = false,
  catalogPageSize,
  catalogTotalCount,
  errorModels = [],
  includeFreeModel = false,
  malformedJudgeModels = [],
  omitCatalogModels = [],
  rateLimitedModels = [],
  rateLimitMessageIncludes,
  servedModels = {},
  responseHeaders: chatResponseHeaders = {},
}) {
  const errorBodyKeys = new Set();
  const rateLimitedKeys = new Set();
  const failingModels = new Set(errorModels);
  const malformedJudges = new Set(malformedJudgeModels);
  const omittedCatalogModels = new Set(omitCatalogModels);
  const persistentlyRateLimitedModels = new Set(rateLimitedModels);
  const catalogModels = (includeFreeModel ? [...models, freeModel] : models)
    .filter(({ id }) => !omittedCatalogModels.has(id))
    .map((model) =>
      bareModelIds && model.id.startsWith("acme/")
        ? { ...model, id: model.id.slice("acme/".length) }
        : model,
    );
  let hitCount = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const requests = [];
  const requestHeaders = [];
  const server = createServer(async (request, response) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    response.once("close", () => {
      inFlight -= 1;
    });
    const url = new URL(request.url, "http://127.0.0.1");
    const received = {
      method: request.method,
      path: url.pathname,
      headers: { ...request.headers },
    };
    requestHeaders.push(received);
    if (request.method === "GET" && url.pathname === "/v1/models") {
      const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
      const page =
        catalogPageSize === undefined
          ? catalogModels.slice(offset)
          : catalogModels.slice(offset, offset + catalogPageSize);
      json(response, 200, {
        object: "list",
        data: page,
        total_count: catalogTotalCount ?? catalogModels.length,
        links: {
          next:
            offset + page.length < catalogModels.length
              ? `/v1/models?offset=${offset + page.length}`
              : null,
        },
      });
      return;
    }

    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      hitCount += 1;
      const hitHeaders = {
        ...chatResponseHeaders,
        "x-stub-hit-count": String(hitCount),
      };
      let body;
      try {
        body = await readJson(request);
      } catch {
        json(
          response,
          400,
          {
            error: { message: "Request body must be valid JSON." },
          },
          hitHeaders,
        );
        return;
      }
      requests.push(body);
      if (typeof body?.model === "string") received.model = body.model;

      if (!Array.isArray(body.messages)) {
        json(
          response,
          400,
          { error: { message: "messages must be an array." } },
          hitHeaders,
        );
        return;
      }
      for (const [index, message] of body.messages.entries()) {
        if (
          typeof message !== "object" ||
          message === null ||
          Array.isArray(message)
        ) {
          json(
            response,
            400,
            { error: { message: `messages[${index}] must be an object.` } },
            hitHeaders,
          );
          return;
        }
        if (Object.hasOwn(message, "parts")) {
          json(
            response,
            400,
            {
              error: {
                message: `messages[${index}].parts is not a wire field; use content.`,
              },
            },
            hitHeaders,
          );
          return;
        }
        if (typeof message.role !== "string") {
          json(
            response,
            400,
            { error: { message: `messages[${index}].role must be a string.` } },
            hitHeaders,
          );
          return;
        }
        if (typeof message.content !== "string") {
          json(
            response,
            400,
            {
              error: {
                message: `messages[${index}].content must be a string.`,
              },
            },
            hitHeaders,
          );
          return;
        }
      }
      const messageText = JSON.stringify(body.messages ?? []);

      if (request.headers["x-stub-echo-auth"] !== undefined) {
        json(
          response,
          400,
          {
            error: {
              message: `Received authorization: ${request.headers.authorization ?? "missing"}`,
            },
          },
          {
            ...hitHeaders,
            "x-stub-reflected-auth": request.headers.authorization ?? "missing",
          },
        );
        return;
      }
      if (failingModels.has(body.model)) {
        json(
          response,
          400,
          {
            error: {
              message: `Model ${body.model} rejected authorization ${request.headers.authorization ?? "missing"}.`,
            },
          },
          hitHeaders,
        );
        return;
      }
      const rateLimitKey = request.headers["x-stub-429-once"];
      if (
        typeof rateLimitKey === "string" &&
        !rateLimitedKeys.has(rateLimitKey)
      ) {
        rateLimitedKeys.add(rateLimitKey);
        json(
          response,
          429,
          { error: { message: "Stub rate limit." } },
          { ...hitHeaders, "retry-after": "0" },
        );
        return;
      }
      if (persistentlyRateLimitedModels.has(body.model)) {
        json(
          response,
          429,
          { error: { message: "Stub rate limit." } },
          { ...hitHeaders, "retry-after": "0" },
        );
        return;
      }
      if (
        typeof rateLimitMessageIncludes === "string" &&
        messageText.includes(rateLimitMessageIncludes)
      ) {
        json(
          response,
          429,
          { error: { message: "Stub rate limit." } },
          { ...hitHeaders, "retry-after": "0" },
        );
        return;
      }

      const holdMs = Number.parseInt(
        request.headers["x-stub-hold-before-response-ms"] ?? "0",
        10,
      );
      if (holdMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        if (response.destroyed) return;
      }

      if (
        body.stream === true &&
        request.headers["x-stub-enable-streaming"] === undefined
      ) {
        json(
          response,
          400,
          {
            error: {
              message:
                "Streaming is not supported by the Phase A stub provider.",
            },
          },
          hitHeaders,
        );
        return;
      }

      const judgeModel =
        body.model === "zeta/judge-1" || body.model === "yotta/judge-2";
      if (judgeModel && messageText.includes("STUB_JUDGE_PROVIDER_ERROR")) {
        json(
          response,
          500,
          { error: { message: "Stub judge provider failure." } },
          { ...hitHeaders, "retry-after": "0" },
        );
        return;
      }
      const digest = createHash("sha256")
        .update(messageText)
        .digest("hex")
        .slice(0, 16);
      const errorBodyKey = request.headers["x-stub-error-body-once"];
      if (
        typeof errorBodyKey === "string" &&
        !errorBodyKeys.has(errorBodyKey)
      ) {
        errorBodyKeys.add(errorBodyKey);
        json(
          response,
          200,
          {
            id: `stub-${digest}`,
            object: "chat.completion",
            model: body.model,
            error: {
              code: 502,
              message: "Stub upstream failed after generation started.",
              metadata: { error_type: "provider_error" },
            },
          },
          { ...hitHeaders, "retry-after": "0" },
        );
        return;
      }
      const answeredModel = servedModels[body.model] ?? body.model;
      const promptTokens = Math.max(8, Math.ceil(messageText.length / 4));
      const empty = request.headers["x-stub-empty"] !== undefined;
      const completionTokens = empty ? 0 : 12;
      const judgeVerdict =
        messageText.includes("STUB_JUDGE_DISAGREEMENT") &&
        Number.parseInt(digest[0], 16) % 2 === 0
          ? "divergent"
          : "equivalent";
      const content = judgeModel
        ? malformedJudges.has(body.model)
          ? '{"verdict":'
          : messageText.includes("STUB_JUDGE_EMPTY_OUTPUT")
            ? ""
            : messageText.includes("STUB_JUDGE_TRUNCATED_JSON")
              ? '{"verdict":"equivalent"'
              : messageText.includes("STUB_JUDGE_NON_JSON")
                ? "The candidate appears equivalent."
                : body.model === "zeta/judge-1" &&
                    body.response_format?.type !== "json_schema"
                  ? "A structured judge request requires response_format."
                  : body.model === "yotta/judge-2" &&
                      !messageText.includes("Return strict JSON only")
                    ? "An unstructured judge requires an explicit JSON instruction."
                    : JSON.stringify({
                        verdict: judgeVerdict,
                        score: judgeVerdict === "equivalent" ? 1 : 0,
                        justification: `Deterministic judge result ${digest}.`,
                      })
        : `Deterministic reply ${digest}`;
      if (body.stream === true) {
        const streamContent =
          request.headers["x-stub-large-stream"] === undefined
            ? `${content} snowman: ☃`
            : "x".repeat(1_200_000);
        const midpoint = Math.floor(streamContent.length / 2);
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          ...hitHeaders,
        });
        const streamParts = [
          streamContent.slice(0, midpoint),
          streamContent.slice(midpoint),
        ];
        for (const [index, part] of streamParts.entries()) {
          response.write(
            `data: ${JSON.stringify({
              id: `stub-${digest}`,
              object: "chat.completion.chunk",
              model: answeredModel,
              choices: [
                {
                  index: 0,
                  delta: { content: part },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          );
          const stallMs = Number.parseInt(
            request.headers["x-stub-stall-stream-ms"] ?? "0",
            10,
          );
          if (index === 0 && stallMs > 0) {
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, stallMs);
              response.once("close", () => {
                clearTimeout(timer);
                resolve(undefined);
              });
            });
            if (response.destroyed) return;
          }
        }
        if (request.headers["x-stub-truncate-stream"] !== undefined) {
          response.end();
          return;
        }
        response.write(
          `data: ${JSON.stringify({
            id: `stub-${digest}`,
            object: "chat.completion.chunk",
            model: answeredModel,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            },
          })}\n\n`,
        );
        if (request.headers["x-stub-finish-without-sentinel"] !== undefined) {
          response.end();
          return;
        }
        response.end("data: [DONE]\n\n");
        return;
      }
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      };
      if (request.headers["x-stub-echo-auth-in-usage"] !== undefined) {
        usage.fixture_authorization =
          request.headers.authorization ?? "missing";
      }
      const responseBody = {
        id: `stub-${digest}`,
        object: "chat.completion",
        model: answeredModel,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: empty ? "" : content,
            },
            finish_reason: "stop",
          },
        ],
        usage,
      };
      const responseHeaders =
        request.headers["x-stub-echo-auth-in-usage"] === undefined
          ? hitHeaders
          : {
              ...hitHeaders,
              "x-stub-reflected-auth":
                request.headers.authorization ?? "missing",
            };
      if (request.headers["x-stub-empty-body"] !== undefined) {
        response.writeHead(200, {
          "content-type": "application/json",
          ...responseHeaders,
        });
        response.end();
        return;
      }
      if (request.headers["x-stub-truncated-json"] !== undefined) {
        const serialized = JSON.stringify(responseBody);
        response.writeHead(200, {
          "content-type": "application/json",
          ...responseHeaders,
        });
        response.end(serialized.slice(0, Math.floor(serialized.length / 2)));
        return;
      }
      json(response, 200, responseBody, responseHeaders);
      return;
    }

    json(response, 404, { error: { message: "Not found." } });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const address = server.address();
  return {
    port: address.port,
    getHitCount: () => hitCount,
    getMaxInFlight: () => maxInFlight,
    getRequests: () => requests.map((request) => structuredClone(request)),
    getRequestHeaders: () => structuredClone(requestHeaders),
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function selftest() {
  const stub = await startStubProvider({ port: 0 });
  const baseUrl = `http://127.0.0.1:${stub.port}`;
  try {
    const catalog = await fetch(`${baseUrl}/v1/models`).then((response) =>
      response.json(),
    );
    if (catalog.data?.length !== 6) throw new Error("Expected six models.");

    const request = {
      model: "acme/small-1",
      messages: [{ role: "user", content: "Summarize a stable replay." }],
      stream: false,
    };
    const first = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-route": "selftest" },
      body: JSON.stringify(request),
    }).then((response) => response.json());
    const recorded = stub.getRequestHeaders().at(-1);
    if (
      recorded?.headers["x-route"] !== "selftest" ||
      recorded.model !== request.model
    ) {
      throw new Error(
        "Expected the chat request headers and model to be recorded.",
      );
    }
    const second = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    }).then((response) => response.json());
    if (
      first.choices?.[0]?.message?.content !==
      second.choices?.[0]?.message?.content
    ) {
      throw new Error("Expected deterministic completions.");
    }

    const streaming = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, stream: true }),
    });
    if (streaming.status !== 400)
      throw new Error("Expected streaming to be rejected.");

    const faultStub = await startStubProvider({
      port: 0,
      omitCatalogModels: ["acme/large-1"],
      rateLimitedModels: ["zeta/judge-1"],
    });
    const faultBaseUrl = `http://127.0.0.1:${faultStub.port}`;
    try {
      const faultCatalog = await fetch(`${faultBaseUrl}/v1/models`).then(
        (response) => response.json(),
      );
      if (faultCatalog.data?.some(({ id }) => id === "acme/large-1")) {
        throw new Error("Expected the omitted model to be absent.");
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const rateLimited = await fetch(`${faultBaseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...request, model: "zeta/judge-1" }),
        });
        if (rateLimited.status !== 429) {
          throw new Error("Expected the judge model to remain rate limited.");
        }
      }
      const fallback = await fetch(`${faultBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...request, model: "yotta/judge-2" }),
      });
      if (fallback.status !== 200) {
        throw new Error(
          "Expected the fallback judge model to remain available.",
        );
      }
    } finally {
      await faultStub.close();
    }

    const substitutingStub = await startStubProvider({
      port: 0,
      servedModels: { "acme/small-1": "acme/large-1" },
      responseHeaders: { "x-portkey-cache-status": "HIT" },
    });
    try {
      const substituted = await fetch(
        `http://127.0.0.1:${substitutingStub.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        },
      );
      if ((await substituted.json()).model !== "acme/large-1") {
        throw new Error("Expected the configured served model.");
      }
      if (substituted.headers.get("x-portkey-cache-status") !== "HIT") {
        throw new Error("Expected the configured response header.");
      }
    } finally {
      await substitutingStub.close();
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
  if (process.argv.includes("--selftest")) await selftest();
}
