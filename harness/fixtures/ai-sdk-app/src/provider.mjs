import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { MockLanguageModelV3 } from "ai-v6/test";

const summaries = [
  "the council approved the budget.",
  "the library extended its weekend hours.",
  "the transit board delayed the fare change.",
  "the school district hired more tutors.",
  "the parks department opened a new trail.",
];
const categories = ["billing", "shipping", "technical"];
const customers = ["Dana", "Kai", "Mara", "Theo"];
const urgencies = ["low", "normal", "high"];

let MockLanguageModel = MockLanguageModelV4;

export function useSpecification(specification = "v4") {
  MockLanguageModel =
    specification === "v3" ? MockLanguageModelV3 : MockLanguageModelV4;
}

function hash(text) {
  let value = 2166136261;
  for (const character of text) {
    value = Math.imul(value ^ character.codePointAt(0), 16777619) >>> 0;
  }
  return value;
}

function partText(part) {
  if (part.type === "text" || part.type === "reasoning") return part.text;
  if (part.type === "tool-call") return JSON.stringify(part.input);
  if (part.type === "tool-result") return JSON.stringify(part.output);
  return "";
}

function messageText(message) {
  return typeof message.content === "string"
    ? message.content
    : message.content.map(partText).join("");
}

function orderId(text) {
  return text.match(/ORD-\d+/)?.[0] ?? "ORD-000";
}

function respond({ prompt, tools, responseFormat }) {
  const system = prompt
    .filter(({ role }) => role === "system")
    .map(messageText)
    .join("\n");
  const user = messageText(
    prompt.findLast(({ role }) => role === "user") ?? { content: "" },
  );
  const key = hash(user);
  const toolResult = prompt
    .filter(({ role }) => role === "tool")
    .flatMap(({ content }) => content)
    .find(({ type }) => type === "tool-result");

  let content;
  let finishReason = "stop";
  if (toolResult !== undefined) {
    content = {
      type: "text",
      text: `Order ${toolResult.output.value.orderId} ships on Tuesday.`,
    };
  } else if (tools !== undefined && tools.length > 0) {
    content = {
      type: "tool-call",
      toolCallId: `call-${key.toString(16)}`,
      toolName: "lookup_order",
      input: JSON.stringify({ orderId: orderId(user) }),
    };
    finishReason = "tool-calls";
  } else if (responseFormat?.type === "json") {
    content = {
      type: "text",
      text: JSON.stringify({
        customer: customers[key % customers.length],
        orderId: orderId(user),
        urgency: urgencies[key % urgencies.length],
      }),
    };
  } else if (system.startsWith("Classify")) {
    content = { type: "text", text: categories[key % categories.length] };
  } else {
    content = {
      type: "text",
      text: `Summary ${key % 100}: ${summaries[key % summaries.length]}`,
    };
  }

  const inputTokens = Math.ceil(prompt.map(messageText).join("").length / 4);
  const outputTokens = Math.ceil(partText(content).length / 4);
  return {
    content,
    finishReason: { unified: finishReason, raw: finishReason },
    usage: {
      inputTokens: {
        total: inputTokens,
        noCache: inputTokens,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: {
        total: outputTokens,
        text: outputTokens,
        reasoning: undefined,
      },
    },
  };
}

function streamParts({ content, finishReason, usage }) {
  if (content.type !== "text") {
    return [
      { type: "stream-start", warnings: [] },
      content,
      { type: "finish", finishReason, usage },
    ];
  }
  const size = Math.ceil(content.text.length / 3);
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "text-0" },
    ...[0, 1, 2].map((index) => ({
      type: "text-delta",
      id: "text-0",
      delta: content.text.slice(index * size, (index + 1) * size),
    })),
    { type: "text-end", id: "text-0" },
    { type: "finish", finishReason, usage },
  ];
}

export function acme(modelId) {
  return new MockLanguageModel({
    provider: "acme.chat",
    modelId,
    doGenerate: async (options) => {
      const { content, finishReason, usage } = respond(options);
      return { content: [content], finishReason, usage, warnings: [] };
    },
    doStream: async (options) => ({
      stream: simulateReadableStream({
        chunks: streamParts(respond(options)),
        chunkDelayInMs: 5,
      }),
    }),
  });
}
