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
  return JSON.stringify(value, null, 2);
}
