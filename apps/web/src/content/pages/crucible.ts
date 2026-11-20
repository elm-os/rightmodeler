// Markdown twin of the /crucible route (src/app/crucible/page.tsx, plus the feature wall in
// src/components/sections/crucible-showcase.tsx). Keep this file in sync with those pages.

import {
  CRUCIBLE_DOWNLOAD_COMMAND,
  CRUCIBLE_QUICKSTART_URL,
  CRUCIBLE_SEND_COMMAND,
  CRUCIBLE_SETUP_COMMAND,
  CRUCIBLE_START_COMMAND,
} from "@/lib/crucible";
import { CRUCIBLE_REPO_URL, REPO_URL } from "@/lib/site";

export const markdown = `# Crucible: open-source observability for AI agents and MCP servers.

Open source · Self-hosted

Built in Rust and engineered for speed and throughput. Use it for agents, for MCP servers, or both, with an agent's tool calls linked to the server-side MCP spans.

Crucible on GitHub: ${CRUCIBLE_REPO_URL}

## TL;DR

Crucible is one Rust binary. It ingests OpenTelemetry traces over HTTP and gRPC, writes every request to disk before it acknowledges it, and stores telemetry in ClickHouse, with Postgres as the control plane. It serves a web UI, a REST API and an MCP server, so **coding agents can query their own traces**.

## What Crucible gives you

### What it shows

- **Traces and sessions**
  Traces, spans, sessions and users, with a timeline, an agent graph and full-text search.
- **Cost and latency**
  The cost, tokens and latency of every trace and span, with p50 to p99 latency and dashboards to chart them.
- **MCP servers**
  Every MCP call recorded and linked to the agent's tool call through trace context, with analytics by server, tool, error, client, user, session and deploy, for the server or the client side.

### How it runs

- **Yours to run**
  Self-hosted, with organizations, projects, roles and API keys, retention settings, deletion requests and optional media storage on S3-compatible object storage.
- **Instrumented your way**
  OpenTelemetry from any SDK or instrumentation library, Crucible's SDKs for TypeScript, Python, Go and Rust, or an MCP proxy that needs no code changes.
- **Alerts, SQL and exports**
  Alerts on span and MCP call measures to Slack, email and signed webhooks, a read-only SQL workspace isolated by ClickHouse itself, and trace exports.

How it works

## One binary, from span to screen.

Crucible runs beside ClickHouse and Postgres, and every span takes the same four steps through it.

### 01 Send

Your agents and MCP servers send OpenTelemetry traces over HTTP or gRPC, from any OpenTelemetry SDK or instrumentation library, from Crucible's SDKs, or through the MCP proxy, which needs no code changes.

### 02 Write ahead

Crucible validates each request in a single pass over its bytes, then appends it to a write-ahead log. Concurrent requests share one fsync, and your app gets its acknowledgment only once its spans are on disk.

### 03 Store once

A shipper batches spans into ClickHouse in its native column format, compressed. Each insert carries a token from its place in the log, so a retry after a timeout or a crash never stores a span twice.

### 04 Read

Recent spans sit in an in-memory index, so a trace can be read as soon as it is acknowledged. The web UI, the REST API, the SQL workspace and the MCP server read the same data, and alerts and exports run on it.

The stack: One Rust binary · OpenTelemetry traces · ClickHouse 26.3 or newer · Postgres 15 or newer

Why we built it

## You cannot maintain what you cannot see.

rightmodeler takes the work out of the loop, not the judgment, and that work starts with seeing what your production AI systems do: every model call, what it cost, how long it took, and every MCP tool it reached. We built Crucible to be that instrument panel, and to keep up with the traffic agents produce.

### Built in Rust, for speed and throughput.

Agent traffic is heavy: long prompts, large tool payloads, and bursts of spans when agents fan out. Crucible is written in Rust with no unsafe code, and its ingest path is built to do as little work per span as it can.

The ingest path, as built:

- **parse**: one pass over the request bytes, no copies, no allocation
- **commit**: group commit: concurrent requests share one fsync
- **encode**: ClickHouse's native column format, LZ4, built in process
- **insert**: one insert per batch and partition, resent byte for byte
- **memory**: fixed byte budgets, then 429 or 503 with Retry-After
- **build**: opt-level 3, thin LTO, one codegen unit, mimalloc

### Every acknowledged span is on disk.

Crucible acknowledges a request only after its spans are written to the log and synced, and a batch that ClickHouse never confirmed is sent again after a crash with the same token, so it lands once. We test this with deterministic simulation that injects disk, network, ClickHouse and crash faults, swarm testing across configurations, a formal model of the ingest protocol, and machine-checked proofs of the log format.

### Both sides of the tool call.

When an agent's MCP client passes trace context with each request, as Crucible's SDKs do, the agent's tool call and the server's span of it land in one trace. A slow or failing tool shows up where the agent felt it.

### Yours to run.

Crucible is open source under the MIT license and runs on infrastructure you control: your traces stay in your ClickHouse, and your accounts, projects and keys in your Postgres.

Get started

## Run it on your own machine.

All you need is Docker. Download the Compose file, start Crucible with a bundled ClickHouse and Postgres, and send your first trace.

### 01 Get the Compose file

Needs Docker; makes a crucible folder for the Compose file, which runs the published Crucible image.

    ${CRUCIBLE_DOWNLOAD_COMMAND}

### 02 Start the stack

In bash or zsh: writes three secrets to .env, then starts ClickHouse, Postgres and Crucible.

    ${CRUCIBLE_START_COMMAND}

### 03 Create your organization

Prints the one-time setup link.

    ${CRUCIBLE_SETUP_COMMAND}

Open the printed /setup/ link on http://127.0.0.1:8080, create your organization and its owner, then create an API key under Settings, then API keys.

### 04 Send traces

Point any OpenTelemetry exporter at Crucible.

    ${CRUCIBLE_SEND_COMMAND}

Your traces appear at http://127.0.0.1:8080/traces/ as soon as Crucible acknowledges them.

The quickstart in the Crucible docs walks through each step in more detail: ${CRUCIBLE_QUICKSTART_URL}

Works with rightmodeler


crucible export writes your traces as OpenTelemetry JSON, and the rightmodeler CLI replays them to validate cheaper or newer models against the outputs you accepted. Crucible does not run the validation loop itself. Coding agents can also ask Crucible about their runs through its MCP server.

rightmodeler on GitHub: ${REPO_URL}

## FAQ

### What is Crucible?

Open-source, self-hosted observability and analytics for AI agents and MCP servers, under the MIT license. It is one Rust binary that ingests OpenTelemetry traces and serves a web UI, a REST API and an MCP server, with ClickHouse for telemetry and Postgres for the control plane.

### How do I send it data?

Send OTLP traces over HTTP, as protobuf or JSON, or over gRPC, from any OpenTelemetry SDK or exporter. Spans from OpenInference, OpenLLMetry, the Vercel AI SDK, MLflow and Pydantic AI are mapped as they arrive. Crucible's SDKs for TypeScript, Python, Go and Rust, in the repository's sdk folder, add agent helpers and an MCP server wrapper, and the MCP proxy records an MCP server's calls with no code changes and forwards its traffic unchanged.

### How do I install it?

With Docker: the Compose file runs the published Crucible image, for amd64 and arm64, beside a bundled ClickHouse and Postgres. Or install the crucible binary from the GitHub release with its shell or PowerShell installer. The durability described below holds on Linux and macOS; the Windows binary is for development.

### Is it for agents or for MCP servers?

Either, or both. Use it for agents only, for MCP servers only, or for both together, with an agent's tool calls linked to the server-side MCP spans through trace context.

### Where does my data live?

On infrastructure you run. Crucible is self-hosted only: telemetry goes to a single-node ClickHouse, version 26.3 or newer, and accounts, projects and keys go to Postgres 15 or newer. The Docker Compose stack bundles both.

### Why Rust?

For speed, throughput and predictable memory. Crucible parses OTLP without copying it, shares each fsync across concurrent requests, writes ClickHouse's native column format itself and holds memory inside fixed budgets, with no garbage collector pausing ingest. It all runs as one binary next to ClickHouse and Postgres.

### How does it avoid losing spans?

It acknowledges a request only after its spans are written to a write-ahead log and synced to disk, and each batch reaches ClickHouse with a deduplication token, so a retry never stores a span twice. When it is saturated, it answers 429 or 503 with Retry-After instead of dropping data. We test this with deterministic simulation that injects faults, swarm testing, a formal model of the ingest protocol and proofs of the log format.

### How does it work with rightmodeler?

crucible export writes your traces as OpenTelemetry JSON, and the rightmodeler CLI replays them to validate cheaper or newer models against the outputs you accepted. Crucible does not run the validation loop or swap models. Coding agents can also ask Crucible about their runs through its MCP server, whose tools list and search traces, read spans and payloads, report MCP server analytics and create exports.

### Is there a hosted version?

No. Crucible is self-hosted only: you run it, with your own ClickHouse and Postgres, wherever you run Docker or its binary.
`;
