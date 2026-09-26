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
    ...(modelCall
      ? [["--max-turns", valueOf("--json-schema") === undefined ? "1" : "3"]]
      : []),
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

function validSchema(text) {
  const types = [
    "string",
    "number",
    "integer",
    "boolean",
    "object",
    "array",
    "null",
  ];
  try {
    return Object.values(JSON.parse(text)?.properties ?? {}).every(
      ({ type }) => type === undefined || types.includes(type),
    );
  } catch {
    return false;
  }
}

async function modelCall(stdin) {
  const model = valueOf("--model");
  const system = readFileSync(valueOf("--system-prompt-file"), "utf8");
  const previous = previousModelCalls();
  const delay = Number(faultValue("delay") ?? 0);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  const [capturedInit, capturedAssistant, capturedResult] =
    capturedEvents("call.jsonl");
  const init = { ...capturedInit, model, cwd: process.cwd(), ...sentinels };
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
  const schema = valueOf("--json-schema");
  if (schema !== undefined && !validSchema(schema)) {
    process.stderr.write(captured("json-schema-invalid.err"));
    finish("json-schema-invalid", 1);
    return;
  }
  const mismatch = faults.find(
    (fault) => fault === "schema-mismatch" || fault === "schema-retries",
  );
  if (mismatch !== undefined) {
    for (const event of capturedEvents("call-json-schema-mismatch.jsonl")) {
      if (event.type === "system") {
        emit({ ...event, model, cwd: process.cwd(), ...sentinels });
      } else if (event.type === "assistant") {
        emit({ ...event, message: { ...event.message, model: served } });
      } else if (event.type === "result") {
        emit({
          ...event,
          ...(mismatch === "schema-retries"
            ? {
                subtype: "error_max_structured_output_retries",
                terminal_reason: "structured_output_retry_exhausted",
                errors: [],
              }
            : {}),
          modelUsage: { [served]: Object.values(event.modelUsage)[0] },
        });
      } else {
        emit(event);
      }
    }
    finish(mismatch, 1);
    return;
  }
  const digest = createHash("sha256").update(stdin).digest("hex").slice(0, 12);
  const judge = system.startsWith("You are a strict evaluation judge.");
  const quoted = judge && hasFault("quoted-justification");
  const verdict = {
    verdict: "equivalent",
    score: 1,
    justification: quoted
      ? 'Candidate conveys the identical meaning as the reference sentence, paraphrasing "prior to its debut performance" as "before performing it publicly for the first time".'
      : `Deterministic judge result ${digest}.`,
  };
  const answer =
    schema === undefined && !judge
      ? `Deterministic reply ${digest}`
      : schema === undefined && quoted
        ? '{"verdict": "equivalent", "score": 1, "justification": "' +
          verdict.justification +
          '"}'
        : JSON.stringify(verdict);
  const inputTokens = Math.ceil(Buffer.byteLength(system + stdin) / 4) + 400;
  const outputTokens = Math.ceil(Buffer.byteLength(answer) / 4);
  const usage = {
    ...capturedAssistant.message.usage,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
  const otherTool = hasFault("tool-use")
    ? [{ type: "tool_use", id: "TOOL-USE-ID", name: "Read", input: {} }]
    : [];
  const [schemaInit, thought, structured, toolResult, schemaRateLimit] =
    schema === undefined ? [] : capturedEvents("call-json-schema.jsonl");
  if (schema === undefined) {
    emit(init);
    emit({
      ...capturedAssistant,
      message: {
        ...capturedAssistant.message,
        model: served,
        content: [{ type: "text", text: answer }, ...otherTool],
        usage,
      },
    });
  } else {
    emit({ ...schemaInit, model, cwd: process.cwd(), ...sentinels });
    emit({ ...thought, message: { ...thought.message, model: served, usage } });
    emit({
      ...structured,
      message: {
        ...structured.message,
        model: served,
        content: [
          { ...structured.message.content[0], input: verdict },
          ...otherTool,
        ],
        usage,
      },
    });
    emit(toolResult);
    emit(schemaRateLimit);
  }
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
    num_turns: Number(faultValue("turns") ?? (schema === undefined ? 1 : 2)),
    result:
      schema !== undefined && hasFault("result-text")
        ? thought.message.content[0].text
        : answer,
    ...(schema === undefined || hasFault("no-structured-output")
      ? {}
      : { structured_output: verdict }),
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
      process.stdout.write(
        `${JSON.stringify({
          loggedIn: false,
          projectsDirectory: sentinels.projectsDirectory,
          configDirectory: sentinels.configDirectory,
        })}\n`,
      );
      finish("logged-out", 1);
      return;
    }
    process.stdout.write(
      `${JSON.stringify({
        ...JSON.parse(captured("auth-status.json")),
        ...(hasFault("api-key-login")
          ? { apiKeySource: "ANTHROPIC_API_KEY" }
          : {}),
        ...(hasFault("bedrock-login")
          ? { authMethod: "third_party", apiProvider: "bedrock" }
          : {}),
        ...(faultValue("auth-method") === undefined
          ? {}
          : { authMethod: faultValue("auth-method") }),
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
