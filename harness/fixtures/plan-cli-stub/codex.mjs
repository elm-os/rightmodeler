import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { text } from "node:stream/consumers";

const argv = process.argv.slice(2);
const faults = (process.env.PLAN_STUB_CODEX_FAULT ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name.length > 0);
const execFlags = [
  "--json",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--strict-config",
  "--skip-git-repo-check",
];
const execPairs = [
  ["--sandbox", "read-only"],
  ["--color", "never"],
];
const overrides = [
  "include_permissions_instructions=false",
  "include_apps_instructions=false",
  "include_environment_context=false",
  "include_collaboration_mode_instructions=false",
  "skills.include_instructions=false",
  "features.shell_tool=false",
  "features.unified_exec=false",
  "features.view_image=false",
  "features.image_generation=false",
  "features.multi_agent=false",
  "features.apps=false",
  "features.plugins=false",
  "features.memories=false",
  "features.goals=false",
  "features.tool_suggest=false",
  "features.recommended_plugins=false",
  "features.personality=false",
  "tools.experimental_request_user_input.enabled=false",
  'web_search="disabled"',
  "project_doc_max_bytes=0",
  'history.persistence="none"',
  "features.code_mode_host=false",
];

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
    new URL(`captured/codex/${file}`, import.meta.url),
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
    `${JSON.stringify({ ...entry, command: "codex", pid: process.pid, at: new Date().toISOString() })}\n`,
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

function configs() {
  return argv.flatMap((arg, index) =>
    arg === "-c" && index + 1 < argv.length ? [argv[index + 1]] : [],
  );
}

function config(key) {
  return configs()
    .find((entry) => entry.startsWith(`${key}=`))
    ?.slice(key.length + 1);
}

function subcommand() {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "-c") {
      index += 1;
      continue;
    }
    return argv[index];
  }
  return undefined;
}

function keepAlive() {
  setInterval(() => undefined, 60_000);
}

function stateFile(name) {
  const state = process.env.PLAN_STUB_STATE;
  if (state === undefined) return undefined;
  mkdirSync(state, { recursive: true });
  return join(state, `codex-${name}`);
}

function previousExecs() {
  const counter = stateFile("execs");
  if (counter === undefined) return 0;
  let previous = 0;
  try {
    previous = readFileSync(counter, "utf8").split("\n").filter(Boolean).length;
  } catch {}
  appendFileSync(counter, "exec\n");
  return previous;
}

function firstModel(model) {
  const file = stateFile("first-model");
  if (file === undefined) return model;
  try {
    writeFileSync(file, model, { flag: "wx" });
  } catch {}
  return readFileSync(file, "utf8");
}

function missingIsolation() {
  for (const flag of execFlags) {
    if (!argv.includes(flag)) return flag;
  }
  for (const [flag, value] of execPairs) {
    if (valueOf(flag) !== value) return `${flag} ${value}`;
  }
  const given = configs();
  for (const entry of overrides) {
    if (!given.includes(entry)) return `-c ${entry}`;
  }
  const store = config("cli_auth_credentials_store");
  if (store !== '"file"' && store !== '"keyring"') {
    return "-c cli_auth_credentials_store";
  }
  if (config("model_instructions_file") === undefined) {
    return "-c model_instructions_file";
  }
  for (const flag of ["-m", "-o"]) {
    if (valueOf(flag) === undefined) return flag;
  }
  const dir = valueOf("-C");
  if (dir === undefined || realpathSync(dir) !== realpathSync(process.cwd())) {
    return "-C";
  }
  if (argv.at(-1) !== "-") return "-";
  return undefined;
}

function turnFailed(message, outcome) {
  const [thread] = capturedEvents("exec.jsonl");
  emit(thread);
  emit({ type: "turn.started" });
  emit({ type: "turn.failed", error: { message } });
  finish(outcome, 1);
}

function loginStatus() {
  const store = config("cli_auth_credentials_store");
  const [file, code, outcome] = hasFault("logged-out")
    ? ["login-status-not-logged-in.txt", 1, "logged-out"]
    : hasFault("keyring-only") && store === '"file"'
      ? ["login-status-not-logged-in.txt", 1, "keyring-only"]
      : hasFault("api-key-login")
        ? ["login-status-api-key.txt", 0, "api-key-login"]
        : hasFault("workload-identity-login")
          ? ["login-status-workload-identity.txt", 0, "workload-identity-login"]
          : hasFault("bedrock-login")
            ? ["login-status-bedrock.txt", 0, "bedrock-login"]
            : ["login-status.txt", 0, "login-status"];
  process.stderr.write(captured(file));
  finish(outcome, code);
}

async function exec(stdin) {
  if (hasFault("strict-config")) {
    process.stderr.write(
      captured("strict-config.err").replace(
        "tools.view_image",
        "features.shell_tool",
      ),
    );
    finish("strict-config", 1);
    return;
  }
  if (hasFault("bad-flag")) {
    process.stderr.write("error: unexpected argument '--ignore-rules' found\n");
    finish("bad-flag", 2);
    return;
  }
  const missing = missingIsolation();
  if (missing !== undefined) {
    process.stderr.write(`missing isolation setting ${missing}\n`);
    finish("missing-isolation-setting", 96);
    return;
  }
  const entries = readdirSync(process.cwd());
  if (entries.length !== 1 || entries[0] !== "instructions.md") {
    process.stderr.write(`the working directory holds ${entries.join(", ")}\n`);
    finish("working-directory-not-empty", 96);
    return;
  }
  if (
    hasFault("keyring-only") &&
    config("cli_auth_credentials_store") === '"file"'
  ) {
    for (const event of capturedEvents("exec-not-logged-in.jsonl")) emit(event);
    finish("keyring-only", 1);
    return;
  }
  const model = valueOf("-m");
  const instructions = readFileSync(
    JSON.parse(config("model_instructions_file")),
    "utf8",
  );
  const previous = previousExecs();
  if (hasFault("hang")) {
    keepAlive();
    return;
  }
  const limitAfter = faultValue("usage-limit-after");
  if (limitAfter !== undefined && previous >= Number(limitAfter)) {
    turnFailed(captured("turn-failed-usage-limit.txt").trim(), "usage-limit");
    return;
  }
  if (faultValue("model-limit") === "first" && firstModel(model) === model) {
    turnFailed(captured("turn-failed-model-limit.txt").trim(), "model-limit");
    return;
  }
  if (hasFault("capacity")) {
    turnFailed(captured("turn-failed-capacity.txt").trim(), "capacity");
    return;
  }
  const failedWith = faultValue("turn-failed");
  if (failedWith !== undefined) {
    turnFailed(captured(`turn-failed-${failedWith}.txt`).trim(), failedWith);
    return;
  }
  if (hasFault("crash")) {
    process.stderr.write("the fake codex crashed\n");
    finish("crash", 1);
    return;
  }
  if (hasFault("auth-failed")) {
    const [thread] = capturedEvents("exec.jsonl");
    emit(thread);
    for (const event of capturedEvents("exec-not-logged-in.jsonl")) emit(event);
    finish("auth-failed", 1);
    return;
  }
  if (hasFault("bad-model")) {
    for (const event of capturedEvents("exec-bad-model.jsonl")) {
      emit(
        JSON.parse(
          JSON.stringify(event).replaceAll("no-such-model-xyz", model),
        ),
      );
    }
    finish("bad-model", 1);
    return;
  }
  const digest = createHash("sha256").update(stdin).digest("hex").slice(0, 12);
  const answer = instructions.startsWith("You are a strict evaluation judge.")
    ? JSON.stringify({
        verdict: "equivalent",
        score: 1,
        justification: `Deterministic judge result ${digest}.`,
      })
    : `Deterministic reply ${digest}`;
  const [thread, started, message, completed] = capturedEvents("exec.jsonl");
  emit(thread);
  if (configs().includes("features.code_mode_host=false")) {
    emit(JSON.parse(captured("item-code-mode-notice.json")));
  }
  emit(started);
  if (hasFault("rerouted")) emit(JSON.parse(captured("item-rerouted.json")));
  if (hasFault("tool-item")) emit(JSON.parse(captured("item-tool.json")));
  if (hasFault("two-messages")) {
    emit({ ...message, item: { ...message.item, text: "draft" } });
  }
  if (!hasFault("file-only") && !hasFault("empty-turn")) {
    emit({ ...message, item: { ...message.item, id: "item_9", text: answer } });
  }
  if (!hasFault("empty-turn")) writeFileSync(valueOf("-o"), answer);
  if (!hasFault("no-turn-completed")) {
    emit({
      ...completed,
      usage: {
        ...completed.usage,
        input_tokens:
          Math.ceil(Buffer.byteLength(instructions + stdin) / 4) + 1800,
        output_tokens: Math.ceil(Buffer.byteLength(answer) / 4),
      },
    });
  }
  finish(
    faults.find((fault) =>
      [
        "rerouted",
        "tool-item",
        "two-messages",
        "file-only",
        "empty-turn",
        "no-turn-completed",
      ].includes(fault),
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
  const leaked = Object.keys(process.env).find(
    (name) =>
      name === "CODEX_API_KEY" ||
      name.startsWith("OPENAI_") ||
      name.startsWith("ANTHROPIC_"),
  );
  if (leaked !== undefined) {
    process.stderr.write(`${leaked} reached the fake codex\n`);
    finish("leaked-variable", 97);
    return;
  }
  if (argv.includes("--version")) {
    process.stdout.write(
      hasFault("old-version") ? "codex-cli 0.150.0\n" : captured("version.txt"),
    );
    finish("version", 0);
    return;
  }
  const command = subcommand();
  const rest = argv.slice(argv.indexOf(command) + 1);
  if (command === "login" && rest[0] === "status") {
    loginStatus();
    return;
  }
  if (command === "debug" && rest[0] === "models") {
    process.stdout.write(
      hasFault("bad-models") ? '{"data":[]}\n' : captured("models.json"),
    );
    finish(hasFault("bad-models") ? "bad-models" : "models", 0);
    return;
  }
  if (command === "exec") {
    await exec(stdin);
    return;
  }
  process.stderr.write(`the fake codex cannot answer ${argv.join(" ")}\n`);
  finish("unknown-command", 2);
}

await main();
