import { PassThrough, Readable, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import type { DiscoveredTrace } from "./data/discover.js";
import { promptForProviderBaseUrl, promptForTracePath } from "./guidance.js";

const candidates: DiscoveredTrace[] = [
  {
    path: "/repo/new.jsonl",
    format: "codex",
    approximateRecords: 12,
    modifiedAt: new Date("2026-08-15T12:00:00.000Z"),
  },
  {
    path: "/repo/old.jsonl",
    format: "openai-jsonl",
    approximateRecords: 4,
    modifiedAt: new Date("2026-08-14T12:00:00.000Z"),
  },
];

async function prompt(
  answer: string,
  available: readonly DiscoveredTrace[] = candidates,
): Promise<{ selected: string | undefined; output: string }> {
  let output = "";
  const selected = await promptForTracePath({
    candidates: available,
    repo: "/repo",
    homeDir: "/home/example",
    now: new Date("2026-08-15T13:00:00.000Z"),
    input: Readable.from([answer]),
    output: new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    }),
  });
  return { selected, output };
}

describe("interactive trace guidance", () => {
  it("accepts the newest candidate when enter leaves the answer empty", async () => {
    const result = await prompt("\n");

    expect(result.selected).toBe("/repo/new.jsonl");
    expect(result.output).toContain(
      "1. Codex session, about 12 model calls, 1 hour ago, ./new.jsonl",
    );
    expect(result.output).toContain("Choose a trace file [1]:");
  });

  it("selects a candidate by index", async () => {
    expect((await prompt("2\n")).selected).toBe("/repo/old.jsonl");
  });

  it("accepts a typed path", async () => {
    expect((await prompt("./exports/traces.jsonl\n")).selected).toBe(
      "/repo/exports/traces.jsonl",
    );
  });

  it("re-prompts when a numeric choice is out of range", async () => {
    const result = await prompt("7\n2\n");

    expect(result.selected).toBe("/repo/old.jsonl");
    expect(result.output).toContain("Choose a number from 1 to 2.");
    expect(result.output.match(/Choose a trace file/g)).toHaveLength(2);
  });

  it("stops cleanly when the input closes during a question", async () => {
    const input = new PassThrough();
    let output = "";
    const selected = promptForTracePath({
      candidates,
      repo: "/repo",
      homeDir: "/home/example",
      input,
      output: new Writable({
        write(chunk, _encoding, callback) {
          output += String(chunk);
          callback();
        },
      }),
    });

    setImmediate(() => input.destroy());

    await expect(selected).resolves.toBeUndefined();
    expect(output).toContain("Choose a trace file");
  });

  it("explains traces before an empty path exits", async () => {
    const result = await prompt("\n", []);

    expect(result.selected).toBeUndefined();
    expect(result.output).toContain(
      "Traces are logs that your AI tools already write.",
    );
    expect(result.output).toContain(
      "See the supported sources at https://www.rightmodeler.com/integrations",
    );
    expect(result.output.indexOf("Traces are logs")).toBeLessThan(
      result.output.indexOf("Trace file path"),
    );
  });
});

describe("interactive provider guidance", () => {
  it("explains replay and accepts a base URL without reading a secret", async () => {
    let output = "";
    const baseUrl = await promptForProviderBaseUrl({
      input: Readable.from(["https://openai.example/v1\n"]),
      output: new Writable({
        write(chunk, _encoding, callback) {
          output += String(chunk);
          callback();
        },
      }),
    });

    expect(baseUrl).toBe("https://openai.example/v1");
    expect(output).toContain("any OpenAI-compatible endpoint");
    expect(output).not.toContain("API key:");
  });
});
