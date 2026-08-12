import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const models = [
  {
    id: "acme/small-1",
    object: "model",
    capabilities: { chat: true, tools: true },
    pricing: { input_per_token: 0.0000002, output_per_token: 0.0000008 },
  },
  {
    id: "acme/lite-1",
    object: "model",
    capabilities: { chat: true, tools: false },
    pricing: { input_per_token: 0.0000001, output_per_token: 0.0000004 },
  },
  {
    id: "acme/large-1",
    object: "model",
    capabilities: { chat: true, tools: true },
    pricing: { input_per_token: 0.000001, output_per_token: 0.000003 },
  },
  {
    id: "acme/max-1",
    object: "model",
    capabilities: { chat: true, tools: true },
    pricing: { input_per_token: 0.000002, output_per_token: 0.000006 },
  },
];

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

export async function startStubProvider({ port }) {
  const rateLimitedKeys = new Set();
  let hitCount = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      json(response, 200, { object: "list", data: models });
      return;
    }

    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      hitCount += 1;
      const hitHeaders = { "x-stub-hit-count": String(hitCount) };
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

      if (body.stream === true) {
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

      const messageText = JSON.stringify(body.messages ?? []);
      const digest = createHash("sha256")
        .update(messageText)
        .digest("hex")
        .slice(0, 16);
      const promptTokens = Math.max(8, Math.ceil(messageText.length / 4));
      const empty = request.headers["x-stub-empty"] !== undefined;
      const completionTokens = empty ? 0 : 12;
      json(
        response,
        200,
        {
          id: `stub-${digest}`,
          object: "chat.completion",
          model: body.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: empty ? "" : `Deterministic reply ${digest}`,
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        },
        hitHeaders,
      );
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
    if (catalog.data?.length !== 4) throw new Error("Expected four models.");

    const request = {
      model: "acme/small-1",
      messages: [{ role: "user", content: "Summarize a stable replay." }],
      stream: false,
    };
    const first = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    }).then((response) => response.json());
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
