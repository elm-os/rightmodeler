export type OutputMode = "human" | "json" | "jsonl";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export const processIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export class ProtocolError extends Error {
  readonly exitCode: 2 | 3;
  readonly code: string;
  readonly remedy: string;

  constructor(input: {
    exitCode: 2 | 3;
    code: string;
    message: string;
    remedy: string;
  }) {
    super(input.message);
    this.name = "ProtocolError";
    this.exitCode = input.exitCode;
    this.code = input.code;
    this.remedy = input.remedy;
  }
}

export interface PipelineEvent {
  event: "stage_started" | "stage_completed" | "stage_skipped";
  stage: string;
}

export interface PipelineWarning {
  event: "warning";
  code: string;
  message: string;
}

export class Reporter {
  readonly mode: OutputMode;
  readonly io: CliIo;
  readonly events: PipelineEvent[] = [];

  constructor(mode: OutputMode, io: CliIo) {
    this.mode = mode;
    this.io = io;
  }

  event(value: PipelineEvent): void {
    this.events.push(value);
    if (this.mode === "jsonl") {
      this.io.stdout(`${JSON.stringify(value)}\n`);
    } else if (this.mode === "human") {
      const verb = value.event.replace("stage_", "");
      this.io.stdout(`${value.stage}: ${verb}\n`);
    }
  }

  warning(code: string, message: string): void {
    const value: PipelineWarning = { event: "warning", code, message };
    if (this.mode === "human") {
      this.io.stderr(`WARNING: ${message}\n`);
    } else if (this.mode === "jsonl") {
      this.io.stdout(`${JSON.stringify(value)}\n`);
    } else {
      this.io.stderr(`${JSON.stringify(value)}\n`);
    }
  }

  result(value: unknown): void {
    if (this.mode === "json") {
      this.io.stdout(`${JSON.stringify(value)}\n`);
    } else if (this.mode === "jsonl") {
      this.io.stdout(`${JSON.stringify({ event: "result", result: value })}\n`);
    } else {
      this.io.stdout(`${renderHuman(value)}\n`);
    }
  }

  error(error: unknown): number {
    const protocol =
      error instanceof ProtocolError
        ? {
            code: error.code,
            message: error.message,
            remedy: error.remedy,
          }
        : {
            code: "runtime_error",
            message: error instanceof Error ? error.message : String(error),
            remedy: "Fix the error and rerun the command.",
          };
    if (this.mode === "human") {
      this.io.stderr(`${protocol.message} Remedy: ${protocol.remedy}\n`);
    } else {
      this.io.stderr(`${JSON.stringify(protocol)}\n`);
    }
    return error instanceof ProtocolError ? error.exitCode : 10;
  }
}

function renderHuman(value: unknown): string {
  if (typeof value === "string") return value;
  const record = objectValue(value);
  const families = Array.isArray(record?.families)
    ? record.families
    : Array.isArray(record?.familyOutcomes)
      ? record.familyOutcomes
      : undefined;
  if (families !== undefined) {
    const lines = [
      "Family | Decision | Evaluator rates | Availability | Worst-case bound | Abstain reason | Confirm | Blocker",
      "--- | --- | --- | --- | --- | --- | --- | ---",
      ...families.map(renderFamilyRow),
    ];
    if (typeof record?.reportPath === "string") {
      lines.push("", `Report: ${record.reportPath}`);
    }
    return lines.join("\n");
  }
  if (record !== undefined) {
    return Object.entries(record)
      .map(([key, item]) => `${key}: ${renderValue(item)}`)
      .join("\n");
  }
  return renderValue(value);
}

function renderFamilyRow(value: unknown): string {
  const family = objectValue(value);
  const verdict = objectValue(family?.verdict) ?? family;
  const evaluatorKinds = Array.isArray(verdict?.evaluatorKinds)
    ? verdict.evaluatorKinds
    : [];
  const rates = evaluatorKinds
    .map((value) => {
      const kind = objectValue(value);
      return `${String(kind?.evaluatorKind ?? "unknown")}: ${String(kind?.passes ?? 0)}/${String(kind?.trials ?? 0)} (${formatRate(kind?.passRate)})`;
    })
    .join("; ");
  const availability = objectValue(verdict?.availability);
  const abstention = objectValue(verdict?.abstainReason);
  const confirmation = objectValue(family?.confirmation);
  const reason =
    abstention === undefined
      ? ""
      : `${String(abstention.reason)} (${formatNumber(abstention.observed)} of ${formatNumber(abstention.required)})`;
  return [
    String(family?.familyId ?? verdict?.familyId ?? "unknown"),
    String(family?.decisionDisplay ?? verdict?.decision ?? "unknown"),
    rates,
    `${String(availability?.availableExecutions ?? 0)}/${String(availability?.executions ?? 0)} (${formatRate(availability?.rate)})`,
    formatRate(verdict?.worstCaseBound),
    reason,
    String(confirmation?.status ?? "not run"),
    String(confirmation?.blocker ?? ""),
  ].join(" | ");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return value.map(renderValue).join(", ");
  const record = objectValue(value);
  if (record !== undefined) {
    return Object.entries(record)
      .map(([key, item]) => `${key}=${renderValue(item)}`)
      .join(", ");
  }
  return String(value);
}

function formatNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? Number.isInteger(value)
      ? String(value)
      : formatRate(value)
    : String(value ?? 0);
}

function formatRate(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${(value * 100).toFixed(1)}%`
    : "0.0%";
}
