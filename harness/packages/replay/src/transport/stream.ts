export type StreamOutcome =
  "completed" | "provider_error" | "client_cancelled" | "truncated";

export type StreamReason =
  | "idle"
  | "deadline"
  | "connection"
  | "http"
  | "invalid_event"
  | "provider"
  | "spool";

export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface StreamResult {
  outcome: StreamOutcome;
  reason?: StreamReason;
  content: string;
  usage: StreamUsage | null;
  chunks: number;
  spoolPath?: string;
  finishedWithoutSentinel?: true;
}

export interface StreamSpoolSink {
  path: string;
  write(bytes: Uint8Array, signal: AbortSignal): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface ClassifyStreamOptions {
  format: "openai-chat-completions";
  idleTimeoutMs: number;
  hardDeadlineMs: number;
  signal?: AbortSignal;
  httpStatus?: number;
  /** Required before content crosses the spool threshold; omitting it is a programmer error. */
  spoolSink?: StreamSpoolSink;
}

export type ByteStream = AsyncIterable<Uint8Array>;

export const CONTENT_SPOOL_THRESHOLD_BYTES = 1024 * 1024;

interface OpenAIStreamEvent {
  content: string;
  finished: boolean;
  providerError: boolean;
  usage: StreamUsage | null;
}

class StreamParseError extends Error {}

class ContentCollector {
  private content = "";
  private contentBytes = 0;
  private spooling = false;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(
    private readonly sink: StreamSpoolSink | undefined,
    private readonly signal: AbortSignal,
  ) {}

  private write(bytes: Uint8Array): Promise<void> {
    this.pendingWrite = this.pendingWrite.then(() =>
      this.sink!.write(bytes, this.signal),
    );
    return this.pendingWrite;
  }

  async append(value: string): Promise<void> {
    if (value.length === 0) return;
    const bytes = new TextEncoder().encode(value);
    if (
      !this.spooling &&
      this.contentBytes + bytes.byteLength > CONTENT_SPOOL_THRESHOLD_BYTES
    ) {
      if (this.sink === undefined) {
        throw new Error(
          "Completion exceeded the in-memory limit without a spool sink",
        );
      }
      this.spooling = true;
      await this.write(new TextEncoder().encode(this.content));
      this.content = "";
    }

    if (this.spooling) {
      await this.write(bytes);
    } else {
      this.content += value;
      this.contentBytes += bytes.byteLength;
    }
  }

  async close(): Promise<"write" | "close" | null> {
    if (!this.spooling) return null;
    let failure: "write" | "close" | null = null;
    await this.pendingWrite.catch(() => {
      failure = "write";
    });
    try {
      await this.sink!.close();
    } catch {
      failure = "close";
    }
    return failure;
  }

  result(): Pick<StreamResult, "content" | "spoolPath"> {
    return this.spooling
      ? { content: "", spoolPath: this.sink!.path }
      : { content: this.content };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUsage(value: unknown): StreamUsage | null {
  if (
    !isRecord(value) ||
    typeof value.prompt_tokens !== "number" ||
    typeof value.completion_tokens !== "number" ||
    typeof value.total_tokens !== "number"
  ) {
    return null;
  }
  return {
    inputTokens: value.prompt_tokens,
    outputTokens: value.completion_tokens,
    totalTokens: value.total_tokens,
  };
}

function parseEvent(data: string): OpenAIStreamEvent {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch (error) {
    throw new StreamParseError(
      `Stream event was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(value))
    throw new StreamParseError("Stream event must be an object");
  if (value.error !== undefined) {
    return { content: "", finished: false, providerError: true, usage: null };
  }
  if (!Array.isArray(value.choices)) {
    throw new StreamParseError("Stream event choices must be an array");
  }

  let content = "";
  let finished = false;
  for (const rawChoice of value.choices) {
    if (!isRecord(rawChoice))
      throw new StreamParseError("Stream choice must be an object");
    if (
      rawChoice.finish_reason !== undefined &&
      rawChoice.finish_reason !== null
    ) {
      if (typeof rawChoice.finish_reason !== "string") {
        throw new StreamParseError("finish_reason must be a string or null");
      }
      finished = true;
    }
    if (rawChoice.delta === undefined) continue;
    if (!isRecord(rawChoice.delta))
      throw new StreamParseError("Stream choice delta must be an object");
    if (
      rawChoice.delta.content === undefined ||
      rawChoice.delta.content === null
    )
      continue;
    if (typeof rawChoice.delta.content !== "string") {
      throw new StreamParseError(
        "Stream delta content must be a string or null",
      );
    }
    content += rawChoice.delta.content;
  }

  return {
    content,
    finished,
    providerError: false,
    usage:
      value.usage === undefined || value.usage === null
        ? null
        : parseUsage(value.usage),
  };
}

function eventData(event: string): string | null {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => (line[5] === " " ? line.slice(6) : line.slice(5)));
  return data.length === 0 ? null : data.join("\n");
}

async function releaseIterator(
  iterator: AsyncIterator<Uint8Array>,
): Promise<void> {
  if (iterator.return === undefined) return;
  await Promise.resolve()
    .then(() => iterator.return!())
    .catch(() => undefined);
}

export async function classifyStream(
  byteStream: ByteStream,
  options: ClassifyStreamOptions,
): Promise<StreamResult> {
  const iterator = byteStream[Symbol.asyncIterator]();
  let iteratorFinished = false;
  const processingController = new AbortController();
  const collector = new ContentCollector(
    options.spoolSink,
    processingController.signal,
  );
  let chunks = 0;
  let usage: StreamUsage | null = null;
  let sawFinish = false;
  let selectedResult: StreamResult | undefined;
  const result = (
    outcome: StreamOutcome,
    reason?: StreamReason,
    finishedWithoutSentinel = false,
  ): StreamResult => {
    selectedResult = {
      outcome,
      ...(reason === undefined ? {} : { reason }),
      ...collector.result(),
      usage,
      chunks,
      ...(finishedWithoutSentinel ? { finishedWithoutSentinel: true } : {}),
    };
    return selectedResult;
  };
  const connectionResult = (): StreamResult =>
    sawFinish
      ? result("completed", undefined, true)
      : result("truncated", "connection");

  if (
    options.httpStatus !== undefined &&
    (options.httpStatus < 200 || options.httpStatus >= 300)
  ) {
    await releaseIterator(iterator);
    return result("provider_error", "http");
  }
  if (options.signal?.aborted === true) {
    await releaseIterator(iterator);
    return result("client_cancelled");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let idleTimer: ReturnType<typeof setTimeout>;
  let hardTimer: ReturnType<typeof setTimeout>;
  let stopped = false;
  let stopReason: "idle" | "deadline" | "cancelled" | undefined;
  let resolveStop!: () => void;
  const stop = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  const terminate = (reason: "idle" | "deadline" | "cancelled") => {
    if (stopped) return;
    stopped = true;
    stopReason = reason;
    processingController.abort();
    resolveStop();
  };
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => terminate("idle"), options.idleTimeoutMs);
  };
  const abort = () => terminate("cancelled");
  const stoppedResult = (): StreamResult => {
    if (stopReason === "cancelled") return result("client_cancelled");
    return sawFinish
      ? result("completed", undefined, true)
      : result("truncated", stopReason);
  };
  const awaitProcessing = async (
    operation: Promise<void>,
  ): Promise<
    { kind: "done" } | { kind: "error"; error: unknown } | { kind: "stopped" }
  > => {
    const raced = await Promise.race([
      operation.then(
        () => ({ kind: "done" as const }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      stop.then(() => ({ kind: "stopped" as const })),
    ]);
    if (stopped) {
      operation.catch(() => undefined);
      return { kind: "stopped" };
    }
    return raced;
  };

  hardTimer = setTimeout(() => terminate("deadline"), options.hardDeadlineMs);
  idleTimer = setTimeout(() => terminate("idle"), options.idleTimeoutMs);
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    for (;;) {
      const next = Promise.resolve()
        .then(() => iterator.next())
        .then(
          (value) => ({ kind: "next" as const, value }),
          () => ({ kind: "connection_error" as const }),
        );
      const raced = await Promise.race([
        next,
        stop.then(() => ({ kind: "stopped" as const })),
      ]);

      if (raced.kind === "stopped") {
        return stoppedResult();
      }
      if (raced.kind === "connection_error") {
        return connectionResult();
      }
      if (raced.value.done) {
        iteratorFinished = true;
        try {
          buffer += decoder.decode();
        } catch {
          return connectionResult();
        }
        return connectionResult();
      }
      if (raced.value.value.byteLength === 0) continue;

      chunks += 1;
      resetIdleTimer();
      try {
        buffer += decoder.decode(raced.value.value, { stream: true });
      } catch {
        return connectionResult();
      }

      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (boundary === null) break;
        const rawEvent = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = eventData(rawEvent);
        if (data === null) continue;
        if (data === "[DONE]") {
          sawFinish = true;
          return result("completed");
        }

        let event: OpenAIStreamEvent;
        try {
          event = parseEvent(data);
          if (event.providerError) return result("provider_error", "provider");
          const processed = await awaitProcessing(
            collector.append(event.content),
          );
          if (processed.kind === "stopped") return stoppedResult();
          if (processed.kind === "error") {
            if (processed.error instanceof Error && !options.spoolSink) {
              throw processed.error;
            }
            return result("truncated", "spool");
          }
        } catch (error) {
          if (error instanceof StreamParseError) {
            return result("provider_error", "invalid_event");
          }
          throw error;
        }
        usage = event.usage ?? usage;
        sawFinish ||= event.finished;
      }
    }
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(hardTimer);
    options.signal?.removeEventListener("abort", abort);
    if (!iteratorFinished) void releaseIterator(iterator);
    const closeFailure = await collector.close();
    if (
      closeFailure === "close" ||
      (closeFailure === "write" &&
        selectedResult?.reason !== "idle" &&
        selectedResult?.reason !== "deadline" &&
        selectedResult?.outcome !== "client_cancelled")
    ) {
      if (selectedResult === undefined) return result("truncated", "spool");
      selectedResult.outcome = "truncated";
      selectedResult.reason = "spool";
      delete selectedResult.finishedWithoutSentinel;
    }
  }
}
