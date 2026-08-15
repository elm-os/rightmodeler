import {
  candidateFromText,
  createCallMatcher,
  enclosingSymbol,
} from "./utils.js";
import type { CandidateMatch, Matcher } from "../types.js";
import { breadthMatchers } from "./breadth.js";

const javascriptFiles = ["**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"];
const pythonFiles = ["**/*.py"];

const callMatchers: Matcher[] = [
  createCallMatcher({
    slug: "js-ai-sdk-generate-text",
    description: "AI SDK text generation calls",
    noiseTier: "precise",
    filePatterns: javascriptFiles,
    examples: ['generateText({ model: "acme/large-1", prompt: input })'],
    pattern: /\b(?<callee>generateText)\s*\(/,
    label: "AI SDK generateText",
  }),
  createCallMatcher({
    slug: "js-ai-sdk-stream-text",
    description: "AI SDK streaming text generation calls",
    noiseTier: "precise",
    filePatterns: javascriptFiles,
    examples: ['streamText({ model: "acme/large-1", prompt: input })'],
    pattern: /\b(?<callee>streamText)\s*\(/,
    label: "AI SDK streamText",
  }),
  createCallMatcher({
    slug: "js-ai-sdk-generate-object",
    description: "AI SDK structured object generation calls",
    noiseTier: "precise",
    filePatterns: javascriptFiles,
    examples: [
      'generateObject({ model: "acme/large-1", schema, prompt: input })',
    ],
    pattern: /\b(?<callee>generateObject)\s*\(/,
    label: "AI SDK generateObject",
    needsStructuredOutput: true,
  }),
  createCallMatcher({
    slug: "js-openai-chat-completions",
    description: "OpenAI JavaScript chat completion calls",
    noiseTier: "precise",
    filePatterns: javascriptFiles,
    examples: [
      'client.chat.completions.create({ model: "acme/large-1", messages })',
    ],
    pattern: /\b(?<callee>[A-Za-z_$][\w$]*\.chat\.completions\.create)\s*\(/,
    label: "OpenAI chat completions",
  }),
  createCallMatcher({
    slug: "js-anthropic-messages",
    description: "Anthropic JavaScript message creation calls",
    noiseTier: "precise",
    filePatterns: javascriptFiles,
    examples: [
      'import Anthropic from "@anthropic-ai/sdk";\nanthropic.messages.create({ model: "acme/large-1", messages, max_tokens: 200 })',
    ],
    pattern: /\b(?<callee>[A-Za-z_$][\w$]*\.messages\.create)\s*\(/,
    fileAnchor:
      /(?:\bimport\s+(?:[^;\n]*?\s+from\s*)?["']@anthropic-ai\/sdk["']|\brequire\s*\(\s*["']@anthropic-ai\/sdk["']\s*\)|\bimport\s*\(\s*["']@anthropic-ai\/sdk["']\s*\))/,
    label: "Anthropic messages",
  }),
  createCallMatcher({
    slug: "js-langchain-chat-model",
    description: "LangChain JavaScript chat model construction",
    noiseTier: "normal",
    filePatterns: javascriptFiles,
    examples: ['new ChatOpenAI({ model: "acme/large-1" })'],
    pattern:
      /\bnew\s+(?<callee>Chat(?:OpenAI|Anthropic|GoogleGenerativeAI|Bedrock(?:Converse)?))\s*\(/,
    label: "LangChain chat model",
  }),
  createCallMatcher({
    slug: "py-openai-chat-completions",
    description: "OpenAI Python chat completion calls",
    noiseTier: "precise",
    filePatterns: pythonFiles,
    examples: [
      'client.chat.completions.create(model="acme/large-1", messages=[], tools=tools)',
    ],
    pattern: /\b(?<callee>[A-Za-z_][\w]*\.chat\.completions\.create)\s*\(/,
    label: "OpenAI chat completions",
  }),
  createCallMatcher({
    slug: "py-anthropic-messages",
    description: "Anthropic Python message creation calls",
    noiseTier: "precise",
    filePatterns: pythonFiles,
    examples: [
      'client.messages.create(model="acme/large-1", max_tokens=200, messages=[])',
    ],
    pattern: /\b(?<callee>[A-Za-z_][\w]*\.messages\.create)\s*\(/,
    label: "Anthropic messages",
  }),
  createCallMatcher({
    slug: "py-litellm-completion",
    description: "LiteLLM Python completion calls",
    noiseTier: "precise",
    filePatterns: pythonFiles,
    examples: [
      'import litellm\nlitellm.completion(model="acme/large-1", messages=[])',
    ],
    pattern: /(?<![.\w])(?<callee>(?:litellm\.)?completion)\s*\(/,
    fileAnchor:
      /^\s*(?:from\s+litellm(?:\.[A-Za-z_]\w*)*\s+import\b|import\s+(?:[A-Za-z_]\w*\s*,\s*)*litellm\b)/m,
    label: "LiteLLM completion",
  }),
  createCallMatcher({
    slug: "py-langchain-chat-model",
    description: "LangChain Python chat model construction",
    noiseTier: "normal",
    filePatterns: pythonFiles,
    examples: ['ChatOpenAI(model="acme/large-1")'],
    pattern:
      /\b(?<callee>Chat(?:OpenAI|Anthropic|GoogleGenerativeAI|Bedrock))\s*\(/,
    label: "LangChain chat model",
  }),
  createCallMatcher({
    slug: "py-langgraph-node",
    description: "LangGraph node registration",
    noiseTier: "normal",
    filePatterns: pythonFiles,
    examples: ['graph.add_node("triage", triage_ticket)'],
    pattern: /\b(?<callee>[A-Za-z_][\w]*\.add_node)\s*\(/,
    label: "LangGraph node",
  }),
];

const litellmYamlMatcher: Matcher = {
  slug: "cfg-litellm-yaml",
  description: "LiteLLM YAML model mappings",
  noiseTier: "precise",
  filePatterns: ["**/*.{yaml,yml}"],
  examples: [
    "model_list:\n  - model_name: acme/large-1\n    litellm_params:\n      model: acme/large-1",
  ],
  match(content): CandidateMatch[] {
    if (
      !/^\s*model_list\s*:/m.test(content) ||
      !/^\s*litellm_params\s*:/m.test(content)
    ) {
      return [];
    }
    const matches: CandidateMatch[] = [];
    const pattern = /^\s*-\s*model_name\s*:\s*["']?([^\s"']+)["']?/gm;
    for (const match of content.matchAll(pattern)) {
      const position = match.index;
      const symbol = enclosingSymbol(content, position);
      matches.push({
        slug: "cfg-litellm-yaml",
        label: "LiteLLM model mapping",
        snippet: match[0].trim().slice(0, 240),
        enclosingSymbolPath: symbol,
        normalizedCallShape: {
          callee: "litellm.model_list",
          argumentKeys: ["litellm_params", "model_name"],
          enclosing: symbol,
        },
        needsTools: false,
        needsStructuredOutput: false,
        modelId: match[1],
        line: content.slice(0, position).split("\n").length,
      });
    }
    return matches;
  },
};

const modelEnvironmentMatcher: Matcher = {
  slug: "cfg-model-env-var",
  description: "Model identifiers pinned in environment-style configuration",
  noiseTier: "normal",
  filePatterns: ["**/.env", "**/.env.*", "**/*.{env,yaml,yml,toml}"],
  examples: ["OPENAI_MODEL=acme/large-1"],
  match(content): CandidateMatch[] {
    const matches: CandidateMatch[] = [];
    const pattern =
      /^\s*((?:OPENAI|ANTHROPIC|LITELLM|LANGCHAIN|AI)_MODEL(?:_ID|_NAME)?)\s*[:=]\s*["']?([^\s"']+)["']?/gm;
    for (const match of content.matchAll(pattern)) {
      const position = match.index;
      const candidate = candidateFromText({
        slug: "cfg-model-env-var",
        label: "Model environment variable",
        content,
        position,
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

export const builtinMatchers: readonly Matcher[] = Object.freeze([
  ...callMatchers,
  litellmYamlMatcher,
  modelEnvironmentMatcher,
  ...breadthMatchers,
]);
