# LangChain4j harness

## Live docs first

- [LangChain4j OpenAI integration](https://docs.langchain4j.dev/integrations/language-models/open-ai/)
- [AI Services](https://docs.langchain4j.dev/tutorials/ai-services/)
- [Tools](https://docs.langchain4j.dev/tutorials/tools/)

Fetch these pages before acting and identify whether the repository uses the standard or official
OpenAI integration and whether Spring Boot autoconfiguration owns the model.

## Where the model id is bound

Plain Java binds it with `OpenAiChatModel.builder().modelName(...)` or default request parameters.
Spring Boot binds `langchain4j.open-ai.chat-model.model-name`. An AI Service receives the built
`ChatModel` and may share it with several interfaces.

Create or inject a candidate model only for the scanned AI Service. Verify response metadata and
the stored execution identify the candidate.

## Correlation forwarding

LangChain4j does not copy servlet headers or `InvocationParameters` into provider HTTP headers.
The OpenAI builder supports custom headers, and Spring Boot exposes
`langchain4j.open-ai.chat-model.custom-headers`.

Set `x-rm-step` and a fresh `x-rm-call` per logical chat request. If one `ChatModel` loops, use a
request/transport wrapper rather than immutable client defaults for the call ID.

## Base URL override

Use `OPENAI_BASE_URL` as the harness variable and wire
`.baseUrl(System.getenv("OPENAI_BASE_URL"))`. Spring Boot's property is
`langchain4j.open-ai.chat-model.base-url`; map it from `${OPENAI_BASE_URL}`.

The official integration also documents `.baseUrl(...)`. A literal URL pins the route.

## Side-effect mocking

Replace objects containing `@Tool` methods, dynamic `ToolProvider` results, or low-level tool
executors before building the AI Service. Preserve annotations/specifications, canonicalize
arguments, and return the recorded value for the matching occurrence.

Throw on unknown, drifted, duplicate, or missing calls. Preserve tool execution result IDs and
ordering when feeding results back to the model.

## Entry point

Call one AI Service interface method, such as `assistant.chat(recordedMessage)`. For dynamic
parameters, pass the same `ChatRequestParameters` and `InvocationParameters` used by production.

Wrap that method in a one-case Java main only when process isolation is required. Emit calls,
tools, and terminal return value as JSON.

## Coupling detection

Inspect AI Service tools, chat memory, RAG content, agentic services, service-as-tool composition,
and Java control flow consuming the returned value. Shared memory and another AI Service call are
downstream coupling.

Confirm coupled services end to end. Compare model-call and tool order, arguments/results, memory
effects inside the harness, terminal value, and deterministic checks; sequence divergence fails.
