import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { PassThrough } from "node:stream";

const maxRequestBytes = 10 * 1024 * 1024;
const streamIdleTimeoutMs = 30_000;
const streamHardDeadlineMs = 300_000;
const outcomes = new Set([
  "completed",
  "provider_error",
  "client_cancelled",
  "truncated",
]);
const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function requiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function jsonEnv(name) {
  try {
    return JSON.parse(requiredEnv(name));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${name} must be valid JSON`);
    }
    throw error;
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfig() {
  const swapPolicy = jsonEnv("RM_SWAP_POLICY");
  if (
    !isObject(swapPolicy) ||
    Object.values(swapPolicy).some(
      (model) => typeof model !== "string" || model.length === 0,
    )
  ) {
    throw new Error("RM_SWAP_POLICY must map step ids to model ids");
  }

  const rawPricing = jsonEnv("RM_PRICING_TABLE");
  if (!isObject(rawPricing)) {
    throw new Error("RM_PRICING_TABLE must be an object");
  }
  const pricingTable = {};
  for (const [model, pricing] of Object.entries(rawPricing)) {
    if (
      model.length === 0 ||
      !isObject(pricing) ||
      !Number.isFinite(pricing.input) ||
      pricing.input < 0 ||
      !Number.isFinite(pricing.output) ||
      pricing.output < 0
    ) {
      throw new Error(
        "RM_PRICING_TABLE values must contain non-negative input and output prices",
      );
    }
    pricingTable[model] = { input: pricing.input, output: pricing.output };
  }

  const lease = jsonEnv("RM_BUDGET_LEASE");
  if (!isObject(lease) || !Number.isFinite(lease.maxUsd) || lease.maxUsd < 0) {
    throw new Error("RM_BUDGET_LEASE must contain a non-negative maxUsd");
  }

  const portText = requiredEnv("RM_PROXY_PORT");
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("RM_PROXY_PORT must be an integer from 0 through 65535");
  }

  const egressUrl = new URL(requiredEnv("RM_EGRESS_URL"));
  if (!/^https?:$/.test(egressUrl.protocol)) {
    throw new Error("RM_EGRESS_URL must use http or https");
  }

  return {
    runId: requiredEnv("RM_RUN_ID"),
    caseId: requiredEnv("RM_CASE_ID"),
    executionId: requiredEnv("RM_EXECUTION_ID"),
    scratch: requiredEnv("RM_SCRATCH"),
    host: process.env.RM_PROXY_HOST ?? "0.0.0.0",
    port,
    egressUrl,
    swapPolicy,
    pricingTable,
    lease,
  };
}

function readJsonLines(path, label) {
  if (!existsSync(path)) return [];
  const source = readFileSync(path, "utf8");
  if (source.length === 0) return [];
  if (!source.endsWith("\n")) {
    throw new Error(`${label} ends with an incomplete JSONL row`);
  }
  return source
    .slice(0, -1)
    .split("\n")
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`${label} has malformed JSON on line ${index + 1}`);
      }
    });
}

function loadState(config, spoolPath, checkpointPath) {
  const state = {
    seqPos: 0,
    lastAttemptGroup: 0,
    spentUsd: 0,
    groups: new Map(),
    attemptIds: new Set(),
    completedAttemptIds: new Set(),
    pendingReservations: new Map(),
  };

  for (const row of readJsonLines(checkpointPath, "checkpoint spool")) {
    if (
      !isObject(row) ||
      Object.keys(row).sort().join(",") !== "attemptGroup,caseId,seqPos" ||
      row.caseId !== config.caseId ||
      !Number.isSafeInteger(row.seqPos) ||
      row.seqPos <= state.seqPos ||
      !Number.isSafeInteger(row.attemptGroup) ||
      row.attemptGroup < 1
    ) {
      throw new Error("checkpoint spool contains an invalid row");
    }
    state.seqPos = row.seqPos;
    state.lastAttemptGroup = Math.max(state.lastAttemptGroup, row.attemptGroup);
  }

  for (const row of readJsonLines(spoolPath, "attempt spool")) {
    if (
      !isObject(row) ||
      !["attempt_reservation", "request_attempt", "blocked"].includes(row.kind)
    ) {
      throw new Error("attempt spool contains an invalid row");
    }
    if (
      row.runId !== config.runId ||
      row.caseId !== config.caseId ||
      row.executionId !== config.executionId ||
      !Number.isSafeInteger(row.attemptGroup) ||
      row.attemptGroup < 1
    ) {
      throw new Error(
        "attempt spool correlation does not match this execution",
      );
    }
    state.lastAttemptGroup = Math.max(state.lastAttemptGroup, row.attemptGroup);
    if (typeof row.logicalCallId === "string") {
      const prior = state.groups.get(row.logicalCallId);
      if (prior !== undefined && prior !== row.attemptGroup) {
        throw new Error("attempt spool assigns one logical call to two groups");
      }
      state.groups.set(row.logicalCallId, row.attemptGroup);
    } else if (row.logicalCallId !== null) {
      throw new Error("attempt spool contains an invalid logicalCallId");
    }

    if (row.kind === "attempt_reservation") {
      if (
        typeof row.attemptId !== "string" ||
        row.attemptId.length === 0 ||
        state.attemptIds.has(row.attemptId) ||
        typeof row.stepId !== "string" ||
        typeof row.logicalCallId !== "string" ||
        typeof row.model !== "string" ||
        !Number.isFinite(row.reservedUsd) ||
        row.reservedUsd < 0 ||
        typeof row.startedAt !== "string"
      ) {
        throw new Error("attempt spool contains an invalid reservation");
      }
      state.attemptIds.add(row.attemptId);
      state.pendingReservations.set(row.attemptId, row);
    } else if (row.kind === "request_attempt") {
      if (
        typeof row.attemptId !== "string" ||
        row.attemptId.length === 0 ||
        state.completedAttemptIds.has(row.attemptId) ||
        !outcomes.has(row.streamOutcome) ||
        row.costUsd !== null ||
        !Number.isFinite(row.leaseChargeUsd) ||
        row.leaseChargeUsd < 0
      ) {
        throw new Error("attempt spool contains an invalid request attempt");
      }
      state.attemptIds.add(row.attemptId);
      state.completedAttemptIds.add(row.attemptId);
      state.pendingReservations.delete(row.attemptId);
      state.spentUsd += row.leaseChargeUsd;
    }
  }

  for (const reservation of state.pendingReservations.values()) {
    appendRow(spoolPath, {
      kind: "request_attempt",
      runId: reservation.runId,
      caseId: reservation.caseId,
      stepId: reservation.stepId,
      executionId: reservation.executionId,
      attemptId: reservation.attemptId,
      logicalCallId: reservation.logicalCallId,
      attemptGroup: reservation.attemptGroup,
      attribution: "ok",
      model: reservation.model,
      contextTokensUpperBound: reservation.contextTokensUpperBound,
      streamOutcome: "truncated",
      usage: null,
      responseSpoolPath: null,
      costUsd: null,
      reservedUsd: reservation.reservedUsd,
      leaseChargeUsd: reservation.reservedUsd,
      recoveryReason: "proxy_restarted",
      startedAt: reservation.startedAt,
      endedAt: new Date().toISOString(),
    });
    state.completedAttemptIds.add(reservation.attemptId);
    state.spentUsd += reservation.reservedUsd;
  }
  state.pendingReservations.clear();

  return state;
}

function appendRow(path, row) {
  appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
}

function header(request, name) {
  const value = request.headers[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function responseHeaders(headers) {
  const forwarded = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      value !== undefined &&
      !hopByHopHeaders.has(name) &&
      name !== "content-length"
    ) {
      forwarded[name] = value;
    }
  }
  return forwarded;
}

function requestHeaders(headers, bodyLength) {
  const forwarded = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      value !== undefined &&
      !hopByHopHeaders.has(name) &&
      name !== "authorization" &&
      name !== "host" &&
      name !== "content-length"
    ) {
      forwarded[name] = value;
    }
  }
  forwarded["content-length"] = String(bodyLength);
  return forwarded;
}

function sendJson(response, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": bytes.length,
  });
  response.end(bytes);
}

function readCappedBody(request) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let bytes = 0;
    let settled = false;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (settled) return;
      if (bytes > maxRequestBytes) {
        settled = true;
        chunks = [];
        resolve({ tooLarge: true, bytes });
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.once("end", () => {
      if (!settled) {
        settled = true;
        resolve({ tooLarge: false, body: Buffer.concat(chunks), bytes });
      }
    });
    request.once("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

function requestUpstream(
  url,
  requestTarget,
  method,
  headers,
  body,
  deadlineMs,
) {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = send(
      url,
      { method, path: requestTarget, headers },
      (response) => {
        clearTimeout(deadline);
        resolve(response);
      },
    );
    const deadline = setTimeout(() => {
      request.destroy(new Error("Upstream response header deadline exceeded"));
    }, deadlineMs);
    request.once("error", reject);
    request.once("close", () => clearTimeout(deadline));
    request.end(body);
  });
}

function writeWithBackpressure(stream, chunk) {
  if (stream.destroyed || stream.writableEnded) return Promise.resolve(false);
  if (stream.write(chunk)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("close", onClose);
      stream.off("error", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve(true);
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };
    stream.once("drain", onDrain);
    stream.once("close", onClose);
    stream.once("error", onClose);
    if (stream.destroyed || stream.writableEnded) onClose();
  });
}

function normalizeUsage(usage) {
  if (!isObject(usage)) return null;
  const inputTokens =
    usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens;
  const outputTokens =
    usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens;
  const totalTokens = usage.total_tokens ?? usage.totalTokens;
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0
  ) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      Number.isSafeInteger(totalTokens) && totalTokens >= 0
        ? totalTokens
        : inputTokens + outputTokens,
  };
}

function usageCharge(usage, pricing, reservedUsd) {
  if (usage === null) return reservedUsd;
  return (
    usage.inputTokens * pricing.input + usage.outputTokens * pricing.output
  );
}

function processSseEvent(event, state) {
  const data = event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data.length === 0) return;
  if (data === "[DONE]") {
    state.terminal = true;
    return;
  }

  let value;
  try {
    value = JSON.parse(data);
  } catch {
    state.providerError = true;
    return;
  }
  if (!isObject(value)) {
    state.providerError = true;
    return;
  }
  if (value.error !== undefined) state.providerError = true;
  if (value.usage !== undefined) state.usage = value.usage;
  if (Array.isArray(value.choices)) {
    for (const choice of value.choices) {
      if (!isObject(choice)) continue;
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        state.terminal = true;
      }
    }
  }
}

async function inlineClassifyStream(byteStream, options) {
  const iterator = byteStream[Symbol.asyncIterator]();
  const decoder = new TextDecoder();
  const state = {
    usage: null,
    chunks: 0,
    terminal: false,
    providerError: false,
    buffer: "",
  };
  const deadlineAt = Date.now() + options.hardDeadlineMs;

  try {
    for (;;) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        return {
          outcome: "truncated",
          reason: "deadline",
          content: "",
          usage: state.usage,
          chunks: state.chunks,
        };
      }

      const result = await new Promise((resolve, reject) => {
        let complete = false;
        const finish = (value) => {
          if (complete) return;
          complete = true;
          clearTimeout(idleTimer);
          clearTimeout(deadlineTimer);
          options.signal?.removeEventListener("abort", onAbort);
          resolve(value);
        };
        const onAbort = () => finish({ type: "cancelled" });
        const idleTimer = setTimeout(
          () => finish({ type: "idle" }),
          options.idleTimeoutMs,
        );
        const deadlineTimer = setTimeout(
          () => finish({ type: "deadline" }),
          remaining,
        );
        options.signal?.addEventListener("abort", onAbort, { once: true });
        iterator.next().then(
          (next) => finish({ type: "next", next }),
          (error) => {
            if (complete) return;
            complete = true;
            clearTimeout(idleTimer);
            clearTimeout(deadlineTimer);
            options.signal?.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      });

      if (result.type === "cancelled") {
        return {
          outcome: "client_cancelled",
          content: "",
          usage: state.usage,
          chunks: state.chunks,
        };
      }
      if (result.type === "idle" || result.type === "deadline") {
        return {
          outcome: state.terminal ? "completed" : "truncated",
          ...(state.terminal ? {} : { reason: result.type }),
          content: "",
          usage: state.usage,
          chunks: state.chunks,
        };
      }
      if (result.next.done) break;

      state.chunks += 1;
      state.buffer += decoder.decode(result.next.value, { stream: true });
      state.buffer = state.buffer.replaceAll("\r\n", "\n");
      let boundary = state.buffer.indexOf("\n\n");
      while (boundary !== -1) {
        processSseEvent(state.buffer.slice(0, boundary), state);
        state.buffer = state.buffer.slice(boundary + 2);
        boundary = state.buffer.indexOf("\n\n");
      }
    }
  } catch {
    return {
      outcome: options.signal?.aborted ? "client_cancelled" : "truncated",
      content: "",
      usage: state.usage,
      chunks: state.chunks,
    };
  } finally {
    await iterator.return?.();
  }

  state.buffer += decoder.decode();
  if (state.buffer.length > 0) processSseEvent(state.buffer, state);
  return {
    outcome: state.providerError
      ? "provider_error"
      : state.terminal
        ? "completed"
        : "truncated",
    content: "",
    usage: state.usage,
    chunks: state.chunks,
  };
}

async function loadClassifier() {
  try {
    const transport = await import("../transport/index.js");
    if (typeof transport.classifyStream !== "function") {
      throw new Error("transport/index.js does not export classifyStream");
    }
    return transport.classifyStream;
  } catch (error) {
    if (
      !isObject(error) ||
      error.code !== "ERR_MODULE_NOT_FOUND" ||
      !String(error.message).includes("transport/index.js")
    ) {
      throw error;
    }
    return inlineClassifyStream;
  }
}

async function forwardStreaming(
  upstream,
  outgoing,
  classifyStream,
  status,
  spoolSink,
) {
  outgoing.writeHead(status, responseHeaders(upstream.headers));
  const classifierBytes = new PassThrough();
  classifierBytes.on("error", () => undefined);
  const abortController = new AbortController();
  let clientCancelled = false;
  let classificationDone = false;
  let upstreamFailed = false;
  let proxyTerminated = false;
  outgoing.once("close", () => {
    if (!proxyTerminated && !upstreamFailed && !outgoing.writableEnded) {
      clientCancelled = true;
      abortController.abort();
      upstream.destroy();
      classifierBytes.end();
    }
  });

  const classification = Promise.resolve(
    classifyStream(classifierBytes, {
      format: "openai-chat-completions",
      idleTimeoutMs: streamIdleTimeoutMs,
      hardDeadlineMs: streamHardDeadlineMs,
      signal: abortController.signal,
      httpStatus: status,
      spoolSink,
    }),
  ).then((result) => {
    classificationDone = true;
    proxyTerminated = true;
    if (!upstream.complete) {
      upstream.destroy();
    }
    if (
      result.outcome === "truncated" &&
      (result.reason === "idle" || result.reason === "deadline")
    ) {
      if (!outgoing.destroyed) outgoing.destroy();
    }
    return result;
  });

  try {
    for await (const chunk of upstream) {
      if (clientCancelled) break;
      if (!(await writeWithBackpressure(outgoing, chunk))) {
        clientCancelled = true;
        break;
      }
      if (!classificationDone) {
        await writeWithBackpressure(classifierBytes, chunk);
      }
    }
    if (!classifierBytes.destroyed && !classifierBytes.writableEnded) {
      classifierBytes.end();
    }
  } catch {
    if (!proxyTerminated) {
      upstreamFailed = true;
      abortController.abort();
      classifierBytes.end();
      if (!outgoing.destroyed) outgoing.destroy();
    }
  }

  const result = await classification;
  return {
    streamOutcome: clientCancelled
      ? "client_cancelled"
      : upstreamFailed
        ? "truncated"
        : result.outcome,
    usage: result.usage ?? null,
    spoolPath: result.spoolPath ?? null,
  };
}

async function forwardNonStreaming(upstream, outgoing, status) {
  outgoing.writeHead(status, responseHeaders(upstream.headers));
  const chunks = [];
  let clientCancelled = false;
  let upstreamFailed = false;
  outgoing.once("close", () => {
    if (!upstreamFailed && !outgoing.writableEnded) {
      clientCancelled = true;
      upstream.destroy();
    }
  });

  try {
    for await (const chunk of upstream) {
      chunks.push(Buffer.from(chunk));
      if (!(await writeWithBackpressure(outgoing, chunk))) {
        clientCancelled = true;
        upstream.destroy();
        break;
      }
    }
  } catch {
    upstreamFailed = true;
    if (!outgoing.destroyed) outgoing.destroy();
  }

  if (clientCancelled) {
    return { streamOutcome: "client_cancelled", usage: null };
  }
  if (upstreamFailed) {
    return { streamOutcome: "truncated", usage: null };
  }
  if (status >= 400) {
    return { streamOutcome: "provider_error", usage: null };
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return {
      streamOutcome: "completed",
      usage: isObject(body) ? (body.usage ?? null) : null,
    };
  } catch {
    return { streamOutcome: "truncated", usage: null };
  }
}

function nextAttemptId(state) {
  let attemptId = randomUUID();
  while (state.attemptIds.has(attemptId)) attemptId = randomUUID();
  state.attemptIds.add(attemptId);
  return attemptId;
}

async function main() {
  const config = parseConfig();
  const proxyRoot = join(config.scratch, "proxy");
  const attemptDirectory = join(proxyRoot, "attempts");
  const checkpointDirectory = join(proxyRoot, "checkpoints");
  const streamDirectory = join(proxyRoot, "streams");
  mkdirSync(attemptDirectory, { recursive: true });
  mkdirSync(checkpointDirectory, { recursive: true });
  mkdirSync(streamDirectory, { recursive: true });
  const spoolPath = join(attemptDirectory, `${config.executionId}.0.jsonl`);
  const checkpointPath = join(checkpointDirectory, `${config.caseId}.jsonl`);
  const state = loadState(config, spoolPath, checkpointPath);
  let reservedUsd = 0;
  const classifyStream = await loadClassifier();

  function checkpoint(logicalCallId) {
    let attemptGroup =
      logicalCallId === null ? undefined : state.groups.get(logicalCallId);
    if (attemptGroup === undefined) {
      state.lastAttemptGroup += 1;
      attemptGroup = state.lastAttemptGroup;
      if (logicalCallId !== null) {
        state.groups.set(logicalCallId, attemptGroup);
      }
    }
    state.seqPos += 1;
    appendRow(checkpointPath, {
      caseId: config.caseId,
      seqPos: state.seqPos,
      attemptGroup,
    });
    return attemptGroup;
  }

  function recordLost({
    attemptGroup,
    logicalCallId,
    stepId,
    reason,
    startedAt,
  }) {
    const endedAt = new Date().toISOString();
    appendRow(spoolPath, {
      kind: "request_attempt",
      runId: config.runId,
      caseId: config.caseId,
      stepId,
      executionId: config.executionId,
      attemptId: nextAttemptId(state),
      logicalCallId,
      attemptGroup,
      attribution: "lost",
      streamOutcome: "provider_error",
      usage: null,
      costUsd: null,
      reservedUsd: 0,
      leaseChargeUsd: 0,
      rejectionReason: reason,
      startedAt,
      endedAt,
    });
  }

  async function handle(incoming, outgoing) {
    const startedAt = new Date().toISOString();
    const stepId = header(incoming, "x-rm-step");
    const logicalCallId = header(incoming, "x-rm-call");
    const attemptGroup = checkpoint(logicalCallId);

    if (stepId === null || logicalCallId === null) {
      incoming.resume();
      recordLost({
        attemptGroup,
        logicalCallId,
        stepId,
        reason: "missing_correlation",
        startedAt,
      });
      const missing = stepId === null ? "x-rm-step" : "x-rm-call";
      sendJson(outgoing, 400, {
        error: `Missing required correlation header: ${missing}`,
      });
      return;
    }

    const requestBody = await readCappedBody(incoming);
    if (requestBody.tooLarge) {
      recordLost({
        attemptGroup,
        logicalCallId,
        stepId,
        reason: "request_too_large",
        startedAt,
      });
      sendJson(outgoing, 413, { error: "Request body exceeds 10 MiB." });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(requestBody.body.toString("utf8"));
    } catch {
      recordLost({
        attemptGroup,
        logicalCallId,
        stepId,
        reason: "malformed_json",
        startedAt,
      });
      sendJson(outgoing, 400, { error: "Request body must be valid JSON." });
      return;
    }

    const maxTokens = parsed?.max_tokens;
    if (
      !isObject(parsed) ||
      typeof parsed.model !== "string" ||
      parsed.model.length === 0 ||
      !Number.isSafeInteger(maxTokens) ||
      maxTokens < 0
    ) {
      recordLost({
        attemptGroup,
        logicalCallId,
        stepId,
        reason: "invalid_request",
        startedAt,
      });
      sendJson(outgoing, 400, {
        error: "Request body requires model and a non-negative max_tokens.",
      });
      return;
    }

    const model = config.swapPolicy[stepId] ?? parsed.model;
    const rewritten = { ...parsed, model };
    const forwardedBody = Buffer.from(JSON.stringify(rewritten));
    const pricing = config.pricingTable[model];
    if (pricing === undefined) {
      recordLost({
        attemptGroup,
        logicalCallId,
        stepId,
        reason: "missing_pricing",
        startedAt,
      });
      sendJson(outgoing, 400, {
        error: `Pricing is unavailable for model: ${model}`,
      });
      return;
    }

    const estimatedWorstCaseUsd =
      forwardedBody.length * pricing.input + maxTokens * pricing.output;
    const requiredLeaseUsd =
      state.spentUsd + reservedUsd + estimatedWorstCaseUsd;
    if (requiredLeaseUsd > config.lease.maxUsd) {
      appendRow(spoolPath, {
        kind: "blocked",
        runId: config.runId,
        caseId: config.caseId,
        stepId,
        executionId: config.executionId,
        logicalCallId,
        attemptGroup,
        reason: "budget",
        model,
        contextTokensUpperBound: forwardedBody.length,
        estimatedWorstCaseUsd,
        lease: { maxUsd: config.lease.maxUsd },
        requiredLease: { maxUsd: requiredLeaseUsd },
        timestamp: new Date().toISOString(),
      });
      sendJson(outgoing, 402, {
        error: "Budget lease cannot cover the next request.",
        requiredLease: { maxUsd: requiredLeaseUsd },
      });
      return;
    }

    reservedUsd += estimatedWorstCaseUsd;
    const attemptId = nextAttemptId(state);
    const responseSpoolPath = join(streamDirectory, `${attemptId}.txt`);
    appendRow(spoolPath, {
      kind: "attempt_reservation",
      runId: config.runId,
      caseId: config.caseId,
      stepId,
      executionId: config.executionId,
      attemptId,
      logicalCallId,
      attemptGroup,
      model,
      contextTokensUpperBound: forwardedBody.length,
      reservedUsd: estimatedWorstCaseUsd,
      startedAt,
    });
    let result = {
      streamOutcome: "truncated",
      usage: null,
      spoolPath: null,
    };
    try {
      const upstream = await requestUpstream(
        config.egressUrl,
        incoming.url ?? "/",
        incoming.method ?? "POST",
        requestHeaders(incoming.headers, forwardedBody.length),
        forwardedBody,
        streamHardDeadlineMs,
      );
      const status = upstream.statusCode ?? 502;
      result =
        rewritten.stream === true && status < 400
          ? await forwardStreaming(upstream, outgoing, classifyStream, status, {
              path: responseSpoolPath,
              write: (bytes) => appendFileSync(responseSpoolPath, bytes),
              close: () => undefined,
            })
          : await forwardNonStreaming(upstream, outgoing, status);
    } catch {
      if (!outgoing.headersSent) {
        sendJson(outgoing, 502, { error: "Egress request failed." });
      } else if (!outgoing.destroyed) {
        outgoing.destroy();
      }
    }

    reservedUsd -= estimatedWorstCaseUsd;
    const usage = normalizeUsage(result.usage);
    const leaseChargeUsd = usageCharge(usage, pricing, estimatedWorstCaseUsd);
    state.spentUsd += leaseChargeUsd;
    appendRow(spoolPath, {
      kind: "request_attempt",
      runId: config.runId,
      caseId: config.caseId,
      stepId,
      executionId: config.executionId,
      attemptId,
      logicalCallId,
      attemptGroup,
      attribution: "ok",
      model,
      contextTokensUpperBound: forwardedBody.length,
      streamOutcome: result.streamOutcome,
      usage,
      responseSpoolPath: result.spoolPath,
      costUsd: null,
      reservedUsd: estimatedWorstCaseUsd,
      leaseChargeUsd,
      startedAt,
      endedAt: new Date().toISOString(),
    });
    if (!outgoing.destroyed && !outgoing.writableEnded) outgoing.end();
  }

  const server = createServer((incoming, outgoing) => {
    void handle(incoming, outgoing).catch(() => {
      if (!outgoing.headersSent) {
        sendJson(outgoing, 500, { error: "Proxy request failed." });
      } else if (!outgoing.destroyed) {
        outgoing.destroy();
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Proxy did not bind a TCP address");
  }
  process.stdout.write(
    `${JSON.stringify({ event: "ready", host: config.host, port: address.port })}\n`,
  );

  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`Proxy startup failed: ${message}\n`);
  process.exitCode = 1;
});
