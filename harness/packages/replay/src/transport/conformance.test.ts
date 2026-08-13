import { createHash } from "node:crypto";

import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  classifyStream,
  CONTENT_SPOOL_THRESHOLD_BYTES,
  type StreamSpoolSink,
} from "./stream.js";

interface FaultServer {
  port: number;
  close(): Promise<void>;
}

interface FaultServerModule {
  startFaultServer(options: { port: number }): Promise<FaultServer>;
}

const faultModuleUrl = new URL(
  "../../../../fixtures/fault-server/server.mjs",
  import.meta.url,
).href;
const messages = [
  { role: "user" as const, content: "Exercise the streaming transport." },
];

function expectedContent(): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(messages))
    .digest("hex")
    .slice(0, 16);
  return `Deterministic reply ${digest} | café 🚀 漢字`;
}

function directStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
}

describe("OpenAI transport conformance", () => {
  let server: FaultServer;
  let client: OpenAI;

  beforeEach(async () => {
    const fixture = (await import(faultModuleUrl)) as FaultServerModule;
    server = await fixture.startFaultServer({ port: 0 });
    client = new OpenAI({
      apiKey: "fixture-key",
      baseURL: `http://127.0.0.1:${server.port}/v1`,
    });
  });

  afterEach(async () => {
    await server.close();
  });

  async function rawStream(headers: Record<string, string>) {
    const response = await client.chat.completions
      .create(
        {
          model: "fixture-model",
          messages,
          stream: true,
          stream_options: { include_usage: true },
        },
        { headers },
      )
      .asResponse();
    if (response.body === null) throw new Error("Expected a response body");
    return { response, body: response.body };
  }

  it("reassembles byte-identical content across 20 fixed randomized chunk seeds", async () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const { response, body } = await rawStream({
        "x-fault-key": `seed-${seed}`,
        "x-fault-chunk-seed": String(seed),
      });
      const result = await classifyStream(body, {
        format: "openai-chat-completions",
        idleTimeoutMs: 1_000,
        hardDeadlineMs: 5_000,
        httpStatus: response.status,
      });

      expect(result.outcome, `seed ${seed}`).toBe("completed");
      expect(Buffer.from(result.content), `seed ${seed}`).toEqual(
        Buffer.from(expectedContent()),
      );
      expect(result.usage, `seed ${seed}`).toMatchObject({
        outputTokens: 12,
      });
      expect(result.chunks, `seed ${seed}`).toBeGreaterThan(1);
    }
  });

  it("classifies a mid-stream socket reset as truncated, never completed", async () => {
    const { response, body } = await rawStream({
      "x-fault-key": "reset",
      "x-fault-chunk-seed": "31",
      "x-fault-reset-after-chunks": "8",
    });
    const result = await classifyStream(body, {
      format: "openai-chat-completions",
      idleTimeoutMs: 1_000,
      hardDeadlineMs: 5_000,
      httpStatus: response.status,
    });

    expect(result).toMatchObject({
      outcome: "truncated",
      reason: "connection",
    });
  });

  it("classifies a stall beyond the idle timeout as truncated with reason idle", async () => {
    const { response, body } = await rawStream({
      "x-fault-key": "stall",
      "x-fault-chunk-seed": "41",
      "x-fault-stall-ms": "100",
    });
    const result = await classifyStream(body, {
      format: "openai-chat-completions",
      idleTimeoutMs: 20,
      hardDeadlineMs: 1_000,
      httpStatus: response.status,
    });

    expect(result).toMatchObject({ outcome: "truncated", reason: "idle" });
  });

  it("classifies a consumer abort as client_cancelled", async () => {
    const { response, body } = await rawStream({
      "x-fault-key": "cancel",
      "x-fault-chunk-seed": "43",
      "x-fault-stall-ms": "200",
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = await classifyStream(body, {
      format: "openai-chat-completions",
      idleTimeoutMs: 1_000,
      hardDeadlineMs: 2_000,
      httpStatus: response.status,
      signal: controller.signal,
    });

    expect(result.outcome).toBe("client_cancelled");
  });

  it("classifies an in-stream error event as provider_error", async () => {
    const { response, body } = await rawStream({
      "x-fault-key": "error-event",
      "x-fault-error-event": "1",
    });
    const result = await classifyStream(body, {
      format: "openai-chat-completions",
      idleTimeoutMs: 1_000,
      hardDeadlineMs: 5_000,
      httpStatus: response.status,
    });

    expect(result).toMatchObject({
      outcome: "provider_error",
      reason: "provider",
    });
  });

  it("leaves usage null when the final usage chunk is dropped", async () => {
    const { response, body } = await rawStream({
      "x-fault-key": "drop-usage",
      "x-fault-drop-usage": "1",
    });
    const result = await classifyStream(body, {
      format: "openai-chat-completions",
      idleTimeoutMs: 1_000,
      hardDeadlineMs: 5_000,
      httpStatus: response.status,
    });

    expect(result.outcome).toBe("completed");
    expect(result.usage).toBeNull();
  });

  it("uses the SDK default of two retries to expose one stream after three physical attempts", async () => {
    const key = "sdk-retries";
    const { response, body } = await rawStream({
      "x-fault-key": key,
      "x-fault-429-times": "2",
    });
    const result = await classifyStream(body, {
      format: "openai-chat-completions",
      idleTimeoutMs: 1_000,
      hardDeadlineMs: 5_000,
      httpStatus: response.status,
    });
    const hitCount = await fetch(
      `http://127.0.0.1:${server.port}/__hits?key=${key}`,
    ).then((response) => response.json() as Promise<{ hits: number }>);

    expect(result).toMatchObject({
      outcome: "completed",
      content: expectedContent(),
    });
    expect(hitCount.hits).toBe(3);
  });

  it("keeps two concurrent identical requests independent and correctly reassembled", async () => {
    const requests = ["concurrent-a", "concurrent-b"].map(
      async (key, index) => {
        const { response, body } = await rawStream({
          "x-fault-key": key,
          "x-fault-chunk-seed": String(101 + index),
          ...(index === 0 ? { "x-fault-stall-ms": "30" } : {}),
        });
        return classifyStream(body, {
          format: "openai-chat-completions",
          idleTimeoutMs: 1_000,
          hardDeadlineMs: 5_000,
          httpStatus: response.status,
        });
      },
    );
    const [first, second] = await Promise.all(requests);

    expect(first).toMatchObject({
      outcome: "completed",
      content: expectedContent(),
    });
    expect(second).toMatchObject({
      outcome: "completed",
      content: expectedContent(),
    });
  });

  it("fires the hard deadline on an endless byte stream", async () => {
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval>;
    const endless = new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setInterval(
          () => controller.enqueue(encoder.encode(": keepalive\n\n")),
          5,
        );
      },
      cancel() {
        clearInterval(timer);
      },
    });
    const result = await classifyStream(endless, {
      format: "openai-chat-completions",
      idleTimeoutMs: 50,
      hardDeadlineMs: 35,
    });

    expect(result).toMatchObject({ outcome: "truncated", reason: "deadline" });
  });
});

describe("direct stream parser behavior", () => {
  it("releases an HTTP error response body without reading it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const result = await classifyStream(body, {
      format: "openai-chat-completions",
      idleTimeoutMs: 100,
      hardDeadlineMs: 1_000,
      httpStatus: 503,
    });

    expect(result).toMatchObject({ outcome: "provider_error", reason: "http" });
    expect(cancelled).toBe(true);
  });

  it("classifies an HTTP error after headers as provider_error", async () => {
    const result = await classifyStream(directStream([]), {
      format: "openai-chat-completions",
      idleTimeoutMs: 100,
      hardDeadlineMs: 1_000,
      httpStatus: 503,
    });

    expect(result).toMatchObject({ outcome: "provider_error", reason: "http" });
  });

  it("accepts finish_reason as a well-formed finish without a DONE sentinel", async () => {
    const chunk = JSON.stringify({
      choices: [
        { index: 0, delta: { content: "finished" }, finish_reason: "stop" },
      ],
      usage: null,
    });
    const result = await classifyStream(directStream([`data: ${chunk}\n\n`]), {
      format: "openai-chat-completions",
      idleTimeoutMs: 100,
      hardDeadlineMs: 1_000,
    });

    expect(result).toMatchObject({ outcome: "completed", content: "finished" });
  });

  it("keeps finish_reason completed when the stream stalls afterward", async () => {
    const encoder = new TextEncoder();
    const chunk = JSON.stringify({
      choices: [
        { index: 0, delta: { content: "finished" }, finish_reason: "stop" },
      ],
      usage: null,
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
      },
    });
    const result = await classifyStream(stream, {
      format: "openai-chat-completions",
      idleTimeoutMs: 20,
      hardDeadlineMs: 1_000,
    });

    expect(result).toMatchObject({ outcome: "completed", content: "finished" });
  });

  it("fails loud on a malformed SSE JSON event", async () => {
    const result = await classifyStream(
      directStream(["data: {not-json}\n\n"]),
      {
        format: "openai-chat-completions",
        idleTimeoutMs: 100,
        hardDeadlineMs: 1_000,
      },
    );

    expect(result).toMatchObject({
      outcome: "provider_error",
      reason: "invalid_event",
    });
  });

  it("spools the entire completion once content exceeds one MiB", async () => {
    const writes: Uint8Array[] = [];
    let closed = false;
    const sink: StreamSpoolSink = {
      path: "/tmp/stream-spool",
      write(bytes) {
        writes.push(bytes.slice());
      },
      close() {
        closed = true;
      },
    };
    const content = "x".repeat(CONTENT_SPOOL_THRESHOLD_BYTES) + "🚀";
    const chunk = JSON.stringify({
      choices: [{ index: 0, delta: { content }, finish_reason: "stop" }],
      usage: null,
    });
    const result = await classifyStream(
      directStream([`data: ${chunk}\n\ndata: [DONE]\n\n`]),
      {
        format: "openai-chat-completions",
        idleTimeoutMs: 1_000,
        hardDeadlineMs: 5_000,
        spoolSink: sink,
      },
    );

    expect(result).toMatchObject({
      outcome: "completed",
      content: "",
      spoolPath: sink.path,
    });
    expect(Buffer.concat(writes.map((bytes) => Buffer.from(bytes)))).toEqual(
      Buffer.from(content),
    );
    expect(closed).toBe(true);
  });

  it("applies the hard deadline while a spool write is pending", async () => {
    const sink: StreamSpoolSink = {
      path: "/tmp/slow-stream-spool",
      async write(_bytes, signal) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 500);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      },
      close() {},
    };
    const content = "x".repeat(CONTENT_SPOOL_THRESHOLD_BYTES + 1);
    const chunk = JSON.stringify({
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
      usage: null,
    });
    const startedAt = performance.now();
    const result = await classifyStream(directStream([`data: ${chunk}\n\n`]), {
      format: "openai-chat-completions",
      idleTimeoutMs: 1_000,
      hardDeadlineMs: 25,
      spoolSink: sink,
    });

    expect(result).toMatchObject({ outcome: "truncated", reason: "deadline" });
    expect(performance.now() - startedAt).toBeLessThan(200);
  });

  it("preserves a multibyte code point split across source chunks", async () => {
    const event = new TextEncoder().encode(
      `data: ${JSON.stringify({
        choices: [
          { index: 0, delta: { content: "café 🚀" }, finish_reason: "stop" },
        ],
        usage: null,
      })}\n\ndata: [DONE]\n\n`,
    );
    const split = event.findIndex((byte) => byte >= 0xc2) + 1;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(event.slice(0, split));
        controller.enqueue(event.slice(split));
        controller.close();
      },
    });
    const result = await classifyStream(source, {
      format: "openai-chat-completions",
      idleTimeoutMs: 100,
      hardDeadlineMs: 1_000,
    });

    expect(result).toMatchObject({
      outcome: "completed",
      content: "café 🚀",
      chunks: 2,
    });
  });
});
