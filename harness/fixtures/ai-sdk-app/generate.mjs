import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { LegacyOpenTelemetry, OpenTelemetry } from "@ai-sdk/otel";
import { registerTelemetry } from "ai";
import * as v6 from "ai-v6";

import { extractOrderStream } from "./src/extract-stream.mjs";
import { extractOrder } from "./src/extract.mjs";
import { useSpecification } from "./src/provider.mjs";
import { summarizeStream } from "./src/summarize-stream.mjs";
import { summarize } from "./src/summarize.mjs";
import { supportAgent } from "./src/support-agent.mjs";
import { triage } from "./src/triage.mjs";

const [dialect, ...flags] = process.argv.slice(2);
if (!["v7-legacy", "v7-genai", "v6"].includes(dialect)) {
  throw new Error(
    "Usage: node generate.mjs <v7-legacy|v7-genai|v6> [--split] [--traces <n>]",
  );
}
const split = flags.includes("--split");
const tracesFlag = flags.indexOf("--traces");
const limit =
  tracesFlag === -1 ? Number.POSITIVE_INFINITY : Number(flags[tracesFlag + 1]);

let traceCount = 0;
let spanCount = 0;
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  idGenerator: {
    generateTraceId: () => (++traceCount).toString(16).padStart(32, "0"),
    generateSpanId: () => (++spanCount).toString(16).padStart(16, "0"),
  },
  resource: resourceFromAttributes({ "service.name": "ai-sdk-app" }),
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
trace.setGlobalTracerProvider(provider);

let sdk;
if (dialect === "v7-legacy") registerTelemetry(new LegacyOpenTelemetry());
if (dialect === "v7-genai") registerTelemetry(new OpenTelemetry());
if (dialect === "v6") {
  useSpecification("v3");
  sdk = {
    generateText: v6.generateText,
    streamText: v6.streamText,
    generateObject: v6.generateObject,
    streamObject: v6.streamObject,
    isStepCount: v6.stepCountIs,
  };
}

const articles = [
  "The city council voted to fund repairs on the harbor bridge next spring.",
  "Volunteers planted two hundred trees along the river path on Saturday.",
  "The regional library will keep three branches open later on weekends.",
  "Transit officials postponed a planned fare increase until next year.",
  "The school board approved a tutoring program for middle school students.",
  "A new bike lane opened on Main Street after months of construction.",
];
const tickets = [
  "I was charged twice for my monthly plan.",
  "My package has not arrived after two weeks.",
  "The app crashes whenever I open the settings page.",
  "Please update the billing address on my account.",
  "The tracking page says my order is stuck in transit.",
  "I cannot sign in after resetting my password.",
];
const orderProblems = [
  "arrived damaged and needs a replacement today.",
  "is missing one of the three items that were ordered.",
  "was delivered to the wrong building last night.",
  "has shown no tracking update for a week.",
];

const article = (index) =>
  `Article ${index}: ${articles[index % articles.length]}`;
const ticket = (index) => `Ticket ${index}: ${tickets[index % tickets.length]}`;
const orderTicket = (index) =>
  `Ticket ${index}: Order ORD-${300 + index} ${orderProblems[index % orderProblems.length]}`;
const repeat = (count, call) =>
  Array.from({ length: count }, (_, index) => () => call(index));

async function streamedText(input) {
  const result = await summarizeStream(input, sdk);
  for await (const _ of result.textStream);
}

async function abortedText(input) {
  const controller = new AbortController();
  const result = await summarizeStream(input, sdk, controller.signal);
  try {
    for await (const _ of result.textStream) controller.abort();
  } catch {}
}

async function streamedObject(input) {
  const result = await extractOrderStream(input, sdk);
  for await (const _ of result.partialObjectStream);
  await result.object;
}

const calls = [
  () =>
    summarize(
      "Contact demo.person@example.test or +1-202-555-0147 about the cooling center schedule.",
      sdk,
    ),
  () => supportAgent("Where is order ORD-104?", sdk),
  () => extractOrder(orderTicket(0), sdk),
  () => streamedObject(orderTicket(1)),
  () => streamedText(article(1)),
  () => triage(ticket(0), sdk),
  () => abortedText(article(2)),
  () => summarize(article(3), sdk),
  ...repeat(30, (index) => summarize(article(4 + index), sdk)),
  ...repeat(31, (index) => streamedText(article(34 + index))),
  ...repeat(63, (index) => triage(ticket(1 + index), sdk)),
  ...repeat(5, (index) =>
    supportAgent(`Where is order ORD-${200 + index}?`, sdk),
  ),
  ...repeat(4, (index) => extractOrder(orderTicket(2 + index), sdk)),
  ...repeat(4, (index) => streamedObject(orderTicket(6 + index))),
];

for (const call of calls.slice(0, limit)) await call();

await provider.forceFlush();
const spans = exporter.getFinishedSpans();
const lines = split
  ? spans.map((span) => [span])
  : [...Map.groupBy(spans, (span) => span.spanContext().traceId).values()];
for (const line of lines) {
  process.stdout.write(
    `${new TextDecoder().decode(JsonTraceSerializer.serializeRequest(line))}\n`,
  );
}
