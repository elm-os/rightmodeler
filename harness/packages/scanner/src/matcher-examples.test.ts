import { describe, expect, it } from "vitest";

import { builtinMatchers } from "./index.js";
import { samplePath } from "./path-pattern.js";

describe("builtin matcher examples", () => {
  it("discovers every named builtin matcher", () => {
    expect(builtinMatchers).toHaveLength(28);
  });

  for (const matcher of builtinMatchers) {
    describe(matcher.slug, () => {
      it("declares at least one example", () => {
        expect(matcher.examples.length).toBeGreaterThan(0);
      });

      for (const [index, example] of matcher.examples.entries()) {
        it(`fires on example ${index}`, () => {
          const filePath = samplePath(matcher.filePatterns);
          expect(
            matcher.match(example, filePath),
            `${matcher.slug} did not match example ${index}: ${JSON.stringify(example)} at ${filePath}`,
          ).not.toHaveLength(0);
        });
      }
    });
  }

  it("requires the relevant SDK import for precise ambiguous calls", () => {
    const anthropic = builtinMatchers.find(
      ({ slug }) => slug === "js-anthropic-messages",
    )!;
    const litellm = builtinMatchers.find(
      ({ slug }) => slug === "py-litellm-completion",
    )!;

    expect(
      anthropic.match("prisma.messages.create({ data })", "src/db.ts"),
    ).toEqual([]);
    expect(
      litellm.match("completion(job, status='done')", "src/jobs.py"),
    ).toEqual([]);
  });

  it("ignores calls written inside string and docstring bodies", () => {
    const generateText = builtinMatchers.find(
      ({ slug }) => slug === "js-ai-sdk-generate-text",
    )!;
    const anthropic = builtinMatchers.find(
      ({ slug }) => slug === "py-anthropic-messages",
    )!;

    expect(
      generateText.match(
        '`call generateText({ model: "acme/large-1" })`',
        "src/notes.ts",
      ),
    ).toEqual([]);
    expect(
      anthropic.match(
        'from anthropic import Anthropic\n"""client.messages.create(model="acme/large-1")"""',
        "src/notes.py",
      ),
    ).toEqual([]);
  });

  it("keeps provider-prefixed and generic environment keys disjoint", () => {
    const provider = builtinMatchers.find(
      ({ slug }) => slug === "cfg-model-env-var",
    )!;
    const generic = builtinMatchers.find(
      ({ slug }) => slug === "cfg-env-model",
    )!;

    expect(provider.match("OPENAI_MODEL=acme/large-1", ".env")).toHaveLength(1);
    expect(generic.match("OPENAI_MODEL=acme/large-1", ".env")).toEqual([]);
    expect(provider.match("LLM_MODEL=acme/large-1", ".env")).toEqual([]);
    expect(generic.match("LLM_MODEL=acme/large-1", ".env")).toHaveLength(1);
  });

  it("uses callee, argument keys, and enclosing symbol for Go identity", () => {
    const matcher = builtinMatchers.find(
      ({ slug }) => slug === "go-openai-chat",
    )!;
    const [candidate] = matcher.match(
      'package main\nimport "github.com/openai/openai-go/v3"\nfunc answer() { client.Chat.Completions.New(ctx, openai.ChatCompletionNewParams{Model: model, Messages: messages}) }',
      "cmd/chat/main.go",
    );

    expect(candidate?.normalizedCallShape).toEqual({
      callee: "client.Chat.Completions.New",
      argumentKeys: ["Messages", "Model"],
      enclosing: "answer",
    });
  });

  it("masks Ruby comments before matching call sites", () => {
    const matcher = builtinMatchers.find(
      ({ slug }) => slug === "rb-ruby-openai-chat",
    )!;

    expect(
      matcher.match(
        'require "openai"\n# client.chat.completions.create(messages: [], model: "ignored")',
        "app/services/chat.rb",
      ),
    ).toEqual([]);
  });
});
