import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

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

function header(request, name) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function headerNumber(request, name) {
  const value = header(request, name);
  return value === undefined ? 0 : Number.parseInt(value, 10);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function completionFor(body) {
  const messageText = JSON.stringify(body.messages ?? []);
  const digest = createHash("sha256")
    .update(messageText)
    .digest("hex")
    .slice(0, 16);
  const content = `Deterministic reply ${digest} | café 🚀 漢字`;
  const promptTokens = Math.max(8, Math.ceil(messageText.length / 4));
  const completionTokens = 12;
  return {
    id: `fault-${digest}`,
    model: body.model,
    content,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

function streamEvent(completion, choices, usage = null) {
  return Buffer.from(
    `data: ${JSON.stringify({
      id: completion.id,
      object: "chat.completion.chunk",
      created: 1,
      model: completion.model,
      choices,
      usage,
    })}\n\n`,
  );
}

function canonicalStream(completion, includeUsage, dropUsage, errorEvent) {
  const fragments = [
    completion.content.slice(0, 9),
    completion.content.slice(9, 24),
    completion.content.slice(24),
  ];
  const events = [
    streamEvent(completion, [
      {
        index: 0,
        delta: { role: "assistant", content: "" },
        finish_reason: null,
      },
    ]),
  ];
  if (errorEvent) {
    events.push(
      Buffer.from(
        `data: ${JSON.stringify({ error: { message: "Injected stream error.", type: "server_error" } })}\n\n`,
      ),
    );
    return events;
  }

  for (const content of fragments) {
    events.push(
      streamEvent(completion, [
        {
          index: 0,
          delta: { content },
          finish_reason: null,
        },
      ]),
    );
  }
  events.push(
    streamEvent(completion, [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ]),
  );
  if (includeUsage && !dropUsage)
    events.push(streamEvent(completion, [], completion.usage));
  events.push(Buffer.from("data: [DONE]\n\n"));
  return events;
}

function seedNumber(seed) {
  return createHash("sha256").update(seed).digest().readUInt32LE(0) || 1;
}

function seededChunks(events, seed) {
  const bytes = Buffer.concat(events);
  const boundaries = new Set();
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] >= 0xc2 && bytes[index] <= 0xf4) {
      boundaries.add(index + 1);
      break;
    }
  }

  let state = seedNumber(seed);
  let offset = 0;
  while (offset < bytes.length) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    offset += 1 + ((state >>> 0) % 31);
    if (offset < bytes.length) boundaries.add(offset);
  }

  const chunks = [];
  let start = 0;
  for (const end of [...boundaries].sort((left, right) => left - right)) {
    chunks.push(bytes.subarray(start, end));
    start = end;
  }
  chunks.push(bytes.subarray(start));
  return chunks;
}

async function writeStream(response, chunks, resetAfter, stallMs) {
  const stallAfter = Math.max(1, Math.floor(chunks.length / 2));
  for (let index = 0; index < chunks.length; index += 1) {
    if (response.destroyed) return;
    response.write(chunks[index]);
    await nextTurn();
    if (resetAfter > 0 && index + 1 === resetAfter) {
      response.socket?.destroy();
      return;
    }
    if (stallMs > 0 && index + 1 === stallAfter) await sleep(stallMs);
  }
  response.end();
}

export async function startFaultServer({ port }) {
  const hits = new Map();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/__hits") {
      const key = url.searchParams.get("key") ?? "";
      json(response, 200, { key, hits: hits.get(key) ?? 0 });
      return;
    }

    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      json(response, 404, { error: { message: "Not found." } });
      return;
    }

    const key = header(request, "x-fault-key") ?? "";
    const hitCount = (hits.get(key) ?? 0) + 1;
    hits.set(key, hitCount);

    let body;
    try {
      body = await readJson(request);
    } catch {
      json(response, 400, {
        error: { message: "Request body must be valid JSON." },
      });
      return;
    }

    const slowHeadersMs = headerNumber(request, "x-fault-slow-headers-ms");
    if (slowHeadersMs > 0) await sleep(slowHeadersMs);

    const rateLimitTimes = headerNumber(request, "x-fault-429-times");
    if (hitCount <= rateLimitTimes) {
      json(
        response,
        429,
        { error: { message: "Injected rate limit." } },
        { "retry-after": "0" },
      );
      return;
    }

    const completion = completionFor(body);
    if (body.stream !== true) {
      json(response, 200, {
        id: completion.id,
        object: "chat.completion",
        created: 1,
        model: completion.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: completion.content },
            finish_reason: "stop",
          },
        ],
        usage: completion.usage,
      });
      return;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.flushHeaders();
    const events = canonicalStream(
      completion,
      body.stream_options?.include_usage === true,
      header(request, "x-fault-drop-usage") !== undefined,
      header(request, "x-fault-error-event") !== undefined,
    );
    const seed = header(request, "x-fault-chunk-seed");
    const chunks = seed === undefined ? events : seededChunks(events, seed);
    await writeStream(
      response,
      chunks,
      headerNumber(request, "x-fault-reset-after-chunks"),
      headerNumber(request, "x-fault-stall-ms"),
    );
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Fault server did not bind");
  return {
    port: address.port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

async function selftest() {
  const server = await startFaultServer({ port: 0 });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const request = {
    model: "fixture-model",
    messages: [{ role: "user", content: "Stable request." }],
    stream: false,
  };
  try {
    const first = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fault-key": "selftest",
      },
      body: JSON.stringify(request),
    }).then((result) => result.json());
    const second = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fault-key": "selftest",
      },
      body: JSON.stringify(request),
    }).then((result) => result.json());
    if (
      first.choices?.[0]?.message?.content !==
      second.choices?.[0]?.message?.content
    ) {
      throw new Error("Expected deterministic completions.");
    }

    const streaming = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fault-key": "selftest-stream",
        "x-fault-chunk-seed": "7",
      },
      body: JSON.stringify({
        ...request,
        stream: true,
        stream_options: { include_usage: true },
      }),
    }).then((result) => result.text());
    if (!streaming.includes("data: [DONE]"))
      throw new Error("Expected a complete stream.");

    const retryKey = "selftest-retry";
    const rateLimited = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fault-key": retryKey,
        "x-fault-429-times": "1",
      },
      body: JSON.stringify(request),
    });
    if (rateLimited.status !== 429)
      throw new Error("Expected an injected rate limit.");
    const hitCount = await fetch(`${baseUrl}/__hits?key=${retryKey}`).then(
      (result) => result.json(),
    );
    if (hitCount.hits !== 1) throw new Error("Expected one physical hit.");
    console.log("ok");
  } finally {
    await server.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.includes("--selftest")) await selftest();
}
