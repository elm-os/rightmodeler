import { candidateFromText, createCallMatcher } from "./utils.js";
import type { CandidateMatch, Matcher } from "../types.js";

const javascriptFiles = ["**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"];
const pythonFiles = ["**/*.py"];

const callMatchers: Matcher[] = [
  createCallMatcher({
    slug: "js-ai-sdk-embed",
    description: "AI SDK embedding calls",
    noiseTier: "precise",
    filePatterns: javascriptFiles,
    examples: [
      'import { embed } from "ai";\nembed({ model: embeddingModel, value: text })',
      'import { embedMany } from "ai";\nembedMany({ model: embeddingModel, values: chunks })',
    ],
    pattern: /(?<![.\w$])(?<callee>embed(?:Many)?)\s*\(/,
    fileAnchor: /(?:\bfrom\s*["']ai["']|\brequire\s*\(\s*["']ai["']\s*\))/,
    label: "AI SDK embedding",
  }),
  createCallMatcher({
    slug: "js-openai-responses-api",
    description: "OpenAI JavaScript Responses API calls",
    noiseTier: "precise",
    filePatterns: javascriptFiles,
    examples: [
      'import OpenAI from "openai";\nclient.responses.create({ model: "acme/large-1", input })',
    ],
    pattern: /\b(?<callee>[A-Za-z_$][\w$]*\.responses\.create)\s*\(/,
    fileAnchor:
      /(?:\bfrom\s*["']openai["']|\brequire\s*\(\s*["']openai["']\s*\))/,
    label: "OpenAI Responses API",
  }),
  createCallMatcher({
    slug: "js-vercel-ai-tool-call",
    description: "AI SDK tool definitions used by model calls",
    noiseTier: "normal",
    filePatterns: javascriptFiles,
    examples: [
      'import { tool } from "ai";\nconst weather = tool({ description: "Weather", inputSchema, execute })',
      'import { dynamicTool } from "ai";\nconst lookup = dynamicTool({ description: "Lookup", execute })',
    ],
    pattern: /(?<![.\w$])(?<callee>(?:dynamicTool|tool))\s*\(/,
    fileAnchor: /(?:\bfrom\s*["']ai["']|\brequire\s*\(\s*["']ai["']\s*\))/,
    label: "AI SDK tool definition",
    needsTools: true,
  }),
  createCallMatcher({
    slug: "py-openai-responses",
    description: "OpenAI Python Responses API calls",
    noiseTier: "precise",
    filePatterns: pythonFiles,
    examples: [
      'from openai import OpenAI\nclient.responses.create(model="acme/large-1", input=prompt)',
    ],
    pattern: /\b(?<callee>[A-Za-z_][\w]*\.responses\.create)\s*\(/,
    fileAnchor: /^\s*(?:from\s+openai\s+import\b|import\s+openai\b)/m,
    label: "OpenAI Responses API",
  }),
  createCallMatcher({
    slug: "py-litellm-router",
    description: "LiteLLM Router completion calls",
    noiseTier: "precise",
    filePatterns: pythonFiles,
    examples: [
      'from litellm import Router\nrouter = Router(model_list=models)\nrouter.completion(model="primary", messages=messages)',
      'from litellm import Router\nllm_router = Router(model_list=models)\nllm_router.acompletion(model="primary", messages=messages)',
    ],
    pattern:
      /\b(?<callee>(?:router|llm_router)\.(?:acompletion|completion))\s*\(/,
    fileAnchor: /^\s*from\s+litellm\s+import\s+[^\n]*\bRouter\b/m,
    label: "LiteLLM Router completion",
  }),
  createCallMatcher({
    slug: "py-instructor",
    description: "Instructor structured model calls",
    noiseTier: "precise",
    filePatterns: pythonFiles,
    examples: [
      'import instructor\nclient = instructor.from_provider("openai/acme-large")\nclient.create(response_model=Profile, messages=messages)',
    ],
    pattern:
      /\b(?<callee>(?:client|instructor_client)\.create)\s*\(\s*(?=[\s\S]{0,400}\bresponse_model\s*=)/,
    fileAnchor: /\binstructor\.from_provider\s*\(/,
    label: "Instructor structured response",
    needsStructuredOutput: true,
  }),
  createCallMatcher({
    slug: "py-dspy-predict",
    description: "DSPy Predict module construction",
    noiseTier: "normal",
    filePatterns: pythonFiles,
    examples: [
      "import dspy\nclass Extractor(dspy.Module):\n    extract = dspy.Predict(ExtractEvent)",
    ],
    pattern: /\b(?<callee>dspy\.Predict)\s*\(/,
    fileAnchor: /^\s*(?:import\s+dspy\b|from\s+dspy\s+import\b)/m,
    label: "DSPy Predict",
  }),
  createCallMatcher({
    slug: "py-dspy-chain",
    description: "DSPy ChainOfThought module construction",
    noiseTier: "normal",
    filePatterns: pythonFiles,
    examples: [
      "import dspy\nclass TriageAgent(dspy.Module):\n    classify = dspy.ChainOfThought(Triage)",
    ],
    pattern: /\b(?<callee>dspy\.ChainOfThought)\s*\(/,
    fileAnchor: /^\s*(?:import\s+dspy\b|from\s+dspy\s+import\b)/m,
    label: "DSPy ChainOfThought",
  }),
  createCallMatcher({
    slug: "js-mastra-workflow-step",
    description: "Mastra workflow step definitions",
    noiseTier: "normal",
    filePatterns: javascriptFiles,
    examples: [
      'import { createStep } from "@mastra/core/workflows";\nconst summarize = createStep({ id: "summarize", execute })',
    ],
    pattern: /(?<![.\w$])(?<callee>createStep)\s*\(/,
    fileAnchor:
      /(?:\bfrom\s*["']@mastra\/core\/workflows["']|\brequire\s*\(\s*["']@mastra\/core\/workflows["']\s*\))/,
    label: "Mastra workflow step",
  }),
  createCallMatcher({
    slug: "go-openai-chat",
    description: "OpenAI Go chat completion calls",
    noiseTier: "precise",
    filePatterns: ["**/*.go"],
    examples: [
      'package main\nimport "github.com/openai/openai-go/v3"\nfunc chat() { client.Chat.Completions.New(ctx, openai.ChatCompletionNewParams{Model: openai.ChatModelGPT5, Messages: messages}) }',
      'package main\nimport "github.com/openai/openai-go/v3"\nfunc stream() { client.Chat.Completions.NewStreaming(ctx, openai.ChatCompletionNewParams{Model: model, Messages: messages}) }',
    ],
    pattern:
      /\b(?<callee>[A-Za-z_][\w]*\.Chat\.Completions\.(?:NewStreaming|New))\s*\(/,
    fileAnchor: /["']github\.com\/openai\/openai-go(?:\/v\d+)?["']/,
    label: "OpenAI Go chat completion",
  }),
  createCallMatcher({
    slug: "rb-ruby-openai-chat",
    description: "OpenAI Ruby chat completion calls",
    noiseTier: "precise",
    filePatterns: ["**/*.rb"],
    examples: [
      'require "openai"\ndef chat\n  client.chat.completions.create(messages: messages, model: "acme-large")\nend',
    ],
    pattern: /\b(?<callee>[a-z_][\w]*\.chat\.completions\.create)\s*\(/,
    fileAnchor: /^\s*require\s*[\s(]*["']openai["']/m,
    label: "OpenAI Ruby chat completion",
  }),
  createCallMatcher({
    slug: "java-openai",
    description: "Official OpenAI Java model calls",
    noiseTier: "precise",
    filePatterns: ["**/*.java"],
    examples: [
      "import com.openai.client.OpenAIClient;\nclass Agent { void run() { client.responses().create(params); } }",
      "import com.openai.client.OpenAIClient;\nclass Agent { void run() { client.chat().completions().create(params); } }",
    ],
    pattern:
      /\b(?<callee>[A-Za-z_$][\w$]*(?:\.async\(\))?\.(?:responses\(\)|chat\(\)\.completions\(\))\.create)\s*\(/,
    fileAnchor: /^\s*import\s+com\.openai\./m,
    label: "OpenAI Java model call",
  }),
  createCallMatcher({
    slug: "java-langchain4j-chat",
    description: "LangChain4j OpenAI chat model construction",
    noiseTier: "normal",
    filePatterns: ["**/*.java"],
    examples: [
      'import dev.langchain4j.model.openai.OpenAiChatModel;\nclass Agent { Object model() { return OpenAiChatModel.builder().modelName("acme-large").build(); } }',
      'import dev.langchain4j.model.openai.OpenAiResponsesChatModel;\nclass Agent { Object model() { return OpenAiResponsesChatModel.builder().modelName("acme-large").build(); } }',
    ],
    pattern:
      /\b(?<callee>OpenAi(?:Official)?(?:Responses)?(?:Streaming)?ChatModel\.builder)\s*\(/,
    fileAnchor: /^\s*import\s+dev\.langchain4j\./m,
    label: "LangChain4j OpenAI chat model",
  }),
];

const envModelMatcher: Matcher = {
  slug: "cfg-env-model",
  description: "Generic model identifiers in environment-style configuration",
  noiseTier: "normal",
  filePatterns: ["**/.env", "**/.env.*", "**/*.{env,yaml,yml,toml}"],
  examples: ["MODEL=acme/large-1", "LLM_MODEL: acme/large-1"],
  match(content): CandidateMatch[] {
    const matches: CandidateMatch[] = [];
    const pattern =
      /^\s*((?:LLM_)?MODEL(?:_ID|_NAME)?)\s*[:=]\s*["']?([^\s"']+)["']?/gm;
    for (const match of content.matchAll(pattern)) {
      const candidate = candidateFromText({
        slug: this.slug,
        label: "Model environment variable",
        content,
        position: match.index,
        matchedText: match[0],
        callee: "config.env.model",
      });
      matches.push({
        ...candidate,
        normalizedCallShape: {
          ...candidate.normalizedCallShape,
          argumentKeys: [match[1]!.toLowerCase()],
        },
        modelId: match[2],
      });
    }
    return matches;
  },
};

interface JsonModelPin {
  readonly path: readonly string[];
  readonly key: string;
  readonly modelId: string;
}

function jsonModelPins(value: unknown): JsonModelPin[] {
  const pins: JsonModelPin[] = [];
  const visit = (current: unknown, path: readonly string[]): void => {
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, [...path, String(index)]));
      return;
    }
    if (typeof current !== "object" || current === null) return;
    for (const [key, child] of Object.entries(current)) {
      const nextPath = [...path, key];
      if (
        /^(?:model|modelId|model_name)$/.test(key) &&
        typeof child === "string" &&
        path.some((segment) =>
          /^(?:ai|llm|inference|models?|providers?)$/i.test(segment),
        )
      ) {
        pins.push({ path, key, modelId: child });
      }
      visit(child, nextPath);
    }
  };
  visit(value, []);
  return pins;
}

const jsonModelMatcher: Matcher = {
  slug: "cfg-json-model-key",
  description: "Nested model identifiers in AI JSON configuration",
  noiseTier: "precise",
  filePatterns: [
    "**/config.json",
    "**/config/*.json",
    "**/models/*.json",
    "**/*-models.json",
  ],
  examples: [
    '{"ai":{"primary":{"model":"acme/large-1"}}}',
    '{"providers":{"openai":{"modelId":"acme/large-1"}}}',
  ],
  match(content): CandidateMatch[] {
    const parsed: unknown = JSON.parse(content);
    let cursor = 0;
    return jsonModelPins(parsed).map((pin) => {
      const valueText = JSON.stringify(pin.modelId);
      const position = content.indexOf(valueText, cursor);
      cursor = position === -1 ? cursor : position + valueText.length;
      const enclosing = pin.path.join(".") || "<root>";
      return {
        slug: this.slug,
        label: "JSON model configuration",
        snippet: `${pin.key}: ${pin.modelId}`,
        enclosingSymbolPath: enclosing,
        normalizedCallShape: {
          callee: "config.json.model",
          argumentKeys: [pin.key],
          enclosing,
        },
        needsTools: false,
        needsStructuredOutput: false,
        modelId: pin.modelId,
        line:
          position === -1 ? 1 : content.slice(0, position).split("\n").length,
      };
    });
  },
};

export const breadthMatchers: readonly Matcher[] = Object.freeze([
  ...callMatchers,
  envModelMatcher,
  jsonModelMatcher,
]);
