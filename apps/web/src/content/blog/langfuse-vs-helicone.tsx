// Post: "Langfuse vs Helicone", a practitioner comparison of the two products, built only from
// each vendor's own documentation and announcements as read on 2026-09-24. A typed post module:
// `meta` (data) plus a `Body` composed from the prose primitives. Vendor figures (latency,
// markup, model counts, accuracy labels) are attributed to the vendor, never presented as ours.
// rightmodeler appears only in the final section, where model-substitution testing belongs. The
// comparison is a list and prose rather than CompareTable: that component styles its right column
// as "ours", and the blog parity check rejects self-closing components in Body.

import { A, H2, LI, Lead, P, Prose, Strong, UL } from "@/components/blog/prose";
import type { PostMeta } from "@/content/blog/types";

export const meta: PostMeta = {
  slug: "langfuse-vs-helicone",
  title:
    "Langfuse vs Helicone: tracing, evaluation, gateways, and cost analysis.",
  description:
    "Langfuse instruments your code; Helicone sits in the request path. How they compare on tracing, evals, prompts, gateways, caching, cost, and self-hosting.",
  excerpt:
    "Two open-source answers built from opposite ends: what each vendor’s docs say about tracing, evaluation, gateways, caching and cost, where both companies stand, and when to run both.",
  kicker: "Comparison · Observability",
  date: "2026-09-24",
  readingMinutes: 11,
  hero: {
    src: "/blog/langfuse-vs-helicone-hero.jpg",
    alt: "A warm parchment field with two long watercolor strokes running side by side, one soft grey, one washed from violet into orange.",
  },
};

export function Body() {
  return (
    <Prose>
      <Lead>
        You want to see what your LLM application is doing and what it costs.
        Langfuse and Helicone are both open-source answers to that question, and
        they start from opposite ends. Langfuse instruments your application
        code. Helicone sits in the request path as a gateway. Almost every
        difference below follows from that one choice.
      </Lead>

      <P>
        Everything here comes from each vendor&rsquo;s own documentation and
        announcements, read on{" "}
        <span className="whitespace-nowrap">2026-09-24</span>. Both companies
        were acquired this year, so status comes first, then the products
        dimension by dimension, then when each fits and what to do once you know
        which calls cost the most.
      </P>

      <H2>The short version</H2>

      <UL>
        <LI>
          <Strong>Instrumentation.</Strong> Langfuse uses SDKs built on
          OpenTelemetry, or any OpenTelemetry exporter, and stays out of the
          request path. Helicone takes a base URL change to its AI Gateway; an
          async mode exists, but it gives up the gateway features.
        </LI>
        <LI>
          <Strong>Tracing.</Strong> Langfuse records nested trees of typed
          observations grouped into sessions. Helicone logs one row per request
          and builds sessions and trees from headers you send.
        </LI>
        <LI>
          <Strong>Evaluation.</Strong> Langfuse runs evaluations:
          LLM-as-a-judge, code evaluators, annotation queues, datasets,
          experiments, and CI checks. Helicone stores scores and feedback
          computed elsewhere and says it is not an evaluation framework.
        </LI>
        <LI>
          <Strong>Prompts.</Strong> Both version prompts outside your code.
          Langfuse serves them through its SDKs with a client-side cache;
          Helicone can assemble them inside the gateway from a prompt ID.
        </LI>
        <LI>
          <Strong>Gateway and caching.</Strong> Helicone routes across
          providers, fails over, caches responses at the edge, and enforces rate
          limits. Langfuse does none of that by design and pairs with a gateway
          instead.
        </LI>
        <LI>
          <Strong>Cost.</Strong> Both compute per-call cost and slice spend by
          user, session, and custom dimensions.
        </LI>
        <LI>
          <Strong>Self-hosting.</Strong> Langfuse&rsquo;s core is MIT-licensed,
          with enterprise add-ons under a separate license. Helicone is Apache
          2.0.
        </LI>
        <LI>
          <Strong>Status.</Strong> ClickHouse acquired Langfuse, announced{" "}
          <span className="whitespace-nowrap">2026-01-16</span>, and Langfuse
          stays open source. Mintlify acquired Helicone, announced{" "}
          <span className="whitespace-nowrap">2026-03-03</span>, and its
          services stay live in maintenance mode.
        </LI>
      </UL>

      <H2>Where both companies stand</H2>

      <P>
        Langfuse{" "}
        <A href="https://langfuse.com/blog/joining-clickhouse">
          announced on <span className="whitespace-nowrap">2026-01-16</span>
        </A>{" "}
        that ClickHouse had acquired it. The post says Langfuse stays open
        source and self-hostable with no planned licensing changes, that
        Langfuse Cloud keeps running with the same endpoints, and that the whole
        team is joining ClickHouse to keep building the product. The two were
        already close: Langfuse moved its core data layer to ClickHouse with its
        v3 release.
      </P>

      <P>
        Helicone{" "}
        <A href="https://www.helicone.ai/blog/joining-mintlify">
          announced on <span className="whitespace-nowrap">2026-03-03</span>
        </A>{" "}
        that Mintlify had acquired it and that its team is joining Mintlify. In
        Helicone&rsquo;s words, its services will remain live for the
        foreseeable future in maintenance mode, which it spells out as security
        updates, new models, and bug and performance fixes that keep shipping.
        The public repository matches that description: as of{" "}
        <span className="whitespace-nowrap">2026-09-24</span>, the{" "}
        <A href="https://github.com/Helicone/helicone/commit/067d9290acb4f1fc9320e902fc67b4b399b50363">
          latest commit on its main branch
        </A>{" "}
        is a security fix dated{" "}
        <span className="whitespace-nowrap">2026-09-16</span>.
      </P>

      <P>
        Neither announcement changes how either product works today. Maintenance
        mode still matters for a long-lived decision, more for the system that
        holds your evaluation history and prompt versions than for a gateway
        behind one base URL.
      </P>

      <H2>Instrumentation: in your code or in the request path</H2>

      <P>
        Langfuse&rsquo;s{" "}
        <A href="https://langfuse.com/docs/observability/sdk/overview">SDKs</A>,
        Python v4 and JS/TS v5 as of{" "}
        <span className="whitespace-nowrap">2026-09-24</span>, are built on
        OpenTelemetry. You wrap functions or open observations in code, and the
        SDK queues events and flushes them in batches in the background.
        Langfuse says this adds almost no latency and that SDK errors are caught
        and logged rather than raised into your application. Anything that
        already emits OpenTelemetry can send OTLP straight to Langfuse&rsquo;s
        /api/public/otel endpoint, and Langfuse maintains integrations for a
        long list of agent frameworks and model SDKs.
      </P>

      <P>
        One date matters if you wrote a custom integration: on Langfuse Cloud,
        the legacy POST /api/public/ingestion endpoint stops accepting
        everything except scores on November 16, 2026, and Langfuse&rsquo;s{" "}
        <A href="https://langfuse.com/integrations/native/opentelemetry/migration-to-v4">
          ingestion migration guide
        </A>{" "}
        moves that code to OpenTelemetry.
      </P>

      <P>
        Helicone&rsquo;s primary integration is a base URL. Point the OpenAI SDK
        at{" "}
        <span className="whitespace-nowrap">
          https://ai-gateway.helicone.ai
        </span>{" "}
        with a Helicone API key, and every request is forwarded, logged with its
        cost, latency, and errors, and returned. Helicone runs its proxy on
        Cloudflare Workers and publishes{" "}
        <A href="https://docs.helicone.ai/references/latency-affect">
          its own benchmark
        </A>{" "}
        showing proxied latency closely matching direct calls to OpenAI. If you
        would rather keep Helicone off the critical path, its async integration
        logs through OpenLLMetry or a manual logger, but Helicone&rsquo;s own{" "}
        <A href="https://docs.helicone.ai/references/proxy-vs-async">
          comparison table
        </A>{" "}
        marks caching, retries, and custom rate limits as proxy-only.
      </P>

      <P>
        The trade is the usual one. A proxy captures everything from one line of
        configuration and can act on each request, and it becomes a dependency
        of every call. SDK instrumentation stays out of the path and sees the
        structure of your code, and it asks for code changes wherever you want
        detail.
      </P>

      <H2>Tracing, sessions, and agents</H2>

      <P>
        Langfuse models a trace as a tree of{" "}
        <A href="https://langfuse.com/docs/observability/features/observation-types">
          typed observations
        </A>
        : spans, generations, agents, tools, chains, retrievers, embeddings,
        evaluators, guardrails, and events. Framework integrations set the types
        for you. Propagate a session ID and traces group into a session you can
        replay, share as a public link, bookmark, or score by hand. Agent
        graphs, user tracking, tags, environments, and full-text search sit on
        top.
      </P>

      <P>
        Helicone&rsquo;s unit is the request. Three{" "}
        <A href="https://docs.helicone.ai/features/sessions">session headers</A>
        , <span className="whitespace-nowrap">Helicone-Session-Id</span>,{" "}
        <span className="whitespace-nowrap">Helicone-Session-Path</span>, and{" "}
        <span className="whitespace-nowrap">Helicone-Session-Name</span>, group
        requests into a session, and path syntax such as /abstract/outline
        builds the parent-child tree. Sessions can include vector database
        queries and tool calls logged through Helicone&rsquo;s logger SDKs, not
        only model calls. Custom properties, sent as headers named{" "}
        <span className="whitespace-nowrap">Helicone-Property-</span> followed
        by the property name, tag each request for filtering and segmentation.
      </P>

      <P>
        For a chat app or a short chain, either view is enough. For a multi-step
        agent whose failures happen between model calls, the difference is where
        the structure comes from: Langfuse captures it from your code, and
        Helicone reconstructs it from the session paths you send.
      </P>

      <H2>Evaluation, datasets, and experiments</H2>

      <P>
        This is the widest gap between the two. Langfuse runs{" "}
        <A href="https://langfuse.com/docs/evaluation/overview">evaluations</A>.
        Managed LLM-as-a-judge evaluators score live observations or experiment
        runs, with numeric, categorical, or boolean results. Code evaluators
        handle deterministic checks, annotation queues route traces to human
        reviewers, and scores also arrive through the UI, the API, or the SDKs.
        Datasets hold inputs and expected outputs, often built from production
        traces, and experiments run your application over a dataset from the UI,
        the SDK, or OpenTelemetry so you can compare runs side by side. The{" "}
        <span className="whitespace-nowrap">langfuse/experiment-action</span>{" "}
        GitHub Action fails the job in a pull request workflow when your
        experiment script flags a score that violates your threshold. Since{" "}
        <A href="https://langfuse.com/blog/2025-06-04-open-sourcing-langfuse-product">
          June 2025
        </A>
        , the judge, playground, prompt experiments, and annotation features
        have been MIT-licensed along with the rest of the core.
      </P>

      <P>
        Helicone is explicit about its scope. Its{" "}
        <A href="https://docs.helicone.ai/features/advanced-usage/scores">
          scores documentation
        </A>{" "}
        says it does not run evaluations and is not an evaluation framework. It
        stores the scores you compute elsewhere, as integers or booleans
        attached to a request through the API or the dashboard, alongside user
        feedback. Its Datasets feature curates logged requests into sets you
        export as JSONL for fine-tuning or CSV for analysis. Helicone&rsquo;s
        prompt Experiments feature is marked deprecated in its docs, with
        removal dated September 1, 2025.
      </P>

      <P>
        If running evaluations is the job you are hiring a tool for, Langfuse is
        built for it and Helicone says it is not.
      </P>

      <H2>Prompt management</H2>

      <P>
        Both keep prompts out of your deploy cycle. Langfuse{" "}
        <A href="https://langfuse.com/docs/prompt-management/overview">
          versions prompts
        </A>{" "}
        and promotes them with labels such as production and staging, with
        variables, composable prompts, config, a playground for side-by-side
        comparisons, webhooks, and a GitHub integration. Linking prompts to
        traces lets you compare versions on cost, latency, and quality. The SDKs
        cache prompts client-side; Langfuse says this adds no latency after
        first use, and you can pre-fetch prompts at startup or ship a fallback.
      </P>

      <P>
        Helicone versions prompts with environments for production, staging, and
        development, supports variables anywhere including tool schemas, and has
        its own playground. Its distinctive part is delivery: send a prompt_id
        and inputs to the AI Gateway, and it{" "}
        <A href="https://docs.helicone.ai/gateway/prompt-integration">
          assembles the prompt
        </A>{" "}
        on the way through, with no extra SDK in your application.
      </P>

      <H2>Gateway, routing, and rate limits</H2>

      <P>
        Helicone&rsquo;s{" "}
        <A href="https://docs.helicone.ai/gateway/overview">AI Gateway</A> is
        one OpenAI-compatible endpoint for 100+ models, by Helicone&rsquo;s
        count. Request a model and, per Helicone&rsquo;s{" "}
        <A href="https://docs.helicone.ai/gateway/provider-routing">
          routing docs
        </A>
        , the gateway finds the providers that serve it, routes to the cheapest,
        load-balances providers of equal cost, and fails over on rate limits,
        timeouts, and server errors. You can pin one provider, target your own
        deployment, or write an explicit fallback chain. Your own provider keys
        are tried first, with Helicone&rsquo;s managed keys as the fallback,
        paid from credits that Helicone says carry 0% markup. Around that sit
        custom rate limits by request count or spend, set globally, per user, or
        per custom property, plus LLM security checks for prompt injection and
        handlers for requests that exceed a model&rsquo;s context window.
      </P>

      <P>
        Langfuse has no gateway and does not route, cache, or throttle model
        calls. It pairs with one: its integration docs cover LiteLLM Proxy,
        Portkey, OpenRouter, Vercel AI Gateway, Kong, TrueFoundry, and Helicone
        itself. Langfuse&rsquo;s LLM connections exist so its playground and
        judges can call models, not to carry your production traffic.
      </P>

      <H2>Caching</H2>

      <P>
        Helicone{" "}
        <A href="https://docs.helicone.ai/features/advanced-usage/caching">
          caches whole responses
        </A>{" "}
        at the edge, in Cloudflare Workers KV. You turn it on per request with
        the <span className="whitespace-nowrap">Helicone-Cache-Enabled</span>{" "}
        header. The cache key hashes the URL, the request body, and the relevant
        headers, so any parameter change is a miss.{" "}
        <span className="whitespace-nowrap">Cache-Control</span> sets the
        lifetime, seven days by default; a cache seed partitions entries, per
        user for example; and buckets store several responses for the same
        request. Separately, the gateway passes provider prompt caching through,
        which lowers the provider&rsquo;s rate for repeated prompt content
        rather than skipping the call.
      </P>

      <P>
        Langfuse&rsquo;s caching is about prompts, not responses: the SDK cache
        described above, plus server-side prompt caching. Response caching, if
        you want it, belongs to the gateway you pair it with.
      </P>

      <H2>Cost tracking and analytics</H2>

      <P>
        Both compute per-call cost and let you slice the spend. Langfuse{" "}
        <A href="https://langfuse.com/docs/observability/features/token-and-cost-tracking">
          records usage and cost
        </A>{" "}
        per usage type, such as input, output, and cached tokens, on every
        generation. Costs are either ingested from your integration or inferred
        from model definitions. Langfuse ships prices for popular OpenAI,
        Anthropic, and Google models, you add custom definitions with pricing
        tiers for anything else, and ingested values win when both exist. Custom
        dashboards, threshold alerts routed to Slack, GitHub Actions, or
        webhooks, and the Metrics API break cost and latency down by model,
        user, session, feature, release, and prompt version.
      </P>

      <P>
        Helicone{" "}
        <A href="https://docs.helicone.ai/guides/cookbooks/cost-tracking">
          computes cost at the gateway
        </A>{" "}
        from its model registry, which Helicone labels 100% accurate for gateway
        traffic, and falls back to a best-effort estimate from its open-source
        pricing repository of 300+ models for direct integrations. Sessions show
        what a whole interaction cost, custom properties slice spend by feature,
        user tier, or environment, and alerts fire on cost, error rate, latency,
        or token counts. Weekly reports go to email or Slack. HQL lets you query
        request data in SQL; as of{" "}
        <span className="whitespace-nowrap">2026-09-24</span> it is available to
        selected workspaces.
      </P>

      <P>
        A cost view answers where the money goes. It cannot say whether a
        cheaper model would have produced an acceptable answer on those same
        calls. That takes a replay, which is where the last section picks up.
      </P>

      <H2>Self-hosting and licensing</H2>

      <P>
        Langfuse&rsquo;s repository license puts everything outside its ee
        directories under MIT, and since June 2025 that core includes
        evaluation, the playground, experiments, and annotation. A license key
        unlocks enterprise add-ons such as SCIM, audit logs, data retention
        policies, and project-level RBAC. Self-hosted Langfuse{" "}
        <A href="https://langfuse.com/self-hosting">
          runs the same codebase as Langfuse Cloud
        </A>
        : web and worker containers on Postgres, ClickHouse, Redis or Valkey,
        and S3-compatible storage, with Docker Compose for local use and Helm or
        Terraform modules for AWS, Azure, and GCP in production.
      </P>

      <P>
        Helicone is{" "}
        <A href="https://docs.helicone.ai/references/open-source">
          licensed under Apache 2.0
        </A>
        . Its docs cover an all-in-one Docker image, Kubernetes Helm charts,
        manual installation, and cloud deployment. One detail for anyone
        planning a self-hosted proxy: Helicone&rsquo;s Docker guide notes that
        its Jawn service no longer proxies model traffic, so you run the AI
        Gateway alongside it.
      </P>

      <H2>Getting your data out</H2>

      <P>
        Langfuse exposes a public API, an Observations API for row-level data, a
        Metrics API for aggregates, UI exports, a CLI, an MCP server, and an
        OpenAPI spec.{" "}
        <A href="https://langfuse.com/docs/api-and-data-platform/features/export-to-blob-storage">
          Scheduled exports
        </A>{" "}
        write to S3, Google Cloud Storage, or Azure Blob Storage anywhere from
        every 20 minutes to weekly; as of{" "}
        <span className="whitespace-nowrap">2026-09-24</span> that feature is
        available self-hosted, on Enterprise, or on Pro with the Teams add-on.
      </P>

      <P>
        Helicone exposes a REST API to query requests, with bodies included when
        you ask for them, and an{" "}
        <A href="https://docs.helicone.ai/guides/cookbooks/etl">export CLI</A>,
        @helicone/export, that writes JSON, JSONL, or CSV with date and property
        filters. Datasets export separately, and HQL covers ad hoc SQL.
        Whichever tool you run, a periodic export keeps your history portable.
      </P>

      <H2>When each fits</H2>

      <P>
        <Strong>Helicone fits when the problem is traffic.</Strong> You want one
        OpenAI-compatible endpoint across providers, failover, edge caching,
        rate limits by user or spend, and per-request cost, all from a base URL
        change. Weigh the maintenance-mode status against how long you expect to
        depend on it and on its roadmap.
      </P>

      <P>
        <Strong>
          Langfuse fits when the problem is quality and structure.
        </Strong>{" "}
        You want nested traces of agents, evaluations that run on live traffic
        and in CI, datasets and experiments, prompt management with client-side
        caching, and the option to self-host all of it under MIT.
      </P>

      <P>
        <Strong>
          Both fit when you want a gateway and an evaluation platform.
        </Strong>{" "}
        Langfuse{" "}
        <A href="https://langfuse.com/integrations/gateways/helicone">
          documents the combination
        </A>
        : point its OpenAI SDK wrapper at Helicone&rsquo;s AI Gateway base URL,
        and Helicone routes and caches while Langfuse traces and evaluates. Both
        will compute a cost for the same call, so pick one as the system of
        record for spend. Langfuse&rsquo;s{" "}
        <A href="https://langfuse.com/resources/engineering/migrate-from-helicone">
          Helicone migration guide
        </A>{" "}
        notes that the two capture mechanisms don&rsquo;t conflict, which is
        also what makes a gradual migration practical.
      </P>

      <H2>Once you know which calls cost the most</H2>

      <P>
        Both tools will show you which steps dominate the bill. The next
        question is whether each of those steps needs the model it runs on.
        Langfuse experiments can answer that on a curated dataset with
        evaluators you configure. The other route is the production traffic you
        have already recorded, judged against the outputs your team already
        accepted.
      </P>

      <P>
        That is the job{" "}
        <A href="https://github.com/elm-os/rightmodeler">rightmodeler</A> does.
        It is an MIT-licensed command-line tool that reads exported traces,
        replays recorded model calls through cheaper candidates from your
        provider&rsquo;s live model catalog, and judges every candidate against
        the output you shipped. The evidence rules are strict on purpose: a step
        family needs at least 10 assessed executions, two distinct step IDs, and
        five distinct trajectories, and below any of those it{" "}
        <A href="/glossary#abstain">abstains</A> with a named reason. Candidates
        are shortlisted on one half of the cases and must clear the{" "}
        <A href="/glossary#quality-floor">quality floor</A> again on held-out
        cases. When a family clears every gate, rightmodeler opens a draft pull
        request that changes model identifiers and nothing else, for a person to
        review and merge. It never sits in your request path.
      </P>

      <P>
        It has dedicated adapters for both tools. From Langfuse, export
        observations and rightmodeler replays the GENERATION records; pass{" "}
        <span className="whitespace-nowrap">--evaluator langfuse</span> and your
        own Langfuse scorers grade the replays, and the results can go back into
        a Langfuse dataset. From Helicone, export request rows with their bodies
        included; rows that share a{" "}
        <span className="whitespace-nowrap">Helicone-Session-Id</span> become
        one trajectory, so a multi-call agent run counts as one unit in the
        statistics rather than many. A plan mode previews the pipeline without
        spending anything, and a cost cap bounds replay spend. The exact export
        and run commands are in the{" "}
        <A href="/integrations/langfuse">Langfuse integration guide</A> and the{" "}
        <A href="/integrations/helicone">Helicone integration guide</A>.
      </P>

      <P>
        For how rightmodeler relates to each product in more depth, read{" "}
        <A href="/vs/langfuse">rightmodeler vs Langfuse</A> and{" "}
        <A href="/vs/helicone">rightmodeler vs Helicone</A>. If you are weighing
        evaluation platforms more broadly, we also compare it with{" "}
        <A href="/vs/braintrust">Braintrust</A> and{" "}
        <A href="/vs/langsmith">LangSmith</A>, and the{" "}
        <A href="/use-cases/reduce-llm-costs">reduce LLM costs</A> guide walks
        through the full workflow. For the levers beyond a model swap, such as
        caching, batching and compression, read{" "}
        <A href="/blog/llm-cost-optimization-tools">
          which LLM cost optimization approach fits your workload
        </A>
        .
      </P>
    </Prose>
  );
}

// The same post as clean Markdown, for llms-context.txt and any LLM-facing surface. Kept in sync with
// Body above by hand; the parity check in scripts/check-content.mjs enforces it.
export const markdown = `# Langfuse vs Helicone: tracing, evaluation, gateways, and cost analysis.

You want to see what your LLM application is doing and what it costs. Langfuse and Helicone are both open-source answers to that question, and they start from opposite ends. Langfuse instruments your application code. Helicone sits in the request path as a gateway. Almost every difference below follows from that one choice.

Everything here comes from each vendor's own documentation and announcements, read on 2026-09-24. Both companies were acquired this year, so status comes first, then the products dimension by dimension, then when each fits and what to do once you know which calls cost the most.

## The short version

- **Instrumentation.** Langfuse uses SDKs built on OpenTelemetry, or any OpenTelemetry exporter, and stays out of the request path. Helicone takes a base URL change to its AI Gateway; an async mode exists, but it gives up the gateway features.
- **Tracing.** Langfuse records nested trees of typed observations grouped into sessions. Helicone logs one row per request and builds sessions and trees from headers you send.
- **Evaluation.** Langfuse runs evaluations: LLM-as-a-judge, code evaluators, annotation queues, datasets, experiments, and CI checks. Helicone stores scores and feedback computed elsewhere and says it is not an evaluation framework.
- **Prompts.** Both version prompts outside your code. Langfuse serves them through its SDKs with a client-side cache; Helicone can assemble them inside the gateway from a prompt ID.
- **Gateway and caching.** Helicone routes across providers, fails over, caches responses at the edge, and enforces rate limits. Langfuse does none of that by design and pairs with a gateway instead.
- **Cost.** Both compute per-call cost and slice spend by user, session, and custom dimensions.
- **Self-hosting.** Langfuse's core is MIT-licensed, with enterprise add-ons under a separate license. Helicone is Apache 2.0.
- **Status.** ClickHouse acquired Langfuse, announced 2026-01-16, and Langfuse stays open source. Mintlify acquired Helicone, announced 2026-03-03, and its services stay live in maintenance mode.

## Where both companies stand

Langfuse [announced on 2026-01-16](https://langfuse.com/blog/joining-clickhouse) that ClickHouse had acquired it. The post says Langfuse stays open source and self-hostable with no planned licensing changes, that Langfuse Cloud keeps running with the same endpoints, and that the whole team is joining ClickHouse to keep building the product. The two were already close: Langfuse moved its core data layer to ClickHouse with its v3 release.

Helicone [announced on 2026-03-03](https://www.helicone.ai/blog/joining-mintlify) that Mintlify had acquired it and that its team is joining Mintlify. In Helicone's words, its services will remain live for the foreseeable future in maintenance mode, which it spells out as security updates, new models, and bug and performance fixes that keep shipping. The public repository matches that description: as of 2026-09-24, the [latest commit on its main branch](https://github.com/Helicone/helicone/commit/067d9290acb4f1fc9320e902fc67b4b399b50363) is a security fix dated 2026-09-16.

Neither announcement changes how either product works today. Maintenance mode still matters for a long-lived decision, more for the system that holds your evaluation history and prompt versions than for a gateway behind one base URL.

## Instrumentation: in your code or in the request path

Langfuse's [SDKs](https://langfuse.com/docs/observability/sdk/overview), Python v4 and JS/TS v5 as of 2026-09-24, are built on OpenTelemetry. You wrap functions or open observations in code, and the SDK queues events and flushes them in batches in the background. Langfuse says this adds almost no latency and that SDK errors are caught and logged rather than raised into your application. Anything that already emits OpenTelemetry can send OTLP straight to Langfuse's /api/public/otel endpoint, and Langfuse maintains integrations for a long list of agent frameworks and model SDKs.

One date matters if you wrote a custom integration: on Langfuse Cloud, the legacy POST /api/public/ingestion endpoint stops accepting everything except scores on November 16, 2026, and Langfuse's [ingestion migration guide](https://langfuse.com/integrations/native/opentelemetry/migration-to-v4) moves that code to OpenTelemetry.

Helicone's primary integration is a base URL. Point the OpenAI SDK at https://ai-gateway.helicone.ai with a Helicone API key, and every request is forwarded, logged with its cost, latency, and errors, and returned. Helicone runs its proxy on Cloudflare Workers and publishes [its own benchmark](https://docs.helicone.ai/references/latency-affect) showing proxied latency closely matching direct calls to OpenAI. If you would rather keep Helicone off the critical path, its async integration logs through OpenLLMetry or a manual logger, but Helicone's own [comparison table](https://docs.helicone.ai/references/proxy-vs-async) marks caching, retries, and custom rate limits as proxy-only.

The trade is the usual one. A proxy captures everything from one line of configuration and can act on each request, and it becomes a dependency of every call. SDK instrumentation stays out of the path and sees the structure of your code, and it asks for code changes wherever you want detail.

## Tracing, sessions, and agents

Langfuse models a trace as a tree of [typed observations](https://langfuse.com/docs/observability/features/observation-types): spans, generations, agents, tools, chains, retrievers, embeddings, evaluators, guardrails, and events. Framework integrations set the types for you. Propagate a session ID and traces group into a session you can replay, share as a public link, bookmark, or score by hand. Agent graphs, user tracking, tags, environments, and full-text search sit on top.

Helicone's unit is the request. Three [session headers](https://docs.helicone.ai/features/sessions), Helicone-Session-Id, Helicone-Session-Path, and Helicone-Session-Name, group requests into a session, and path syntax such as /abstract/outline builds the parent-child tree. Sessions can include vector database queries and tool calls logged through Helicone's logger SDKs, not only model calls. Custom properties, sent as headers named Helicone-Property- followed by the property name, tag each request for filtering and segmentation.

For a chat app or a short chain, either view is enough. For a multi-step agent whose failures happen between model calls, the difference is where the structure comes from: Langfuse captures it from your code, and Helicone reconstructs it from the session paths you send.

## Evaluation, datasets, and experiments

This is the widest gap between the two. Langfuse runs [evaluations](https://langfuse.com/docs/evaluation/overview). Managed LLM-as-a-judge evaluators score live observations or experiment runs, with numeric, categorical, or boolean results. Code evaluators handle deterministic checks, annotation queues route traces to human reviewers, and scores also arrive through the UI, the API, or the SDKs. Datasets hold inputs and expected outputs, often built from production traces, and experiments run your application over a dataset from the UI, the SDK, or OpenTelemetry so you can compare runs side by side. The langfuse/experiment-action GitHub Action fails the job in a pull request workflow when your experiment script flags a score that violates your threshold. Since [June 2025](https://langfuse.com/blog/2025-06-04-open-sourcing-langfuse-product), the judge, playground, prompt experiments, and annotation features have been MIT-licensed along with the rest of the core.

Helicone is explicit about its scope. Its [scores documentation](https://docs.helicone.ai/features/advanced-usage/scores) says it does not run evaluations and is not an evaluation framework. It stores the scores you compute elsewhere, as integers or booleans attached to a request through the API or the dashboard, alongside user feedback. Its Datasets feature curates logged requests into sets you export as JSONL for fine-tuning or CSV for analysis. Helicone's prompt Experiments feature is marked deprecated in its docs, with removal dated September 1, 2025.

If running evaluations is the job you are hiring a tool for, Langfuse is built for it and Helicone says it is not.

## Prompt management

Both keep prompts out of your deploy cycle. Langfuse [versions prompts](https://langfuse.com/docs/prompt-management/overview) and promotes them with labels such as production and staging, with variables, composable prompts, config, a playground for side-by-side comparisons, webhooks, and a GitHub integration. Linking prompts to traces lets you compare versions on cost, latency, and quality. The SDKs cache prompts client-side; Langfuse says this adds no latency after first use, and you can pre-fetch prompts at startup or ship a fallback.

Helicone versions prompts with environments for production, staging, and development, supports variables anywhere including tool schemas, and has its own playground. Its distinctive part is delivery: send a prompt_id and inputs to the AI Gateway, and it [assembles the prompt](https://docs.helicone.ai/gateway/prompt-integration) on the way through, with no extra SDK in your application.

## Gateway, routing, and rate limits

Helicone's [AI Gateway](https://docs.helicone.ai/gateway/overview) is one OpenAI-compatible endpoint for 100+ models, by Helicone's count. Request a model and, per Helicone's [routing docs](https://docs.helicone.ai/gateway/provider-routing), the gateway finds the providers that serve it, routes to the cheapest, load-balances providers of equal cost, and fails over on rate limits, timeouts, and server errors. You can pin one provider, target your own deployment, or write an explicit fallback chain. Your own provider keys are tried first, with Helicone's managed keys as the fallback, paid from credits that Helicone says carry 0% markup. Around that sit custom rate limits by request count or spend, set globally, per user, or per custom property, plus LLM security checks for prompt injection and handlers for requests that exceed a model's context window.

Langfuse has no gateway and does not route, cache, or throttle model calls. It pairs with one: its integration docs cover LiteLLM Proxy, Portkey, OpenRouter, Vercel AI Gateway, Kong, TrueFoundry, and Helicone itself. Langfuse's LLM connections exist so its playground and judges can call models, not to carry your production traffic.

## Caching

Helicone [caches whole responses](https://docs.helicone.ai/features/advanced-usage/caching) at the edge, in Cloudflare Workers KV. You turn it on per request with the Helicone-Cache-Enabled header. The cache key hashes the URL, the request body, and the relevant headers, so any parameter change is a miss. Cache-Control sets the lifetime, seven days by default; a cache seed partitions entries, per user for example; and buckets store several responses for the same request. Separately, the gateway passes provider prompt caching through, which lowers the provider's rate for repeated prompt content rather than skipping the call.

Langfuse's caching is about prompts, not responses: the SDK cache described above, plus server-side prompt caching. Response caching, if you want it, belongs to the gateway you pair it with.

## Cost tracking and analytics

Both compute per-call cost and let you slice the spend. Langfuse [records usage and cost](https://langfuse.com/docs/observability/features/token-and-cost-tracking) per usage type, such as input, output, and cached tokens, on every generation. Costs are either ingested from your integration or inferred from model definitions. Langfuse ships prices for popular OpenAI, Anthropic, and Google models, you add custom definitions with pricing tiers for anything else, and ingested values win when both exist. Custom dashboards, threshold alerts routed to Slack, GitHub Actions, or webhooks, and the Metrics API break cost and latency down by model, user, session, feature, release, and prompt version.

Helicone [computes cost at the gateway](https://docs.helicone.ai/guides/cookbooks/cost-tracking) from its model registry, which Helicone labels 100% accurate for gateway traffic, and falls back to a best-effort estimate from its open-source pricing repository of 300+ models for direct integrations. Sessions show what a whole interaction cost, custom properties slice spend by feature, user tier, or environment, and alerts fire on cost, error rate, latency, or token counts. Weekly reports go to email or Slack. HQL lets you query request data in SQL; as of 2026-09-24 it is available to selected workspaces.

A cost view answers where the money goes. It cannot say whether a cheaper model would have produced an acceptable answer on those same calls. That takes a replay, which is where the last section picks up.

## Self-hosting and licensing

Langfuse's repository license puts everything outside its ee directories under MIT, and since June 2025 that core includes evaluation, the playground, experiments, and annotation. A license key unlocks enterprise add-ons such as SCIM, audit logs, data retention policies, and project-level RBAC. Self-hosted Langfuse [runs the same codebase as Langfuse Cloud](https://langfuse.com/self-hosting): web and worker containers on Postgres, ClickHouse, Redis or Valkey, and S3-compatible storage, with Docker Compose for local use and Helm or Terraform modules for AWS, Azure, and GCP in production.

Helicone is [licensed under Apache 2.0](https://docs.helicone.ai/references/open-source). Its docs cover an all-in-one Docker image, Kubernetes Helm charts, manual installation, and cloud deployment. One detail for anyone planning a self-hosted proxy: Helicone's Docker guide notes that its Jawn service no longer proxies model traffic, so you run the AI Gateway alongside it.

## Getting your data out

Langfuse exposes a public API, an Observations API for row-level data, a Metrics API for aggregates, UI exports, a CLI, an MCP server, and an OpenAPI spec. [Scheduled exports](https://langfuse.com/docs/api-and-data-platform/features/export-to-blob-storage) write to S3, Google Cloud Storage, or Azure Blob Storage anywhere from every 20 minutes to weekly; as of 2026-09-24 that feature is available self-hosted, on Enterprise, or on Pro with the Teams add-on.

Helicone exposes a REST API to query requests, with bodies included when you ask for them, and an [export CLI](https://docs.helicone.ai/guides/cookbooks/etl), @helicone/export, that writes JSON, JSONL, or CSV with date and property filters. Datasets export separately, and HQL covers ad hoc SQL. Whichever tool you run, a periodic export keeps your history portable.

## When each fits

**Helicone fits when the problem is traffic.** You want one OpenAI-compatible endpoint across providers, failover, edge caching, rate limits by user or spend, and per-request cost, all from a base URL change. Weigh the maintenance-mode status against how long you expect to depend on it and on its roadmap.

**Langfuse fits when the problem is quality and structure.** You want nested traces of agents, evaluations that run on live traffic and in CI, datasets and experiments, prompt management with client-side caching, and the option to self-host all of it under MIT.

**Both fit when you want a gateway and an evaluation platform.** Langfuse [documents the combination](https://langfuse.com/integrations/gateways/helicone): point its OpenAI SDK wrapper at Helicone's AI Gateway base URL, and Helicone routes and caches while Langfuse traces and evaluates. Both will compute a cost for the same call, so pick one as the system of record for spend. Langfuse's [Helicone migration guide](https://langfuse.com/resources/engineering/migrate-from-helicone) notes that the two capture mechanisms don't conflict, which is also what makes a gradual migration practical.

## Once you know which calls cost the most

Both tools will show you which steps dominate the bill. The next question is whether each of those steps needs the model it runs on. Langfuse experiments can answer that on a curated dataset with evaluators you configure. The other route is the production traffic you have already recorded, judged against the outputs your team already accepted.

That is the job [rightmodeler](https://github.com/elm-os/rightmodeler) does. It is an MIT-licensed command-line tool that reads exported traces, replays recorded model calls through cheaper candidates from your provider's live model catalog, and judges every candidate against the output you shipped. The evidence rules are strict on purpose: a step family needs at least 10 assessed executions, two distinct step IDs, and five distinct trajectories, and below any of those it [abstains](https://www.rightmodeler.com/glossary#abstain) with a named reason. Candidates are shortlisted on one half of the cases and must clear the [quality floor](https://www.rightmodeler.com/glossary#quality-floor) again on held-out cases. When a family clears every gate, rightmodeler opens a draft pull request that changes model identifiers and nothing else, for a person to review and merge. It never sits in your request path.

It has dedicated adapters for both tools. From Langfuse, export observations and rightmodeler replays the GENERATION records; pass --evaluator langfuse and your own Langfuse scorers grade the replays, and the results can go back into a Langfuse dataset. From Helicone, export request rows with their bodies included; rows that share a Helicone-Session-Id become one trajectory, so a multi-call agent run counts as one unit in the statistics rather than many. A plan mode previews the pipeline without spending anything, and a cost cap bounds replay spend. The exact export and run commands are in the [Langfuse integration guide](https://www.rightmodeler.com/integrations/langfuse) and the [Helicone integration guide](https://www.rightmodeler.com/integrations/helicone).

For how rightmodeler relates to each product in more depth, read [rightmodeler vs Langfuse](https://www.rightmodeler.com/vs/langfuse) and [rightmodeler vs Helicone](https://www.rightmodeler.com/vs/helicone). If you are weighing evaluation platforms more broadly, we also compare it with [Braintrust](https://www.rightmodeler.com/vs/braintrust) and [LangSmith](https://www.rightmodeler.com/vs/langsmith), and the [reduce LLM costs](https://www.rightmodeler.com/use-cases/reduce-llm-costs) guide walks through the full workflow. For the levers beyond a model swap, such as caching, batching and compression, read [which LLM cost optimization approach fits your workload](https://www.rightmodeler.com/blog/llm-cost-optimization-tools).
`;
