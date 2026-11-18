// Markdown twin of the /crucible route (src/app/crucible/page.tsx, plus the feature wall in
// src/components/sections/crucible-showcase.tsx). Keep this file in sync with those pages.

import { CRUCIBLE_REPO_URL, REPO_URL } from "@/lib/site";

export const markdown = `# Crucible: open-source observability for AI agents and MCP servers.

In development · built in the open

Self-hosted observability and analytics, MIT licensed. It is designed for agents only, MCP servers only, or both, with an agent's tool calls linked to the server-side MCP spans. Nothing is released yet.

Follow Crucible on GitHub: ${CRUCIBLE_REPO_URL}

Star or watch the repository to follow development.

## TL;DR

Crucible is being built as one Rust binary. It will ingest OpenTelemetry (OTLP over HTTP and gRPC) and serve a REST API, a web UI and an MCP server, so **coding agents will be able to query their own traces**. Telemetry will be stored in ClickHouse, self-hosted or ClickHouse Cloud, your choice, and Postgres will be the control plane.

## What Crucible will give you

### What it will show

- **Traces and sessions**
  Will show traces, spans, sessions and users, with full-text search across them.
- **Cost and latency**
  Will put cost and latency on every trace, so a slow or expensive step will not hide in an aggregate.
- **MCP analytics**
  Will report tool calls, error classes, latency percentiles and clients for each MCP server, and compare deploys.

### How it will run

- **Yours to run**
  Will be self-hosted only, with retention and deletion, and organizations, projects, roles and API keys.
- **Instrumented your way**
  Will take OTLP from any OpenTelemetry SDK, from thin SDKs for TypeScript, Python, Go and Rust, or from an opt-in MCP proxy that needs no code changes.
- **Alerts and dashboards**
  Will send alerts to Slack, email and webhooks, with custom dashboards and a guardrailed, read-only SQL workspace.

## Available today: the CLI and the agent

Crucible itself is in development. rightmodeler will replay Crucible traces to validate cheaper or newer models, and agents will be able to ask Crucible about their runs over MCP. The rightmodeler CLI is on npm now, and the self-hosted agent runs it on a schedule today.

rightmodeler on GitHub: ${REPO_URL}

## FAQ

### What is Crucible?

An open-source, self-hosted observability and analytics platform for AI agents and MCP servers, being built in the open on GitHub under the MIT license. It is planned as one Rust binary that will ingest OpenTelemetry and serve a REST API, a web UI and an MCP server. Nothing is released yet.

### When can I use it?

Not yet. Crucible is in development and nothing has shipped; star or watch the repository on GitHub to follow along. Today you can run the rightmodeler CLI from npm and self-host the agent, which runs the maintenance loop on a schedule and replays new candidates on your word.

### How will I send it data?

Three ways are planned: OTLP over HTTP or gRPC from any OpenTelemetry SDK; thin SDKs for TypeScript, Python, Go and Rust, with agent helpers and an MCP server wrapper; and an opt-in proxy that instruments an MCP server with no code changes and forwards bytes unchanged.

### Is it for agents or for MCP servers?

Either, or both. It is designed for agents only, for MCP servers only, or for both together, with an agent's tool calls linked to the server-side MCP spans.

### Where will my data live?

On infrastructure you run: Crucible is self-hosted only. Telemetry will be stored in ClickHouse, self-hosted or ClickHouse Cloud, your choice, and Postgres will be the control plane.

### How will it work with rightmodeler?

rightmodeler will replay Crucible traces, through a Crucible export adapter, to validate cheaper or newer models against the outputs you accepted. Coding agents will also be able to ask Crucible about their runs through its MCP server.

### How is it being built?

In the open, with durability and correctness as design goals: a span will be acknowledged only after it is durable on disk, and the system will be tested with deterministic simulation and formal models.
`;
