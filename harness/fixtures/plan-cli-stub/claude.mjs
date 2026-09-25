import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { text } from "node:stream/consumers";

const argv = process.argv.slice(2);
const faults = (process.env.PLAN_STUB_FAULT ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name.length > 0);
const forbidden = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "NODE_OPTIONS",
];
const sentinels = {
  email: "ACCOUNT-EMAIL-SENTINEL",
  orgName: "ORG-NAME-SENTINEL",
  projectsDirectory: "HOME-PATH-SENTINEL/.claude/projects",
  configDirectory: "HOME-PATH-SENTINEL/.claude",
};

function hasFault(name) {
  return faults.includes(name);
}

function faultValue(name) {
  return faults
    .find((fault) => fault.startsWith(`${name}:`))
    ?.slice(name.length + 1);
}

function captured(file) {
  return readFileSync(
    new URL(`captured/claude/${file}`, import.meta.url),
    "utf8",
  );
}

function capturedEvents(file) {
  return captured(file)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function record(entry) {
  if (process.env.PLAN_STUB_RECORD === undefined) return;
  appendFileSync(
    process.env.PLAN_STUB_RECORD,
    `${JSON.stringify({ ...entry, pid: process.pid, at: new Date().toISOString() })}\n`,
  );
}

function finish(outcome, code) {
  record({ event: "end", outcome });
  process.exitCode = code;
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function valueOf(flag) {
  const index = argv.indexOf(flag);
  return index === -1 || index + 1 >= argv.length ? undefined : argv[index + 1];
}

function missingIsolation(modelCall) {
  const pairs = [
    ["--tools", ""],
    ["--setting-sources", ""],
    ["--output-format", "stream-json"],
    ...(modelCall ? [["--max-turns", "1"]] : []),
  ];
  for (const [flag, value] of pairs) {
    if (valueOf(flag) !== value) return `${flag} ${JSON.stringify(value)}`;
  }
  for (const flag of [
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--verbose",
  ]) {
    if (!argv.includes(flag)) return flag;
  }
  try {
    if (JSON.parse(valueOf("--settings")).switchModelsOnFlag !== false) {
      return "--settings";
    }
  } catch {
    return "--settings";
  }
  if (modelCall && valueOf("--system-prompt-file") === undefined) {
    return "--system-prompt-file";
  }
  return undefined;
}

function keepAlive() {
  setInterval(() => undefined, 60_000);
}

function previousModelCalls() {
  const state = process.env.PLAN_STUB_STATE;
  if (state === undefined) return 0;
  mkdirSync(state, { recursive: true });
  const counter = join(state, "calls");
  let previous = 0;
  try {
    previous = readFileSync(counter, "utf8").split("\n").filter(Boolean).length;
  } catch {}
  appendFileSync(counter, "call\n");
  return previous;
}

function initialize(stdin) {
  const request = JSON.parse(stdin.split("\n").find((line) => line.trim()));
  if (
    request.type !== "control_request" ||
    request.request?.subtype !== "initialize"
  ) {
    process.stderr.write("the fake claude expected an initialize request\n");
    finish("unexpected-input", 2);
    return;
  }
  const response = JSON.parse(captured("initialize.json"));
  response.response.request_id = request.request_id;
  if (hasFault("with-1m")) {
    response.response.response.models.push({
      value: "opus[1m]",
      resolvedModel: "claude-opus-4-6[1m]",
    });
  }
  if (hasFault("no-models")) delete response.response.response.models;
  response.response.response.account = sentinels;
  emit(response);
  finish(hasFault("no-models") ? "no-models" : "initialize", 0);
}

function failedResult(overrides) {
  const [, result] = capturedEvents("call-bad-model.jsonl");
  return { ...result, ...overrides };
}

async function modelCall(stdin) {
  const model = valueOf("--model");
  const system = readFileSync(valueOf("--system-prompt-file"), "utf8");
  const previous = previousModelCalls();
  const delay = Number(faultValue("delay") ?? 0);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  const [capturedInit, capturedAssistant, capturedResult] =
    capturedEvents("call.jsonl");
  const init = { ...capturedInit, model, cwd: process.cwd() };
  if (hasFault("hang")) {
    keepAlive();
    return;
  }
  if (hasFault("api-key-source")) {
    const [keyInit] = capturedEvents("call-api-key-source.jsonl");
    emit({ ...keyInit, model, cwd: process.cwd() });
    keepAlive();
    return;
  }
  if (hasFault("bad-model")) {
    emit(init);
    emit(failedResult({}));
    finish("bad-model", 1);
    return;
  }
  if (hasFault("auth-failed")) {
    const [, , synthetic] = capturedEvents("call-api-key-source.jsonl");
    emit(init);
    emit(synthetic);
    emit(
      failedResult({
        api_error_status: 401,
        result: synthetic.message.content[0].text,
      }),
    );
    finish("auth-failed", 1);
    return;
  }
  const limitAfter = faultValue("usage-limit-after");
  const credits = hasFault("credits-required");
  if (credits || (limitAfter !== undefined && previous >= Number(limitAfter))) {
    const rejected = JSON.parse(captured("rate-limit-rejected.json"));
    const [, , synthetic] = capturedEvents("call-api-key-source.jsonl");
    const limitText = "You've hit your limit";
    emit(init);
    emit({
      ...rejected,
      rate_limit_info: {
        ...rejected.rate_limit_info,
        ...(credits ? { errorCode: "credits_required" } : {}),
      },
    });
    emit({
      ...synthetic,
      message: {
        ...synthetic.message,
        content: [{ type: "text", text: limitText }],
      },
      error: "rate_limit",
    });
    emit(failedResult({ api_error_status: 429, result: limitText }));
    finish(credits ? "credits-required" : "usage-limit", 1);
    return;
  }
  const served = faultValue("served") ?? model;
  const digest = createHash("sha256").update(stdin).digest("hex").slice(0, 12);
  const answer = system.startsWith("You are a strict evaluation judge.")
    ? JSON.stringify({
        verdict: "equivalent",
        score: 1,
        justification: `Deterministic judge result ${digest}.`,
      })
    : `Deterministic reply ${digest}`;
  const inputTokens = Math.ceil(Buffer.byteLength(system + stdin) / 4) + 400;
  const outputTokens = Math.ceil(Buffer.byteLength(answer) / 4);
  const usage = {
    ...capturedAssistant.message.usage,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
  emit(init);
  emit({
    ...capturedAssistant,
    message: {
      ...capturedAssistant.message,
      model: served,
      content: [
        { type: "text", text: answer },
        ...(hasFault("tool-use")
          ? [{ type: "tool_use", id: "TOOL-USE-ID", name: "Read", input: {} }]
          : []),
      ],
      usage,
    },
  });
  if (hasFault("near-limit")) {
    emit(JSON.parse(captured("rate-limit-allowed-warning.json")));
  }
  if (hasFault("overage")) {
    const warning = JSON.parse(captured("rate-limit-allowed-warning.json"));
    emit({
      ...warning,
      rate_limit_info: {
        ...warning.rate_limit_info,
        status: "allowed",
        isUsingOverage: true,
      },
    });
  }
  const [capturedUsage] = Object.values(capturedResult.modelUsage);
  emit({
    ...capturedResult,
    duration_api_ms: 500,
    num_turns: Number(faultValue("turns") ?? 1),
    result: answer,
    usage,
    modelUsage: {
      [served]: { ...capturedUsage, inputTokens, outputTokens },
    },
  });
  finish(
    faults.find((fault) =>
      ["near-limit", "overage", "tool-use", "served", "turns"].some(
        (name) => fault === name || fault.startsWith(`${name}:`),
      ),
    ) ?? "ok",
    0,
  );
}

async function main() {
  const stdin = process.stdin.isTTY ? "" : await text(process.stdin);
  record({
    event: "start",
    argv,
    cwd: process.cwd(),
    stdin,
    envNames: Object.keys(process.env).sort(),
  });
  const leaked = forbidden.find((name) => Object.hasOwn(process.env, name));
  if (leaked !== undefined) {
    process.stderr.write(`${leaked} reached the fake claude\n`);
    finish("leaked-variable", 97);
    return;
  }
  if (argv.includes("--version")) {
    process.stdout.write(
      hasFault("old-version")
        ? "2.1.281 (Claude Code)\n"
        : captured("version.txt"),
    );
    finish("version", 0);
    return;
  }
  if (argv[0] === "auth" && argv[1] === "status") {
    if (hasFault("logged-out")) {
      process.stdout.write(`${JSON.stringify({ loggedIn: false })}\n`);
      finish("logged-out", 1);
      return;
    }
    process.stdout.write(
      `${JSON.stringify({
        ...JSON.parse(captured("auth-status.json")),
        ...(hasFault("api-key-login")
          ? { apiKeySource: "ANTHROPIC_API_KEY" }
          : {}),
        ...sentinels,
      })}\n`,
    );
    finish("auth-status", 0);
    return;
  }
  if (!argv.includes("-p")) {
    process.stderr.write(`the fake claude cannot answer ${argv.join(" ")}\n`);
    finish("unknown-command", 2);
    return;
  }
  const isModelCall = valueOf("--input-format") !== "stream-json";
  const missing = missingIsolation(isModelCall);
  if (missing !== undefined) {
    process.stderr.write(`missing isolation flag ${missing}\n`);
    finish("missing-isolation-flag", 96);
    return;
  }
  if (isModelCall) await modelCall(stdin);
  else initialize(stdin);
}

await main();
