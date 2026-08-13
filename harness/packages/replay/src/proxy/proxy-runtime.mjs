import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  truncateSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { hopByHopHeaders } from "./headers.js";
import { classifyStream } from "../transport/stream.js";

const maxRequestBytes = 10 * 1024 * 1024;
const inputBytesPerToken = 4;
const streamIdleTimeoutMs = Number(
  process.env.RM_STREAM_IDLE_TIMEOUT_MS ?? 30_000,
);
const streamHardDeadlineMs = Number(
  process.env.RM_STREAM_HARD_DEADLINE_MS ?? 300_000,
);

function requiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function jsonEnv(name) {
  return JSON.parse(requiredEnv(name));
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfig() {
  const rawSwapPolicy = jsonEnv("RM_SWAP_POLICY");
  if (
    !isObject(rawSwapPolicy) ||
    Object.values(rawSwapPolicy).some(
      (model) => typeof model !== "string" || model.length === 0,
    )
  ) {
    throw new Error("RM_SWAP_POLICY must map step ids to model ids");
  }
  const swapPolicy = Object.assign(Object.create(null), rawSwapPolicy);

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
  const lines = source.split("\n");
  lines.pop();
  if (!source.endsWith("\n")) {
    truncateSync(path, source.lastIndexOf("\n") + 1);
  }
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`${label} has malformed JSON on line ${index + 1}`);
    }
  });
}

function loadState(spoolPath, checkpointPath) {
  const state = {
    seqPos: 0,
    lastAttemptGroup: 0,
    spentUsd: 0,
    groups: new Map(),
    attemptIds: new Set(),
  };

  for (const row of readJsonLines(checkpointPath, "checkpoint spool")) {
    if (
      !isObject(row) ||
      !Number.isSafeInteger(row.seqPos) ||
      row.seqPos <= state.seqPos ||
      !Number.isSafeInteger(row.attemptGroup) ||
      row.attemptGroup < 1
    ) {
      throw new Error("checkpoint spool contains an invalid row");
    }
    state.seqPos = row.seqPos;
    state.lastAttemptGroup = Math.max(state.lastAttemptGroup, row.attemptGroup);
    if (typeof row.logicalCallId === "string") {
      state.groups.set(row.logicalCallId, row.attemptGroup);
    }
  }

  for (const row of readJsonLines(spoolPath, "attempt spool")) {
    if (!isObject(row) || row.kind !== "request_attempt") continue;
    if (
      !Number.isSafeInteger(row.attemptGroup) ||
      row.attemptGroup < 1 ||
      typeof row.logicalCallId !== "string" ||
      typeof row.attemptId !== "string" ||
      !Number.isFinite(row.costUsd) ||
      row.costUsd < 0
    ) {
      throw new Error("attempt spool contains an invalid request attempt");
    }
    state.lastAttemptGroup = Math.max(state.lastAttemptGroup, row.attemptGroup);
    state.groups.set(row.logicalCallId, row.attemptGroup);
    state.attemptIds.add(row.attemptId);
    state.spentUsd += row.costUsd;
  }

  return state;
}

function appendRow(path, row) {
  appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
}

function header(request, name) {
  const value = request.headers[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hasDuplicateHeader(request, name) {
  return (request.headersDistinct[name]?.length ?? 0) > 1;
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

async function forwardStreaming(upstream, outgoing, status, spoolSink) {
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
    finishedWithoutSentinel: result.finishedWithoutSentinel === true,
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
  const attemptId = randomUUID();
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
  const state = loadState(spoolPath, checkpointPath);
  let reservedUsd = 0;

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
      logicalCallId,
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
      kind: "lost",
      runId: config.runId,
      caseId: config.caseId,
      stepId,
      executionId: config.executionId,
      attemptId: nextAttemptId(state),
      logicalCallId,
      attemptGroup,
      attribution: "lost",
      streamOutcome: null,
      usage: null,
      costUsd: null,
      costIsEstimate: false,
      reservedUsd: 0,
      leaseChargeUsd: 0,
      rejectionReason: reason,
      startedAt,
      endedAt,
    });
  }

  async function handle(incoming, outgoing) {
    const startedAt = new Date().toISOString();
    const duplicateStep = hasDuplicateHeader(incoming, "x-rm-step");
    const stepId = duplicateStep ? null : header(incoming, "x-rm-step");
    const logicalCallId = header(incoming, "x-rm-call");
    const attemptGroup = checkpoint(logicalCallId);

    if (duplicateStep || stepId === null || logicalCallId === null) {
      incoming.resume();
      recordLost({
        attemptGroup,
        logicalCallId,
        stepId,
        reason: duplicateStep
          ? "duplicate_step_correlation"
          : "missing_correlation",
        startedAt,
      });
      if (duplicateStep) {
        sendJson(outgoing, 400, {
          error: "Duplicate correlation header: x-rm-step",
        });
        return;
      }
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

    const estimatedInputTokens = Math.ceil(
      forwardedBody.length / inputBytesPerToken,
    );
    const estimatedWorstCaseUsd =
      estimatedInputTokens * pricing.input + maxTokens * pricing.output;
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
        estimatedInputTokens,
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
    try {
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
            ? await forwardStreaming(upstream, outgoing, status, {
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

      const usage = normalizeUsage(result.usage);
      const leaseChargeUsd = usageCharge(usage, pricing, estimatedWorstCaseUsd);
      // The seven core fact fields are attemptId, logicalCallId, executionId,
      // streamOutcome, usage, costUsd, and costIsEstimate. Other fields are spool metadata.
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
        estimatedInputTokens,
        streamOutcome: result.streamOutcome,
        ...(result.finishedWithoutSentinel
          ? { finishedWithoutSentinel: true }
          : {}),
        usage,
        responseSpoolPath: result.spoolPath,
        costUsd: leaseChargeUsd,
        costIsEstimate: usage === null,
        reservedUsd: estimatedWorstCaseUsd,
        leaseChargeUsd,
        startedAt,
        endedAt: new Date().toISOString(),
      });
      state.spentUsd += leaseChargeUsd;
      if (!outgoing.destroyed && !outgoing.writableEnded) outgoing.end();
    } finally {
      reservedUsd -= estimatedWorstCaseUsd;
    }
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
