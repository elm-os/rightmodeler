// Post: "Bifrost vs LiteLLM: a practical evaluation checklist." A practitioner checklist for readers
// choosing between the two open-source gateways: setup and keys, what /v1/models returns, log
// exports, routing controls, and what a replay through each returns. A typed post module: `meta`
// (data) plus a `Body` composed from the prose primitives, with a faithful Markdown twin.
// Sourcing: every vendor fact comes from Bifrost's and LiteLLM's own docs as fetched on 2026-09-24;
// vendor performance figures are attributed to the vendor, never presented as our results; Bifrost
// replay behaviour cites the pinned v2.2.1 fixtures and live acceptance test at 27e877e; LiteLLM
// replay behaviour follows the LiteLLM integration page and the getting-started guide. No ranking.

import {
  A,
  H2,
  H3,
  LI,
  Lead,
  P,
  Prose,
  Strong,
  UL,
} from "@/components/blog/prose";
import type { PostMeta } from "@/content/blog/types";

export const meta: PostMeta = {
  slug: "bifrost-vs-litellm",
  title: "Bifrost vs LiteLLM: a practical evaluation checklist.",
  description:
    "Choosing between Bifrost and LiteLLM? A hands-on checklist for setup and keys, model catalogs, log exports, routing controls, and replaying a cheaper model.",
  excerpt:
    "Both front many providers with one OpenAI-compatible API. The differences come later: where keys live, what the catalog says about price, what the logs keep, and what changes the model.",
  kicker: "Checklist · Gateways",
  date: "2026-09-24",
  readingMinutes: 11,
  hero: {
    src: "/blog/bifrost-vs-litellm-hero.jpg",
    alt: "A warm parchment field with two columns of short grey watercolor ticks, one tick washed from violet into orange.",
  },
};

export function Body() {
  return (
    <Prose>
      <Lead>
        Bifrost and LiteLLM solve the same first problem: one OpenAI-compatible
        endpoint in front of many model providers, so your application stops
        caring whose SDK it talks to. Both start with a single command. The
        differences arrive later: where provider keys live, whether the model
        list says what anything costs, what the logs keep, and which routing
        features can quietly change the model that answers.
      </Lead>
      <P>
        <A href="https://docs.getbifrost.ai/overview">Bifrost</A>, from Maxim,
        is written in Go and licensed Apache 2.0.{" "}
        <A href="https://docs.litellm.ai/">LiteLLM</A>, from BerriAI, is a
        Python proxy and SDK, MIT-licensed outside its enterprise directory.
        This checklist takes them side by side in the order the work usually
        goes, ending with replay: finding out whether a cheaper model can take
        over part of your traffic. Vendor facts come from each project&rsquo;s
        own documentation as of{" "}
        <span className="whitespace-nowrap">2026-09-24</span>. Where a point
        rests on responses we captured, the file is linked.
      </P>
      <H2>Setup: deployment, config and keys</H2>
      <P>
        Bifrost starts with zero configuration:{" "}
        <span className="whitespace-nowrap">npx -y @maximhq/bifrost</span>, or
        the maximhq/bifrost Docker image, with a Web UI on port 8080 for adding
        providers. By default its configuration lives in a database, SQLite or
        PostgreSQL, which a config.json seeds at startup. Set
        config_store.enabled to false and the file becomes the only
        configuration, applied on restart.
      </P>
      <P>
        <A href="https://docs.litellm.ai/docs/proxy/docker_quick_start">
          LiteLLM&rsquo;s quickstart
        </A>{" "}
        runs the gateway on port 4000 beside PostgreSQL and generates two
        secrets to keep: LITELLM_MASTER_KEY, the root credential for every
        management call, and LITELLM_SALT_KEY, which encrypts stored provider
        keys and has no in-place rotation. Models live in the model_list of
        config.yaml, each entry pairing the model_name clients call with the
        litellm_params.model called upstream. LiteLLM also runs from the file
        alone, and its docs spell out the trade: without a database, virtual
        keys do not work and a global max_budget is not enforced.
      </P>
      <H3>What to check</H3>
      <UL>
        <LI>
          <Strong>Pin the version.</Strong>{" "}
          <A href="https://docs.getbifrost.ai/quickstart/gateway/setting-up">
            Bifrost&rsquo;s setup guide
          </A>{" "}
          calls its unversioned commands local evaluation, and{" "}
          <A href="https://docs.litellm.ai/docs/proxy/deploy">
            LiteLLM&rsquo;s deployment guide
          </A>{" "}
          says to pin a version tag rather than latest. Record the version
          beside every number you compare.
        </LI>
        <LI>
          <Strong>Close the admin surface before you open a port.</Strong>{" "}
          <A href="https://docs.getbifrost.ai/quickstart/gateway/setting-up-auth">
            Bifrost&rsquo;s auth guide
          </A>{" "}
          notes that until an admin account exists, its dashboard and admin API
          answer anyone who can reach them. LiteLLM&rsquo;s quickstart refuses
          to start without a master key.
        </LI>
        <LI>
          <Strong>Know which copy of the config wins.</Strong> In
          Bifrost&rsquo;s database mode, a UI change survives restarts until you
          edit the same entity in config.json, and then the file overwrites it.
          In LiteLLM, settings the UI writes are overlaid on config.yaml at
          startup, so the database value wins and the same edit in the YAML has
          no effect.
        </LI>
        <LI>
          <Strong>Keep provider keys out of the files.</Strong> Bifrost reads a
          key written as env.OPENAI_API_KEY from the environment; LiteLLM does
          the same with os.environ/OPENAI_API_KEY.
        </LI>
      </UL>
      <H2>Model catalogs: what /v1/models tells you</H2>
      <P>
        A gateway&rsquo;s model list is where a cost comparison starts or
        stalls. For each model you need a per-token price, a context window, and
        whether it supports what the step sends, such as tools or structured
        output. The two gateways keep that information in different places.
      </P>
      <P>
        <A href="https://docs.getbifrost.ai/api-reference/models/list-available-models">
          Bifrost&rsquo;s GET /v1/models
        </A>{" "}
        lists every configured provider&rsquo;s models as provider/model ids,
        with room in its schema for pricing, context_length and
        supported_parameters. How much is filled depends on the provider. In{" "}
        <A href="https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/catalogs/bifrost-models.json">
          a /v1/models answer we captured from Bifrost v2.2.1
        </A>
        , OpenRouter as a native provider came back priced, with its supported
        parameters, while Vercel AI Gateway as an OpenAI-typed custom provider
        came back with ids, context lengths and owners only, and one created
        date shared by every model. Bifrost&rsquo;s own cost figures use a
        pricing sheet downloaded from{" "}
        <A href="https://docs.getbifrost.ai/architecture/framework/model-catalog">
          Maxim&rsquo;s datasheet
        </A>{" "}
        at startup and, with a config store, re-synced every 24 hours.
      </P>
      <P>
        <A href="https://docs.litellm.ai/docs/proxy/model_discovery">
          LiteLLM&rsquo;s GET /v1/models
        </A>{" "}
        answers in the plain OpenAI shape, id, object, created and owned_by,
        with no prices or context windows. Those live on{" "}
        <A href="https://docs.litellm.ai/docs/proxy/model_management">
          GET /model/info
        </A>
        , which returns each deployment with its mapped cost and context data.
        The prices come from LiteLLM&rsquo;s model cost map, which{" "}
        <A href="https://docs.litellm.ai/docs/proxy/sync_models_github">
          each process fetches from GitHub at startup
        </A>
        ; GET /model/cost_map/source reports the loaded revision, and a
        deployment&rsquo;s model_info can override it. Names added with
        model_group_alias are listed on /v1/models too.
      </P>
      <H3>What to check</H3>
      <UL>
        <LI>
          <Strong>Read the rows, not the count.</Strong> For each model you
          might move a step to, confirm a price, a context window and the
          supported parameters, on /model/info for LiteLLM.
        </LI>
        <LI>
          <Strong>
            For a Bifrost custom provider, find the upstream&rsquo;s own list.
          </Strong>{" "}
          Its entries carry ids and context only.
        </LI>
        <LI>
          <Strong>Note which price sheet produced a number.</Strong> Both sheets
          change over time; record which one priced a comparison and when, or it
          cannot be rerun.
        </LI>
      </UL>
      <H2>Exports: request logs, OpenTelemetry, callbacks</H2>
      <P>
        Every gateway logs. For an evaluation, the question is whether the logs
        keep enough to reconstruct a call: the conversation exactly as sent, the
        output, token usage, cost, and which attempt produced the answer.
      </P>
      <P>
        <A href="https://docs.getbifrost.ai/features/observability/default">
          Bifrost&rsquo;s built-in logging
        </A>{" "}
        writes every request to a log store, SQLite by default with PostgreSQL
        and ClickHouse as options, recording inputs, outputs, tokens, cost,
        latency, a retry count and an attempt trail naming each key tried,
        readable in the UI or at /api/logs. Its{" "}
        <A href="https://docs.getbifrost.ai/features/otel">
          OpenTelemetry plugin
        </A>{" "}
        emits spans following the GenAI semantic conventions, one per attempt,
        each with a gen_ai.usage.cost attribute from the model catalog, and
        requests carrying an{" "}
        <span className="whitespace-nowrap">x-bf-session-id</span> header are
        tagged with that session.{" "}
        <A href="https://docs.getbifrost.ai/deployment-guides/config-json/client">
          Content logging is set per destination
        </A>
        : turning it off for the log store leaves every connector, OpenTelemetry
        included, exporting content.
      </P>
      <P>
        LiteLLM exports through{" "}
        <A href="https://docs.litellm.ai/docs/proxy/logging">
          callbacks declared in config.yaml
        </A>
        , such as otel or langfuse. With a database, every call also lands in{" "}
        <A href="https://docs.litellm.ai/docs/proxy/cost_tracking">
          a LiteLLM_SpendLogs row
        </A>{" "}
        with the model group, the upstream api_base, spend, tokens and the
        number of fallbacks attempted. An opt-in v2 of its{" "}
        <A href="https://docs.litellm.ai/docs/observability/opentelemetry_integration">
          OpenTelemetry integration
        </A>
        , switched on with LITELLM_OTEL_V2=true, produces one trace per request
        following the GenAI semantic conventions, and the standard GenAI
        content-capture variable decides whether prompts and completions are
        included.
      </P>
      <H3>What to check</H3>
      <UL>
        <LI>
          <Strong>Message content is in the export.</Strong> A log with tokens
          and cost but no conversation tells you what you spent, not whether a
          cheaper model would have written the same answer.
        </LI>
        <LI>
          <Strong>A fallback is distinguishable.</Strong> In Bifrost&rsquo;s log
          export a fallback attempt is its own row, and LiteLLM&rsquo;s spend
          log counts attempted fallbacks on the call. An answer from a fallback
          model should never pass for the requested model&rsquo;s.
        </LI>
      </UL>
      <H2>
        Routing controls: fallbacks, load balancing, aliases, retries, caching
      </H2>
      <P>
        Here both gateways earn their keep in production, and here an evaluation
        can quietly go wrong. Every feature below exists to return a good 200
        when something upstream fails. On live traffic that is the point. When
        you are measuring one specific model, each one is a way to get an answer
        from something other than what you asked for.
      </P>
      <H3>Bifrost</H3>
      <UL>
        <LI>
          <Strong>Retries</Strong> are set per provider and{" "}
          <A href="https://docs.getbifrost.ai/features/retries-and-fallbacks">
            default to zero
          </A>
          . Server errors back off on the same key, while a 429, 401, 402 or 403
          rotates to another key.
        </LI>
        <LI>
          <Strong>Fallbacks</Strong> are a fallbacks array of provider/model ids
          in the request body, tried in order after the primary&rsquo;s retries,
          each with its own retry budget. The response&rsquo;s
          extra_fields.provider names who served.
        </LI>
        <LI>
          <Strong>Load balancing</Strong> is{" "}
          <A href="https://docs.getbifrost.ai/features/keys-management">
            weighted random selection across a provider&rsquo;s keys
          </A>
          .
        </LI>
        <LI>
          <Strong>Aliases</Strong> are{" "}
          <A href="https://docs.getbifrost.ai/providers/aliasing-models">
            a static map on a provider key
          </A>
          , or dynamic through routing rules.
        </LI>
        <LI>
          <Strong>Caching</Strong> is the{" "}
          <A href="https://docs.getbifrost.ai/features/semantic-caching">
            semantic_cache plugin
          </A>
          , exact-hash or similarity. It engages only with an{" "}
          <span className="whitespace-nowrap">x-bf-cache-key</span> header or a
          default key, and reports hits in extra_fields.cache_debug.
        </LI>
        <LI>
          <Strong>The compat plugin</Strong> can{" "}
          <A href="https://docs.getbifrost.ai/features/compat-plugin">
            convert text completions to chat
          </A>{" "}
          and chat to the Responses API, drop parameters a model does not
          support, and convert parameter values, reporting
          converted_request_type and dropped_compat_plugin_params in
          extra_fields.
        </LI>
      </UL>
      <H3>LiteLLM</H3>
      <UL>
        <LI>
          <Strong>Load balancing</Strong> happens inside a model group: several
          deployments share one model_name, and{" "}
          <A href="https://docs.litellm.ai/docs/routing">
            the routing strategy
          </A>{" "}
          picks among them, simple-shuffle by default.
        </LI>
        <LI>
          <Strong>Retries</Strong> are num_retries per model group.
        </LI>
        <LI>
          <Strong>Fallbacks</Strong> move a failed call{" "}
          <A href="https://docs.litellm.ai/docs/proxy/reliability">
            to another model group
          </A>{" "}
          once retries are spent, with separate lists for context-window and
          content-policy errors.
        </LI>
        <LI>
          <Strong>Aliases</Strong> are{" "}
          <A href="https://docs.litellm.ai/docs/proxy/load_balancing">
            model_group_alias
          </A>{" "}
          in router_settings.
        </LI>
        <LI>
          <Strong>Caching</Strong> is{" "}
          <A href="https://docs.litellm.ai/docs/proxy/caching">
            cache: True under litellm_settings
          </A>
          , Redis by default, exact-match or semantic. A cached response carries
          an <span className="whitespace-nowrap">x-litellm-cache-key</span>{" "}
          header.
        </LI>
        <LI>
          <Strong>Unsupported parameters</Strong>{" "}
          <A href="https://docs.litellm.ai/docs/completion/drop_params">
            raise an error by default
          </A>
          ; drop_params: true drops them instead.
        </LI>
      </UL>
      <P>
        One detail is worth checking by hand on Bifrost. Its{" "}
        <A href="https://docs.getbifrost.ai/deployment-guides/config-json/client">
          client reference
        </A>{" "}
        lists every compat flag as false by default. On the
        maximhq/bifrost:v2.2.1 image, a client block that left the flags out had
        the compat plugin drop response_format from a request and still answer
        200, reporting the drop under dropped_compat_plugin_params in{" "}
        <A href="https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/gateways/bifrost/compat-drop.json">
          the response we captured
        </A>
        . Writing every flag as false, as{" "}
        <A href="https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/gateway-acceptance/bifrost/config.json">
          this replay-safe config.json
        </A>{" "}
        does, settles the question.
      </P>
      <H3>What to check</H3>
      <UL>
        <LI>
          <Strong>What can answer with a different model.</Strong> Fallbacks,
          aliases, routing rules, and any group or key pool that mixes models.
        </LI>
        <LI>
          <Strong>What can change the request.</Strong> Bifrost&rsquo;s compat
          plugin and LiteLLM&rsquo;s drop_params.
        </LI>
        <LI>
          <Strong>What can answer without calling the model.</Strong> Both
          caches.
        </LI>
        <LI>
          <Strong>Where each gateway reports that it happened.</Strong> That is
          exactly what an evaluation has to check.
        </LI>
      </UL>
      <H2>Replay: what comes back when you test a cheaper model</H2>
      <P>
        The usual reason to look this closely is a model decision. A cheaper
        model has shipped, and you want to know whether it can take over one
        step of your pipeline without changing what users get. The rigorous way
        is to replay that step&rsquo;s recorded inputs through the candidate and
        compare the outputs with the ones your team already accepted. Your
        gateway is the obvious route, so the previous section now matters in
        reverse: each replayed response must come from the model you asked for,
        answer the request you sent, and carry a cost that is billed or labelled
        an estimate.
      </P>
      <P>
        That is the job <A href="/how-it-works">rightmodeler</A> does. It is an
        MIT-licensed CLI on npm, started with npx rightmodeler init, that reads
        the traces you export, replays recorded steps through cheaper candidates
        from your provider&rsquo;s live catalog, and judges them against the
        outputs you already accepted. It reports{" "}
        <A href="/glossary#reference-evidence">reference agreement</A>, sample
        size and <A href="/glossary#abstain">abstentions</A> beside every
        result, requires a winner to clear your{" "}
        <A href="/glossary#quality-floor">quality floor</A> again on held-out
        cases, and opens a draft pull request that changes only model
        identifiers, for a person to review and merge. It is never in your
        request path.
      </P>
      <P>
        It replays through any OpenAI-compatible base URL and checks every
        response before counting it. A response that names another model,
        reports a cache hit, or reports a changed request is recorded as
        substituted and never graded, and a step family with more than 5% of its
        replays substituted abstains.{" "}
        <A href="/blog/llm-gateway-evaluation-pitfalls">
          How an AI gateway can invalidate your model evaluation
        </A>{" "}
        walks through each of those cases and how to catch them.
      </P>
      <H3>Through Bifrost</H3>
      <P>
        rightmodeler&rsquo;s Bifrost support is verified on the open-source
        transports/v2.2.1 release:{" "}
        <A href="https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/packages/rightmodeler/src/gateway-bifrost.live.test.ts">
          a live acceptance test
        </A>{" "}
        pins the image maximhq/bifrost:v2.2.1 at digest{" "}
        <span className="wrap-anywhere">
          sha256:a8942692af7b4b89196cd8fc33653b7353488dfd58b24078fe793b8574a8084b
        </span>{" "}
        and runs it end to end, routing to Vercel AI Gateway as an OpenAI-typed
        custom provider. A replay through it returns:
      </P>
      <UL>
        <LI>
          <Strong>Served model.</Strong> The upstream id, with Bifrost&rsquo;s
          provider prefix dropped: a call to{" "}
          <span className="whitespace-nowrap">vercel/amazon/nova-micro</span>{" "}
          comes back naming{" "}
          <span className="whitespace-nowrap">amazon/nova-micro</span>, as{" "}
          <A href="https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/gateways/bifrost/chat.json">
            this captured response
          </A>{" "}
          shows. rightmodeler reads a dropped gateway prefix as the requested
          model.
        </LI>
        <LI>
          <Strong>Cost.</Strong> The upstream&rsquo;s billed cost in
          usage.cost.total_cost, which rightmodeler records as billed rather
          than estimated.
        </LI>
        <LI>
          <Strong>Request changes.</Strong> A response reporting dropped
          parameters or a converted request is left out, so a candidate is never
          graded on a request it did not see.
        </LI>
        <LI>
          <Strong>Cache.</Strong> The documented replay command passes{" "}
          <span className="whitespace-nowrap">x-bf-cache-no-store: true</span>{" "}
          with <span className="whitespace-nowrap">--header</span>, so no replay
          is written to the cache, and a hit still reported in cache_debug is
          left out.
        </LI>
        <LI>
          <Strong>Aliases.</Strong> In the live test, a key alias that mapped a
          candidate to another model had every one of that candidate&rsquo;s
          replays left out as substituted.
        </LI>
        <LI>
          <Strong>Catalog.</Strong> A custom provider lists ids and context
          only, so the run passes{" "}
          <span className="whitespace-nowrap">--catalog-reference</span> with
          the upstream&rsquo;s public model list for prices, capabilities and
          release dates.
        </LI>
      </UL>
      <P>
        Bifrost is also a trace source. rightmodeler reads its log export, one
        GET /api/logs/&#123;id&#125; detail per line, as one ordered run per{" "}
        <span className="whitespace-nowrap">x-bf-session-id</span>, and leaves
        failed calls, fallback answers and rightmodeler&rsquo;s own tagged
        replays out by name. In the live test, 64 production calls in two-call
        sessions read back as 32 ordered runs, with the failed call and the
        fallback answer each named and excluded, and the replay leg ran inside a
        $0.25 cap with every completed call attributed to the requested model at
        its billed cost. The commands and the replay-safe config are on the{" "}
        <A href="/integrations/bifrost">Bifrost setup guide</A>.
      </P>
      <H3>Through LiteLLM</H3>
      <P>
        A LiteLLM proxy is a supported replay route: point{" "}
        <span className="whitespace-nowrap">--base-url</span> at the
        proxy&rsquo;s /v1 root and{" "}
        <span className="whitespace-nowrap">--api-key-env</span> at the variable
        holding a virtual key, and the replays and the judge run through the
        gateway you already operate, on your own keys and budgets. The{" "}
        <A href="/integrations/litellm">LiteLLM setup guide</A> has the
        commands. The checklist here is about making the proxy&rsquo;s answers
        mean what they say.
      </P>
      <UL>
        <LI>
          <Strong>Catalog.</Strong> rightmodeler shortlists a candidate only
          when it has a per-token price, a context window at least as large as
          the step&rsquo;s observed tokens, and support for what the step sends,
          and is strictly cheaper than the current model. Prices come from the
          catalog, or from LiteLLM&rsquo;s GET /model/info on the same host when
          the catalog carries none. Hermetic stub test: in{" "}
          <A href="https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/packages/replay/src/index.test.ts#L608-L670">
            index.test.ts
          </A>
          , a stubbed /model/info response fills an unpriced catalog, and a
          failed request leaves it unpriced with a catalog_pricing_unavailable
          warning. Context windows and capability flags come from the catalog
          too, and LiteLLM&rsquo;s /v1/models lists ids only, so pass{" "}
          <span className="whitespace-nowrap">--catalog-reference</span> with
          the upstream&rsquo;s public model list and name each replay group by
          its upstream id, such as{" "}
          <span className="whitespace-nowrap">openai/gpt-4o-mini</span>, so the
          entries join.
        </LI>
        <LI>
          <Strong>Served model.</Strong> rightmodeler checks the model a
          response body names.{" "}
          <A href="https://docs.litellm.ai/docs/proxy/response_headers">
            LiteLLM&rsquo;s response-header docs
          </A>{" "}
          say the body model is often restamped to the name the client called,
          with the deployment that answered in{" "}
          <span className="whitespace-nowrap">x-litellm-model-id</span> and
          fallbacks counted in{" "}
          <span className="whitespace-nowrap">
            x-litellm-attempted-fallbacks
          </span>
          . Give each replay model a group of its own with a single deployment,
          no fallbacks and no alias, and the name in the body is the model that
          answered.
        </LI>
        <LI>
          <Strong>Cost.</Strong> LiteLLM reports its calculated cost for each
          call in the{" "}
          <span className="whitespace-nowrap">x-litellm-response-cost</span>{" "}
          header. rightmodeler takes a billed cost from the response body when
          one is there; otherwise it prices the call from catalog prices and
          token counts and labels the figure an estimate in its ledger.
        </LI>
        <LI>
          <Strong>Request changes and cache.</Strong> Leave drop_params and
          caching off for replay groups, so an unsupported parameter fails
          loudly instead of disappearing and every answer is a fresh call to the
          candidate.
        </LI>
        <LI>
          <Strong>Traces.</Strong> rightmodeler does not read LiteLLM&rsquo;s
          spend logs. For traffic through the proxy, it reads OpenTelemetry
          GenAI spans, or OpenAI SDK calls your application logs as JSONL.
        </LI>
      </UL>
      <H2>A word on overhead numbers</H2>
      <P>
        Both projects publish performance figures worth reading closely before
        quoting.{" "}
        <A href="https://docs.getbifrost.ai/benchmarking/t3.xl">
          Bifrost&rsquo;s benchmark page
        </A>{" "}
        reports 11 microseconds of overhead on a t3.xlarge at 5,000 requests per
        second, excluding JSON marshalling and the HTTP call, measured on mocked
        OpenAI calls.{" "}
        <A href="https://docs.litellm.ai/docs/benchmarks">
          LiteLLM&rsquo;s benchmarks page
        </A>{" "}
        reports 8 ms P95 latency at 1,000 requests per second against a fake
        OpenAI endpoint. These are the vendors&rsquo; own claims, on mocks, with
        different definitions of overhead, so they do not compare directly. Time
        the gateway on your own prompts and upstreams: rightmodeler records each
        replay&rsquo;s end-to-end latency through your gateway beside the model
        and its cost.
      </P>
      <H2>The checklist on one page</H2>
      <UL>
        <LI>
          <Strong>Setup.</Strong> Version pinned, admin surface closed, the
          winning copy of the config known, provider keys read from the
          environment.
        </LI>
        <LI>
          <Strong>Catalog.</Strong> Price, context window and supported
          parameters confirmed for every model you might use, with the price
          sheet and date recorded.
        </LI>
        <LI>
          <Strong>Exports.</Strong> Message content present, fallbacks
          distinguishable, content settings matched across every destination.
        </LI>
        <LI>
          <Strong>Routing.</Strong> Every feature that can change the model, the
          request or the source of an answer listed, with where each gateway
          reports it.
        </LI>
        <LI>
          <Strong>Replay.</Strong> One deployment per replay model; no
          fallbacks, aliases, caches, compat changes or dropped parameters on
          the replay route; a cost you know to be billed or estimated.
        </LI>
      </UL>
      <P>
        The setup guides for <A href="/integrations/bifrost">Bifrost</A> and{" "}
        <A href="/integrations/litellm">LiteLLM</A> have the full commands, and
        the comparisons of rightmodeler with <A href="/vs/bifrost">Bifrost</A>{" "}
        and with <A href="/vs/litellm">LiteLLM</A> cover how each fits beside a
        replay audit. If the bill brought you here, start with{" "}
        <A href="/use-cases/reduce-llm-costs">reducing LLM costs</A>; for the
        method, read <A href="/how-it-works">how rightmodeler works</A>.
      </P>
    </Prose>
  );
}

// The same post as clean Markdown, for llms-context.txt and any LLM-facing surface. Kept in sync with
// Body above by hand.
export const markdown = `# Bifrost vs LiteLLM: a practical evaluation checklist.

Bifrost and LiteLLM solve the same first problem: one OpenAI-compatible endpoint in front of many model providers, so your application stops caring whose SDK it talks to. Both start with a single command. The differences arrive later: where provider keys live, whether the model list says what anything costs, what the logs keep, and which routing features can quietly change the model that answers.

[Bifrost](https://docs.getbifrost.ai/overview), from Maxim, is written in Go and licensed Apache 2.0. [LiteLLM](https://docs.litellm.ai/), from BerriAI, is a Python proxy and SDK, MIT-licensed outside its enterprise directory. This checklist takes them side by side in the order the work usually goes, ending with replay: finding out whether a cheaper model can take over part of your traffic. Vendor facts come from each project's own documentation as of 2026-09-24. Where a point rests on responses we captured, the file is linked.

## Setup: deployment, config and keys

Bifrost starts with zero configuration: npx -y @maximhq/bifrost, or the maximhq/bifrost Docker image, with a Web UI on port 8080 for adding providers. By default its configuration lives in a database, SQLite or PostgreSQL, which a config.json seeds at startup. Set config_store.enabled to false and the file becomes the only configuration, applied on restart.

[LiteLLM's quickstart](https://docs.litellm.ai/docs/proxy/docker_quick_start) runs the gateway on port 4000 beside PostgreSQL and generates two secrets to keep: LITELLM_MASTER_KEY, the root credential for every management call, and LITELLM_SALT_KEY, which encrypts stored provider keys and has no in-place rotation. Models live in the model_list of config.yaml, each entry pairing the model_name clients call with the litellm_params.model called upstream. LiteLLM also runs from the file alone, and its docs spell out the trade: without a database, virtual keys do not work and a global max_budget is not enforced.

### What to check

- **Pin the version.** [Bifrost's setup guide](https://docs.getbifrost.ai/quickstart/gateway/setting-up) calls its unversioned commands local evaluation, and [LiteLLM's deployment guide](https://docs.litellm.ai/docs/proxy/deploy) says to pin a version tag rather than latest. Record the version beside every number you compare.
- **Close the admin surface before you open a port.** [Bifrost's auth guide](https://docs.getbifrost.ai/quickstart/gateway/setting-up-auth) notes that until an admin account exists, its dashboard and admin API answer anyone who can reach them. LiteLLM's quickstart refuses to start without a master key.
- **Know which copy of the config wins.** In Bifrost's database mode, a UI change survives restarts until you edit the same entity in config.json, and then the file overwrites it. In LiteLLM, settings the UI writes are overlaid on config.yaml at startup, so the database value wins and the same edit in the YAML has no effect.
- **Keep provider keys out of the files.** Bifrost reads a key written as env.OPENAI_API_KEY from the environment; LiteLLM does the same with os.environ/OPENAI_API_KEY.

## Model catalogs: what /v1/models tells you

A gateway's model list is where a cost comparison starts or stalls. For each model you need a per-token price, a context window, and whether it supports what the step sends, such as tools or structured output. The two gateways keep that information in different places.

[Bifrost's GET /v1/models](https://docs.getbifrost.ai/api-reference/models/list-available-models) lists every configured provider's models as provider/model ids, with room in its schema for pricing, context_length and supported_parameters. How much is filled depends on the provider. In [a /v1/models answer we captured from Bifrost v2.2.1](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/catalogs/bifrost-models.json), OpenRouter as a native provider came back priced, with its supported parameters, while Vercel AI Gateway as an OpenAI-typed custom provider came back with ids, context lengths and owners only, and one created date shared by every model. Bifrost's own cost figures use a pricing sheet downloaded from [Maxim's datasheet](https://docs.getbifrost.ai/architecture/framework/model-catalog) at startup and, with a config store, re-synced every 24 hours.

[LiteLLM's GET /v1/models](https://docs.litellm.ai/docs/proxy/model_discovery) answers in the plain OpenAI shape, id, object, created and owned_by, with no prices or context windows. Those live on [GET /model/info](https://docs.litellm.ai/docs/proxy/model_management), which returns each deployment with its mapped cost and context data. The prices come from LiteLLM's model cost map, which [each process fetches from GitHub at startup](https://docs.litellm.ai/docs/proxy/sync_models_github); GET /model/cost_map/source reports the loaded revision, and a deployment's model_info can override it. Names added with model_group_alias are listed on /v1/models too.

### What to check

- **Read the rows, not the count.** For each model you might move a step to, confirm a price, a context window and the supported parameters, on /model/info for LiteLLM.
- **For a Bifrost custom provider, find the upstream's own list.** Its entries carry ids and context only.
- **Note which price sheet produced a number.** Both sheets change over time; record which one priced a comparison and when, or it cannot be rerun.

## Exports: request logs, OpenTelemetry, callbacks

Every gateway logs. For an evaluation, the question is whether the logs keep enough to reconstruct a call: the conversation exactly as sent, the output, token usage, cost, and which attempt produced the answer.

[Bifrost's built-in logging](https://docs.getbifrost.ai/features/observability/default) writes every request to a log store, SQLite by default with PostgreSQL and ClickHouse as options, recording inputs, outputs, tokens, cost, latency, a retry count and an attempt trail naming each key tried, readable in the UI or at /api/logs. Its [OpenTelemetry plugin](https://docs.getbifrost.ai/features/otel) emits spans following the GenAI semantic conventions, one per attempt, each with a gen_ai.usage.cost attribute from the model catalog, and requests carrying an x-bf-session-id header are tagged with that session. [Content logging is set per destination](https://docs.getbifrost.ai/deployment-guides/config-json/client): turning it off for the log store leaves every connector, OpenTelemetry included, exporting content.

LiteLLM exports through [callbacks declared in config.yaml](https://docs.litellm.ai/docs/proxy/logging), such as otel or langfuse. With a database, every call also lands in [a LiteLLM_SpendLogs row](https://docs.litellm.ai/docs/proxy/cost_tracking) with the model group, the upstream api_base, spend, tokens and the number of fallbacks attempted. An opt-in v2 of its [OpenTelemetry integration](https://docs.litellm.ai/docs/observability/opentelemetry_integration), switched on with LITELLM_OTEL_V2=true, produces one trace per request following the GenAI semantic conventions, and the standard GenAI content-capture variable decides whether prompts and completions are included.

### What to check

- **Message content is in the export.** A log with tokens and cost but no conversation tells you what you spent, not whether a cheaper model would have written the same answer.
- **A fallback is distinguishable.** In Bifrost's log export a fallback attempt is its own row, and LiteLLM's spend log counts attempted fallbacks on the call. An answer from a fallback model should never pass for the requested model's.

## Routing controls: fallbacks, load balancing, aliases, retries, caching

Here both gateways earn their keep in production, and here an evaluation can quietly go wrong. Every feature below exists to return a good 200 when something upstream fails. On live traffic that is the point. When you are measuring one specific model, each one is a way to get an answer from something other than what you asked for.

### Bifrost

- **Retries** are set per provider and [default to zero](https://docs.getbifrost.ai/features/retries-and-fallbacks). Server errors back off on the same key, while a 429, 401, 402 or 403 rotates to another key.
- **Fallbacks** are a fallbacks array of provider/model ids in the request body, tried in order after the primary's retries, each with its own retry budget. The response's extra_fields.provider names who served.
- **Load balancing** is [weighted random selection across a provider's keys](https://docs.getbifrost.ai/features/keys-management).
- **Aliases** are [a static map on a provider key](https://docs.getbifrost.ai/providers/aliasing-models), or dynamic through routing rules.
- **Caching** is the [semantic_cache plugin](https://docs.getbifrost.ai/features/semantic-caching), exact-hash or similarity. It engages only with an x-bf-cache-key header or a default key, and reports hits in extra_fields.cache_debug.
- **The compat plugin** can [convert text completions to chat](https://docs.getbifrost.ai/features/compat-plugin) and chat to the Responses API, drop parameters a model does not support, and convert parameter values, reporting converted_request_type and dropped_compat_plugin_params in extra_fields.

### LiteLLM

- **Load balancing** happens inside a model group: several deployments share one model_name, and [the routing strategy](https://docs.litellm.ai/docs/routing) picks among them, simple-shuffle by default.
- **Retries** are num_retries per model group.
- **Fallbacks** move a failed call [to another model group](https://docs.litellm.ai/docs/proxy/reliability) once retries are spent, with separate lists for context-window and content-policy errors.
- **Aliases** are [model_group_alias](https://docs.litellm.ai/docs/proxy/load_balancing) in router_settings.
- **Caching** is [cache: True under litellm_settings](https://docs.litellm.ai/docs/proxy/caching), Redis by default, exact-match or semantic. A cached response carries an x-litellm-cache-key header.
- **Unsupported parameters** [raise an error by default](https://docs.litellm.ai/docs/completion/drop_params); drop_params: true drops them instead.

One detail is worth checking by hand on Bifrost. Its [client reference](https://docs.getbifrost.ai/deployment-guides/config-json/client) lists every compat flag as false by default. On the maximhq/bifrost:v2.2.1 image, a client block that left the flags out had the compat plugin drop response_format from a request and still answer 200, reporting the drop under dropped_compat_plugin_params in [the response we captured](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/gateways/bifrost/compat-drop.json). Writing every flag as false, as [this replay-safe config.json](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/gateway-acceptance/bifrost/config.json) does, settles the question.

### What to check

- **What can answer with a different model.** Fallbacks, aliases, routing rules, and any group or key pool that mixes models.
- **What can change the request.** Bifrost's compat plugin and LiteLLM's drop_params.
- **What can answer without calling the model.** Both caches.
- **Where each gateway reports that it happened.** That is exactly what an evaluation has to check.

## Replay: what comes back when you test a cheaper model

The usual reason to look this closely is a model decision. A cheaper model has shipped, and you want to know whether it can take over one step of your pipeline without changing what users get. The rigorous way is to replay that step's recorded inputs through the candidate and compare the outputs with the ones your team already accepted. Your gateway is the obvious route, so the previous section now matters in reverse: each replayed response must come from the model you asked for, answer the request you sent, and carry a cost that is billed or labelled an estimate.

That is the job [rightmodeler](https://www.rightmodeler.com/how-it-works) does. It is an MIT-licensed CLI on npm, started with npx rightmodeler init, that reads the traces you export, replays recorded steps through cheaper candidates from your provider's live catalog, and judges them against the outputs you already accepted. It reports [reference agreement](https://www.rightmodeler.com/glossary#reference-evidence), sample size and [abstentions](https://www.rightmodeler.com/glossary#abstain) beside every result, requires a winner to clear your [quality floor](https://www.rightmodeler.com/glossary#quality-floor) again on held-out cases, and opens a draft pull request that changes only model identifiers, for a person to review and merge. It is never in your request path.

It replays through any OpenAI-compatible base URL and checks every response before counting it. A response that names another model, reports a cache hit, or reports a changed request is recorded as substituted and never graded, and a step family with more than 5% of its replays substituted abstains. [How an AI gateway can invalidate your model evaluation](https://www.rightmodeler.com/blog/llm-gateway-evaluation-pitfalls) walks through each of those cases and how to catch them.

### Through Bifrost

rightmodeler's Bifrost support is verified on the open-source transports/v2.2.1 release: [a live acceptance test](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/packages/rightmodeler/src/gateway-bifrost.live.test.ts) pins the image maximhq/bifrost:v2.2.1 at digest sha256:a8942692af7b4b89196cd8fc33653b7353488dfd58b24078fe793b8574a8084b and runs it end to end, routing to Vercel AI Gateway as an OpenAI-typed custom provider. A replay through it returns:

- **Served model.** The upstream id, with Bifrost's provider prefix dropped: a call to vercel/amazon/nova-micro comes back naming amazon/nova-micro, as [this captured response](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/gateways/bifrost/chat.json) shows. rightmodeler reads a dropped gateway prefix as the requested model.
- **Cost.** The upstream's billed cost in usage.cost.total_cost, which rightmodeler records as billed rather than estimated.
- **Request changes.** A response reporting dropped parameters or a converted request is left out, so a candidate is never graded on a request it did not see.
- **Cache.** The documented replay command passes x-bf-cache-no-store: true with --header, so no replay is written to the cache, and a hit still reported in cache_debug is left out.
- **Aliases.** In the live test, a key alias that mapped a candidate to another model had every one of that candidate's replays left out as substituted.
- **Catalog.** A custom provider lists ids and context only, so the run passes --catalog-reference with the upstream's public model list for prices, capabilities and release dates.

Bifrost is also a trace source. rightmodeler reads its log export, one GET /api/logs/{id} detail per line, as one ordered run per x-bf-session-id, and leaves failed calls, fallback answers and rightmodeler's own tagged replays out by name. In the live test, 64 production calls in two-call sessions read back as 32 ordered runs, with the failed call and the fallback answer each named and excluded, and the replay leg ran inside a $0.25 cap with every completed call attributed to the requested model at its billed cost. The commands and the replay-safe config are on the [Bifrost setup guide](https://www.rightmodeler.com/integrations/bifrost).

### Through LiteLLM

A LiteLLM proxy is a supported replay route: point --base-url at the proxy's /v1 root and --api-key-env at the variable holding a virtual key, and the replays and the judge run through the gateway you already operate, on your own keys and budgets. The [LiteLLM setup guide](https://www.rightmodeler.com/integrations/litellm) has the commands. The checklist here is about making the proxy's answers mean what they say.

- **Catalog.** rightmodeler shortlists a candidate only when it has a per-token price, a context window at least as large as the step's observed tokens, and support for what the step sends, and is strictly cheaper than the current model. Prices come from the catalog, or from LiteLLM's GET /model/info on the same host when the catalog carries none. Hermetic stub test: in [index.test.ts](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/packages/replay/src/index.test.ts#L608-L670), a stubbed /model/info response fills an unpriced catalog, and a failed request leaves it unpriced with a catalog_pricing_unavailable warning. Context windows and capability flags come from the catalog too, and LiteLLM's /v1/models lists ids only, so pass --catalog-reference with the upstream's public model list and name each replay group by its upstream id, such as openai/gpt-4o-mini, so the entries join.
- **Served model.** rightmodeler checks the model a response body names. [LiteLLM's response-header docs](https://docs.litellm.ai/docs/proxy/response_headers) say the body model is often restamped to the name the client called, with the deployment that answered in x-litellm-model-id and fallbacks counted in x-litellm-attempted-fallbacks. Give each replay model a group of its own with a single deployment, no fallbacks and no alias, and the name in the body is the model that answered.
- **Cost.** LiteLLM reports its calculated cost for each call in the x-litellm-response-cost header. rightmodeler takes a billed cost from the response body when one is there; otherwise it prices the call from catalog prices and token counts and labels the figure an estimate in its ledger.
- **Request changes and cache.** Leave drop_params and caching off for replay groups, so an unsupported parameter fails loudly instead of disappearing and every answer is a fresh call to the candidate.
- **Traces.** rightmodeler does not read LiteLLM's spend logs. For traffic through the proxy, it reads OpenTelemetry GenAI spans, or OpenAI SDK calls your application logs as JSONL.

## A word on overhead numbers

Both projects publish performance figures worth reading closely before quoting. [Bifrost's benchmark page](https://docs.getbifrost.ai/benchmarking/t3.xl) reports 11 microseconds of overhead on a t3.xlarge at 5,000 requests per second, excluding JSON marshalling and the HTTP call, measured on mocked OpenAI calls. [LiteLLM's benchmarks page](https://docs.litellm.ai/docs/benchmarks) reports 8 ms P95 latency at 1,000 requests per second against a fake OpenAI endpoint. These are the vendors' own claims, on mocks, with different definitions of overhead, so they do not compare directly. Time the gateway on your own prompts and upstreams: rightmodeler records each replay's end-to-end latency through your gateway beside the model and its cost.

## The checklist on one page

- **Setup.** Version pinned, admin surface closed, the winning copy of the config known, provider keys read from the environment.
- **Catalog.** Price, context window and supported parameters confirmed for every model you might use, with the price sheet and date recorded.
- **Exports.** Message content present, fallbacks distinguishable, content settings matched across every destination.
- **Routing.** Every feature that can change the model, the request or the source of an answer listed, with where each gateway reports it.
- **Replay.** One deployment per replay model; no fallbacks, aliases, caches, compat changes or dropped parameters on the replay route; a cost you know to be billed or estimated.

The setup guides for [Bifrost](https://www.rightmodeler.com/integrations/bifrost) and [LiteLLM](https://www.rightmodeler.com/integrations/litellm) have the full commands, and the comparisons of rightmodeler with [Bifrost](https://www.rightmodeler.com/vs/bifrost) and with [LiteLLM](https://www.rightmodeler.com/vs/litellm) cover how each fits beside a replay audit. If the bill brought you here, start with [reducing LLM costs](https://www.rightmodeler.com/use-cases/reduce-llm-costs); for the method, read [how rightmodeler works](https://www.rightmodeler.com/how-it-works).
`;
