// Post: "How an AI gateway can invalidate your model evaluation." An engineering guide built on the
// gateway provenance fixtures in harness/fixtures/gateways and the tests that read them. Every
// response shown is a fixture at the pinned commit, labeled by how it was produced (captured from a
// running gateway, written from pinned vendor source, hermetic stub test, live provider test). Vendor
// behavior is attributed to the vendor's own docs or source at the pinned tag. Registered in ./index.

import {
  A,
  Code,
  H2,
  LI,
  Lead,
  P,
  Prose,
  Strong,
  UL,
} from "@/components/blog/prose";
import type { PostMeta } from "@/content/blog/types";

const REPO =
  "https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355";
// Files added with this post, linked on main until a commit that contains them can be pinned.
const MAIN = "https://github.com/elm-os/rightmodeler/blob/main";

export const meta: PostMeta = {
  slug: "llm-gateway-evaluation-pitfalls",
  title: "How an AI gateway can invalidate your model evaluation.",
  description:
    "A fallback, an alias, a cached answer or a rewritten request can make an evaluation grade something other than the candidate. Each can be caught and fixed.",
  excerpt:
    "Your evaluation gets a 200 and a score, but the answer may come from a fallback, an alias, a cache or a rewritten request. Four failure modes, the check that catches each, and the fix.",
  kicker: "Engineering guide",
  date: "2026-09-24",
  readingMinutes: 12,
  hero: {
    src: "/blog/llm-gateway-evaluation-pitfalls-hero.jpg",
    alt: "A warm parchment field where a grey watercolor stroke runs straight while a violet-to-orange stroke veers off onto a different path.",
  },
};

export function Body() {
  return (
    <Prose>
      <Lead>
        You want to know whether a cheaper model can take over a step in your
        application. So you send the step&rsquo;s recorded inputs to the
        candidate through the gateway that already fronts your traffic, grade
        what comes back, and read the score. Every call returns HTTP 200. Some
        of those answers were not written by the candidate.
      </Lead>

      <P>
        A gateway exists to keep production answering: it retries on another
        backend, maps one name to several deployments, serves repeats from a
        cache, and adjusts requests a provider cannot take. Each of those is a
        feature in production and a contamination in an evaluation, which makes
        one claim per row: this model, given this request, produced this output.
        This guide walks through the four ways a gateway breaks that claim: a
        fallback, an alias, a cached answer and a rewritten request. Each is
        shown on a response from{" "}
        <A href="https://github.com/Portkey-AI/gateway">Portkey</A>,{" "}
        <A href="https://github.com/maximhq/bifrost">Bifrost</A> or{" "}
        <A href="https://theagentrouter.ai/">Agent Router</A>, formerly Envoy AI
        Gateway, captured from a running gateway or written from its pinned
        source, with the way to detect it and the fix.
      </P>

      <H2>What an evaluation row has to prove</H2>

      <P>
        Before a row can count toward a decision, three things must be true:
      </P>

      <UL>
        <LI>
          <Strong>The model you named answered.</Strong> Not a backup, not an
          alias target, not a model the provider swapped in.
        </LI>
        <LI>
          <Strong>It answered now.</Strong> A stored answer says nothing about
          the candidate today, and its latency and cost are the cache&rsquo;s.
        </LI>
        <LI>
          <Strong>It answered the request you sent.</Strong> If the gateway
          added text, removed a parameter or converted the call to another API,
          the candidate was graded on a request it never saw.
        </LI>
      </UL>

      <P>
        None of this shows up in the status code: a gateway&rsquo;s job is to
        turn trouble into a 200. The evidence is in the response body and
        headers, reported differently by each gateway, and sometimes not at all.
        An evaluation route needs configuration that turns these features off,
        and a check on every response that catches what the configuration
        missed.
      </P>

      <H2>Where the examples come from</H2>

      <P>
        Every response below is a fixture in the open-source{" "}
        <A href="https://github.com/elm-os/rightmodeler">
          rightmodeler repository
        </A>
        , labeled by how it was produced:
      </P>

      <UL>
        <LI>
          <Strong>Captured from a running gateway:</Strong> Portkey 1.15.2 on{" "}
          <span className="whitespace-nowrap">2026-09-23</span>, against a local
          echo upstream that answers with the model it receives; Agent Router
          v1.1.0, run standalone with aigw run, on{" "}
          <span className="whitespace-nowrap">2026-09-23</span>; Bifrost v2.2.1
          on <span className="whitespace-nowrap">2026-09-24</span>. Agent Router
          and Bifrost called Vercel AI Gateway, and Bifrost also OpenRouter.
        </LI>
        <LI>
          <Strong>Written from pinned vendor source:</Strong> markers the stock
          images cannot produce locally, in{" "}
          <A href={`${REPO}/harness/fixtures/gateways/source-derived.json`}>
            <span className="whitespace-nowrap">source-derived.json</span>
          </A>
          , each entry citing the vendor file and lines at the pinned tag.
        </LI>
        <LI>
          <Strong>Hermetic stub test:</Strong>{" "}
          <A href={`${REPO}/harness/packages/replay/src/provenance.test.ts`}>
            provenance.test.ts
          </A>{" "}
          runs the response check over every fixture, offline.
        </LI>
        <LI>
          <Strong>Live provider test:</Strong> opt-in suites run each pinned
          image in Docker against Vercel AI Gateway, with models discovered from
          its live catalog, through a full replay and judge pass under a spend
          cap. The integration pages record those runs on{" "}
          <span className="whitespace-nowrap">2026-09-23</span>.
        </LI>
      </UL>

      <P>
        The images are pinned by digest. Agent Router&rsquo;s image keeps its
        Envoy name:
      </P>

      <Code>{`portkeyai/gateway:1.15.2
  sha256:97f094d9c8a764cbfaa2a7138c0017b247ca923bb06db1b4c13b7f8a33b5200d
envoyproxy/ai-gateway-cli:v1.1.0
  sha256:df69760bb46b6dcb8e9c6cc3cbf040d02e1b970dab05568c478fdcc418d144b6
maximhq/bifrost:v2.2.1
  sha256:a8942692af7b4b89196cd8fc33653b7353488dfd58b24078fe793b8574a8084b`}</Code>

      <H2>Pitfall 1: a fallback answers for the candidate</H2>

      <P>
        <Strong>What happens.</Strong> When a route&rsquo;s primary backend
        fails, the gateway sends the request to the next backend, often a
        different model, and returns that answer with a 200.{" "}
        <A href="https://portkey.ai/docs/product/ai-gateway/fallbacks">
          Portkey&rsquo;s fallback strategy
        </A>{" "}
        triggers on any non-2xx status by default, and{" "}
        <A href="https://theagentrouter.ai/docs/capabilities/traffic/model-name-virtualization">
          Agent Router&rsquo;s documentation
        </A>{" "}
        describes falling back from an expensive model to a less expensive one
        on the same provider. In an evaluation that does two kinds of damage:
        the fallback&rsquo;s answer is graded as the candidate&rsquo;s, and the
        candidate&rsquo;s failure, which you needed to count, disappears.
      </P>

      <P>
        <Strong>The example.</Strong> The captured route, written by{" "}
        <A href={`${MAIN}/harness/fixtures/gateways/envoy/capture-config.mjs`}>
          <span className="whitespace-nowrap">capture-config.mjs</span>
        </A>{" "}
        with the acceptance kit&rsquo;s{" "}
        <A
          href={`${REPO}/harness/fixtures/gateway-acceptance/envoy/aigw-config.mjs#L139-L181`}
        >
          <span className="whitespace-nowrap">aigw-config.mjs</span>
        </A>
        , answers the model name{" "}
        <span className="whitespace-nowrap">fallback-demo</span> with two
        backends: a priority-0 backend,{" "}
        <A href={`${MAIN}/harness/fixtures/gateways/envoy/mock-500.mjs`}>
          <span className="whitespace-nowrap">mock-500.mjs</span>
        </A>
        , that answers every call with HTTP 500, and a priority-1 backend on
        Vercel AI Gateway whose modelNameOverride sends{" "}
        <span className="whitespace-nowrap">amazon/nova-micro</span> upstream. A
        BackendTrafficPolicy retries on HTTP 500 with one attempt per priority,
        which, as{" "}
        <A href="https://theagentrouter.ai/docs/capabilities/traffic/provider-fallback">
          Agent Router&rsquo;s fallback guide
        </A>{" "}
        describes, is what moves a failed call to the next priority. The
        captured response, trimmed:
      </P>

      <Code>{`{
  "requestedModel": "fallback-demo",
  "status": 200,
  "headers": { "content-type": "application/json" },
  "body": {
    "model": "amazon/nova-micro",
    "choices": [
      {
        "message": {
          "role": "assistant",
          "content": "The town council approved the installation of …"
        }
      }
    ]
  }
}`}</Code>

      <P>
        The status is 200 and the body names{" "}
        <span className="whitespace-nowrap">amazon/nova-micro</span>. Nothing
        else in the captured response marks the fallback; the model field is the
        only witness.
      </P>

      <P>
        Fallbacks can also happen where the gateway cannot see them. Bifrost
        v2.2.1 reports a swap made inside a single provider call, which{" "}
        <A href="https://github.com/maximhq/bifrost/blob/transports/v2.2.1/core/schemas/bifrost.go#L1812-L1836">
          its source
        </A>{" "}
        describes as Anthropic&rsquo;s server-side fallback, in the
        server_side_fallback_model field of routing_info. In the entry written
        from that source, the response&rsquo;s own model field still names the
        model you asked for:
      </P>

      <Code>{`"model": "anthropic/claude-sonnet-4.5",
"extra_fields": {
  "routing_info": {
    "provider": "anthropic",
    "model": "claude-sonnet-4.5",
    "server_side_fallback_model": "anthropic/claude-haiku-4.5"
  }
}`}</Code>

      <P>
        <Strong>Evidence.</Strong> Captured from a running gateway:{" "}
        <A href={`${REPO}/harness/fixtures/gateways/envoy/fallback.json`}>
          envoy/fallback.json
        </A>{" "}
        and{" "}
        <A href={`${REPO}/harness/fixtures/gateways/envoy/plain.json`}>
          envoy/plain.json
        </A>
        . Written from pinned vendor source: the{" "}
        <A
          href={`${REPO}/harness/fixtures/gateways/source-derived.json#L187-L217`}
        >
          <span className="whitespace-nowrap">
            bifrost-server-side-fallback
          </span>{" "}
          entry
        </A>
        . Hermetic stub test: provenance.test.ts, in{" "}
        <A
          href={`${REPO}/harness/packages/replay/src/provenance.test.ts#L111-L118`}
        >
          the Envoy fallback test
        </A>{" "}
        and{" "}
        <A
          href={`${REPO}/harness/packages/replay/src/provenance.test.ts#L120-L156`}
        >
          the Bifrost marker test
        </A>
        . Live provider test:{" "}
        <A
          href={`${REPO}/harness/packages/rightmodeler/src/gateway-envoy.live.test.ts#L375-L448`}
        >
          <span className="whitespace-nowrap">gateway-envoy.live.test.ts</span>
        </A>{" "}
        puts a server that answers every call with HTTP 500 at priority 0 and
        checks that every answer the candidate&rsquo;s route returned is left
        out of the evidence.
      </P>

      <P>
        <Strong>Detect it.</Strong> Compare the model each response names with
        the model you requested, and read the gateway&rsquo;s own fallback
        markers. Names legitimately differ: Bifrost answers{" "}
        <span className="whitespace-nowrap">vercel/amazon/nova-micro</span> as{" "}
        <span className="whitespace-nowrap">amazon/nova-micro</span>, as{" "}
        <A href={`${REPO}/harness/fixtures/gateways/bifrost/chat.json`}>
          bifrost/chat.json
        </A>{" "}
        shows, and providers add dated snapshots such as{" "}
        <span className="whitespace-nowrap">gpt-4o-mini-2024-07-18</span> for{" "}
        <span className="whitespace-nowrap">gpt-4o-mini</span>. A strict
        comparison flags those and a loose one lets substitutions through; the
        rule in{" "}
        <A href={`${REPO}/harness/packages/replay/src/provenance.ts#L36-L52`}>
          provenance.ts
        </A>{" "}
        accepts those two differences, ignoring letter case, and refuses another
        model name, another vendor segment, or a suffix that is not a date. The
        check also needs a model field, and Agent Router&rsquo;s model name
        virtualization page notes that some upstreams, AWS Bedrock&rsquo;s
        Converse API among them, return none. There, the route configuration has
        to carry the guarantee.
      </P>

      <P>
        <Strong>Fix it.</Strong> Give the evaluation its own route: one backend
        per model under the upstream&rsquo;s own id, with no priority fallback,
        no modelNameOverride and no retry policy that moves to another backend.
        On Portkey, send no config with fallback targets; on Bifrost, send no{" "}
        <A href="https://docs.getbifrost.ai/features/retries-and-fallbacks">
          fallbacks array
        </A>{" "}
        in the request body. Treat a failed call as the candidate&rsquo;s
        result, not a gap to fill. Leave any answer from another model out of
        the evidence, and count it.
      </P>

      <H2>Pitfall 2: an alias answers under another name</H2>

      <P>
        <Strong>What happens.</Strong> Every gateway here lets the name you send
        resolve to a different model: Portkey&rsquo;s override_params, Agent
        Router&rsquo;s modelNameOverride, Bifrost&rsquo;s key aliases and
        routing rules.{" "}
        <A href="https://docs.getbifrost.ai/providers/aliasing-models">
          Bifrost&rsquo;s documentation
        </A>{" "}
        lists giving different teams different underlying models behind the same
        name as a use for aliases, and its routing-rule aliases apply per
        virtual key, team or customer. The same name can mean one model for your
        production key and another for your evaluation key.
      </P>

      <P>
        <Strong>The example.</Strong> The Portkey 1.15.2 capture,{" "}
        <A href={`${MAIN}/harness/fixtures/gateways/portkey/capture.sh`}>
          capture.sh
        </A>
        , routes to{" "}
        <A href={`${MAIN}/harness/fixtures/gateways/portkey/echo-upstream.mjs`}>
          an echo upstream
        </A>{" "}
        that answers with whatever model it receives, through an{" "}
        <span className="whitespace-nowrap">x-portkey-config</span> whose
        override_params sets the model to stub/override. The response, trimmed:
      </P>

      <Code>{`{
  "requestedModel": "stub/requested",
  "status": 200,
  "headers": {
    "x-portkey-cache-status": "DISABLED",
    "x-portkey-last-used-option-index": "config"
  },
  "body": {
    "model": "stub/override",
    "choices": [
      { "message": { "role": "assistant", "content": "echo 48" } }
    ]
  }
}`}</Code>

      <P>
        The request asked for stub/requested and the upstream received
        stub/override. The same call with no config comes back naming
        stub/requested.
      </P>

      <P>
        <Strong>Evidence.</Strong> Captured from a running gateway:{" "}
        <A
          href={`${REPO}/harness/fixtures/gateways/portkey/override-params.json`}
        >
          <span className="whitespace-nowrap">
            portkey/override-params.json
          </span>
        </A>{" "}
        and{" "}
        <A href={`${REPO}/harness/fixtures/gateways/portkey/plain.json`}>
          portkey/plain.json
        </A>
        . Hermetic stub test: provenance.test.ts, in{" "}
        <A
          href={`${REPO}/harness/packages/replay/src/provenance.test.ts#L62-L74`}
        >
          the override_params test
        </A>
        , beside{" "}
        <A
          href={`${REPO}/harness/packages/replay/src/provenance.test.ts#L158-L162`}
        >
          the test that accepts Bifrost&rsquo;s prefix-stripped answer
        </A>
        . Live provider test:{" "}
        <A
          href={`${REPO}/harness/packages/rightmodeler/src/gateway-portkey.live.test.ts#L161-L234`}
        >
          <span className="whitespace-nowrap">
            gateway-portkey.live.test.ts
          </span>
        </A>{" "}
        sends an <span className="whitespace-nowrap">x-portkey-config</span>{" "}
        whose override_params names the dearer of two incumbent models,{" "}
        <A
          href={`${REPO}/harness/packages/rightmodeler/src/gateway-bifrost.live.test.ts#L346-L411`}
        >
          <span className="whitespace-nowrap">
            gateway-bifrost.live.test.ts
          </span>
        </A>{" "}
        maps a candidate to an incumbent with a key alias, and both check that
        every candidate answer is left out of the evidence.
      </P>

      <P>
        <Strong>Detect it.</Strong> The served-model comparison from the first
        pitfall catches an alias whenever the upstream reports the model it ran.
        Portkey&rsquo;s{" "}
        <span className="whitespace-nowrap">
          x-portkey-last-used-option-index
        </span>{" "}
        reports which target of a config served the call; with a single target
        it reads config, as in both captures, so for override_params the model
        field is the witness. Do not infer from your request that no alias
        applied:{" "}
        <A href="https://portkey.ai/docs/product/ai-gateway/configs">
          Portkey&rsquo;s docs
        </A>{" "}
        note that a default config attached to an API key applies its routing,
        fallbacks and caching even when a request carries no{" "}
        <span className="whitespace-nowrap">x-portkey-config</span> header.
      </P>

      <P>
        <Strong>Fix it.</Strong> Name evaluation models by their upstream ids,
        configure no aliases, routing rules, overrides or configs for them, and
        run the evaluation with a key whose settings you have read.
      </P>

      <H2>Pitfall 3: a cache answers instead of the model</H2>

      <P>
        <Strong>What happens.</Strong> A response cache returns a stored answer
        without calling the model: an exact cache for an identical request, a
        semantic cache for a merely similar one. The answer is not a fresh
        sample from the candidate, and its latency and cost belong to the cache,
        which flatters exactly the numbers a cost evaluation reads. A
        served-model check does not help, because a cached answer names the
        model that wrote it.
      </P>

      <P>
        The details matter.{" "}
        <A href="https://portkey.ai/docs/product/ai-gateway/cache-simple-and-semantic">
          Portkey&rsquo;s semantic cache
        </A>{" "}
        requires the model and every other body parameter to match exactly but
        ignores the system prompt, so an evaluation of a system-prompt change
        can be answered from an entry written under the old prompt.{" "}
        <A href="https://docs.getbifrost.ai/features/semantic-caching">
          Bifrost
        </A>{" "}
        keys its cache by model by default (cache_by_model: true); turned off,
        different models can share entries. And Bifrost&rsquo;s{" "}
        <span className="whitespace-nowrap">x-bf-cache-no-store</span> header
        skips writing the response but, in its docs&rsquo; words, &ldquo;still
        serves cached hits&rdquo;.
      </P>

      <P>
        <Strong>The example.</Strong> Caching is compiled out of the stock
        Portkey image, whose{" "}
        <A href="https://github.com/Portkey-AI/gateway/blob/v1.15.2/conf.json">
          conf.json
        </A>{" "}
        sets cache to false, so the captured Portkey responses report{" "}
        <span className="whitespace-nowrap">
          x-portkey-cache-status: DISABLED
        </span>
        . The hit markers are written from pinned vendor source: Portkey&rsquo;s
        status values from{" "}
        <A href="https://github.com/Portkey-AI/gateway/blob/v1.15.2/src/middlewares/cache/index.ts#L5-L12">
          src/middlewares/cache/index.ts
        </A>{" "}
        at v1.15.2, and Bifrost&rsquo;s cache_debug from core/schemas/bifrost.go
        at transports/v2.2.1:
      </P>

      <Code>{`x-portkey-cache-status: SEMANTIC HIT

"extra_fields": {
  "cache_debug": { "cache_hit": true, "hit_type": "semantic" }
}`}</Code>

      <P>
        <Strong>Evidence.</Strong> Written from pinned vendor source: the{" "}
        <A
          href={`${REPO}/harness/fixtures/gateways/source-derived.json#L2-L24`}
        >
          <span className="whitespace-nowrap">portkey-cache-hit</span>
        </A>
        ,{" "}
        <A
          href={`${REPO}/harness/fixtures/gateways/source-derived.json#L25-L47`}
        >
          <span className="whitespace-nowrap">portkey-semantic-cache-hit</span>
        </A>{" "}
        and{" "}
        <A
          href={`${REPO}/harness/fixtures/gateways/source-derived.json#L76-L102`}
        >
          <span className="whitespace-nowrap">bifrost-cache-hit</span>
        </A>{" "}
        entries. Captured from a running gateway:{" "}
        <A href={`${REPO}/harness/fixtures/gateways/portkey/plain.json`}>
          portkey/plain.json
        </A>
        , whose DISABLED status counts as fresh. Hermetic stub test:
        provenance.test.ts, in{" "}
        <A
          href={`${REPO}/harness/packages/replay/src/provenance.test.ts#L76-L98`}
        >
          the Portkey cache-status test
        </A>{" "}
        and{" "}
        <A
          href={`${REPO}/harness/packages/replay/src/provenance.test.ts#L120-L156`}
        >
          the Bifrost marker test
        </A>
        .
      </P>

      <P>
        <Strong>Detect it.</Strong> Read the cache marker on every response.
        Portkey&rsquo;s{" "}
        <span className="whitespace-nowrap">x-portkey-cache-status</span>{" "}
        reports HIT or SEMANTIC HIT for a cached answer, and MISS, SEMANTIC
        MISS, REFRESH or DISABLED for a fresh one. Bifrost reports the hit in
        the response body, as extra_fields.cache_debug.cache_hit, and on a
        stream only the final chunk carries the full payload, so the check has
        to read the body, and the last chunk of a stream, not only the headers.
      </P>

      <P>
        <Strong>Fix it.</Strong> Turn caching off on the evaluation route.
        Bifrost caches only when a request carries{" "}
        <span className="whitespace-nowrap">x-bf-cache-key</span> or the plugin
        has a default_cache_key, so send no cache key, leave the default empty,
        and add{" "}
        <span className="whitespace-nowrap">x-bf-cache-no-store: true</span> so
        evaluation answers never land in production&rsquo;s cache. On Portkey,
        send no cache config. Leave out any hit that still arrives.
      </P>

      <H2>Pitfall 4: the gateway rewrites the request</H2>

      <P>
        <Strong>What happens.</Strong> Some gateway features change the request
        on its way upstream: guardrail mutators that edit messages, and
        compatibility layers that drop parameters a model does not support or
        convert the call to another API. The model answers honestly, to a
        different question. This is the subtlest of the four: the served model
        is right and nothing was cached, yet the output is not evidence about
        the request you meant to test.
      </P>

      <P>
        <Strong>The example.</Strong>{" "}
        <A href="https://docs.getbifrost.ai/features/compat-plugin">
          Bifrost&rsquo;s compat plugin
        </A>{" "}
        drops parameters its model catalog does not list for a model and reports
        them in dropped_compat_plugin_params. The v2.2.1 capture sends
        response_format to{" "}
        <span className="whitespace-nowrap">
          openrouter/amazon/nova-micro-v1
        </span>
        , whose catalog entry lists no structured output, under{" "}
        <A
          href={`${MAIN}/harness/fixtures/gateways/bifrost/compat-drop-config.json`}
        >
          <span className="whitespace-nowrap">compat-drop-config.json</span>
        </A>
        , whose client block leaves every compat flag out. The response,
        trimmed:
      </P>

      <Code>{`{
  "requestedModel": "openrouter/amazon/nova-micro-v1",
  "status": 200,
  "body": {
    "model": "amazon/nova-micro-v1",
    "choices": [
      {
        "message": {
          "role": "assistant",
          "content": "The city mentioned in the note is Lisbon."
        }
      }
    ],
    "extra_fields": {
      "dropped_compat_plugin_params": ["response_format"]
    }
  }
}`}</Code>

      <P>
        A structured-output request came back as a prose sentence, with a 200.
        An evaluation that scores JSON validity would fail the candidate for
        ignoring a parameter it never received; one that scores content would
        pass it on a request with no schema.
      </P>

      <P>
        The defaults are the trap.{" "}
        <A href="https://docs.getbifrost.ai/deployment-guides/config-json/client">
          Bifrost&rsquo;s config reference
        </A>{" "}
        lists each compat flag as false by default as of{" "}
        <span className="whitespace-nowrap">2026-09-24</span>, while in the{" "}
        <A href="https://github.com/maximhq/bifrost/blob/transports/v2.2.1/framework/configstore/clientconfig.go#L56-L76">
          source at v2.2.1
        </A>{" "}
        a client block that omits a flag turns it on, and the capture matches
        the source. A request can also switch the plugin on with an{" "}
        <span className="whitespace-nowrap">x-bf-compat</span> header.
      </P>

      <P>
        Portkey reports its rewrites in hook_results. The third request in{" "}
        <A href={`${MAIN}/harness/fixtures/gateways/portkey/capture.sh`}>
          capture.sh
        </A>{" "}
        sends a config with the default.addPrefix mutator, which prepends text
        to the user message. The response, trimmed:
      </P>

      <Code>{`"hook_results": {
  "before_request_hooks": [
    {
      "id": "input_guardrail_pod",
      "type": "mutator",
      "verdict": true,
      "transformed": true,
      "checks": [
        {
          "id": "default.addPrefix",
          "transformed": true,
          "data": {
            "prefix": "PREFIX-INJECTED: ",
            "applyToRole": "user"
          }
        }
      ]
    }
  ]
}`}</Code>

      <P>
        <A href="https://portkey.ai/docs/product/guardrails">
          Portkey&rsquo;s guardrail docs
        </A>{" "}
        define transformed as whether a guardrail modified the request or
        response; in a stream, hook_results are hidden unless{" "}
        <span className="whitespace-nowrap">
          x-portkey-strict-open-ai-compliance
        </span>{" "}
        is false.
      </P>

      <P>
        <Strong>Evidence.</Strong> Captured from a running gateway:{" "}
        <A href={`${REPO}/harness/fixtures/gateways/bifrost/compat-drop.json`}>
          <span className="whitespace-nowrap">bifrost/compat-drop.json</span>
        </A>{" "}
        and{" "}
        <A
          href={`${REPO}/harness/fixtures/gateways/portkey/input-mutator.json`}
        >
          <span className="whitespace-nowrap">portkey/input-mutator.json</span>
        </A>
        . Written from pinned vendor source: the{" "}
        <A
          href={`${REPO}/harness/fixtures/gateways/source-derived.json#L103-L129`}
        >
          <span className="whitespace-nowrap">bifrost-dropped-params</span>
        </A>
        ,{" "}
        <A
          href={`${REPO}/harness/fixtures/gateways/source-derived.json#L130-L159`}
        >
          <span className="whitespace-nowrap">bifrost-dropped-tools</span>
        </A>{" "}
        and{" "}
        <A
          href={`${REPO}/harness/fixtures/gateways/source-derived.json#L160-L186`}
        >
          <span className="whitespace-nowrap">bifrost-converted-request</span>
        </A>{" "}
        entries. Hermetic stub test: provenance.test.ts, in{" "}
        <A
          href={`${REPO}/harness/packages/replay/src/provenance.test.ts#L164-L173`}
        >
          the <span className="whitespace-nowrap">compat-drop</span> test
        </A>
        ,{" "}
        <A
          href={`${REPO}/harness/packages/replay/src/provenance.test.ts#L100-L109`}
        >
          the Portkey hook test
        </A>{" "}
        and{" "}
        <A
          href={`${REPO}/harness/packages/replay/src/provenance.test.ts#L120-L156`}
        >
          the Bifrost marker test
        </A>
        .
      </P>

      <P>
        <Strong>Detect it.</Strong> Treat any reported change as disqualifying:
        transformed: true in Portkey&rsquo;s hook results, and
        dropped_compat_plugin_params, dropped_unsupported_tools or
        converted_request_type in Bifrost&rsquo;s extra_fields.
      </P>

      <P>
        <Strong>Fix it.</Strong> Set every compat flag to false explicitly, send
        no <span className="whitespace-nowrap">x-bf-compat</span> header, and
        attach no guardrails or mutators to the evaluation route. The client
        block of the acceptance kit&rsquo;s replay-safe{" "}
        <A
          href={`${REPO}/harness/fixtures/gateway-acceptance/bifrost/config.json`}
        >
          bifrost/config.json
        </A>
        :
      </P>

      <Code>{`"client": {
  "enable_logging": true,
  "compat": {
    "convert_text_to_chat": false,
    "convert_chat_to_responses": false,
    "should_drop_params": false,
    "should_convert_params": false,
    "azure_deepseek": false
  }
}`}</Code>

      <P>
        If a candidate cannot take response_format or tools, that is a finding
        about the candidate, not something for the route to smooth over.
      </P>

      <H2>The reference can be contaminated too</H2>

      <P>
        An evaluation that grades candidates against the outputs your team
        already accepted, the approach called{" "}
        <A href="/glossary#reference-evidence">reference evidence</A>, has a
        second exposure: those outputs came through the same gateway. If
        production traffic fell back, some references were written by the
        fallback model and recorded under the name your application asked for.
      </P>

      <P>
        Agent Router shows the difference.{" "}
        <A href="https://theagentrouter.ai/docs/capabilities/observability/tracing">
          Its tracing
        </A>{" "}
        records the full request and response on each span by default, which
        makes the spans usable as references. On the evaluation route a
        priority-fallback answer is caught, because the response names another
        model. In exported traces it is not: the span recorded for the same
        captured fallback call, line 9 of{" "}
        <A
          href={`${REPO}/harness/fixtures/traces/envoy-openinference.jsonl#L9`}
        >
          <span className="whitespace-nowrap">envoy-openinference.jsonl</span>
        </A>
        , carries a request body naming{" "}
        <span className="whitespace-nowrap">fallback-demo</span>, an
        llm.model_name of{" "}
        <span className="whitespace-nowrap">amazon/nova-micro</span>, and no
        attribute that says a fallback chose it. A modelNameOverride alias
        produces the same pair of names, so the span cannot tell the two apart.
        A reader that takes the requested model from the request body, as
        rightmodeler&rsquo;s does, records that output as{" "}
        <span className="whitespace-nowrap">fallback-demo&rsquo;s</span>, as{" "}
        <A
          href={`${REPO}/harness/packages/rightmodeler/src/data/adapters/openinference.test.ts#L72-L113`}
        >
          its hermetic test
        </A>{" "}
        asserts. The span does carry both names, which is enough to flag it: a
        span whose llm.model_name names another model than its request body was
        not answered by the model your application named, whether a fallback or
        an alias chose it. Line 9 is the only such span in the file. Keep
        fallback routes off the traffic you export as references.
      </P>

      <P>
        Bifrost&rsquo;s log store keeps the difference visible: a fallback
        attempt is its own row with a fallback_index above 0, so{" "}
        <A
          href={`${REPO}/harness/packages/rightmodeler/src/data/adapters/bifrost.ts#L54-L62`}
        >
          rightmodeler&rsquo;s Bifrost reader
        </A>{" "}
        leaves it out as fallback_answer and the failed primary as call_failed.
        The hermetic{" "}
        <A
          href={`${REPO}/harness/packages/rightmodeler/src/data/adapters/bifrost.test.ts#L68-L83`}
        >
          bifrost.test.ts
        </A>{" "}
        checks this on a log export captured from v2.2.1 on{" "}
        <span className="whitespace-nowrap">2026-09-24</span>, and the Bifrost
        live provider test on a fresh one. Export without roots_only=true, which{" "}
        <A href="https://docs.getbifrost.ai/api-reference/logging/get-logs">
          Bifrost&rsquo;s API reference
        </A>{" "}
        describes as collapsing fallback rows into their root.
      </P>

      <H2>A checklist for an evaluation route</H2>

      <UL>
        <LI>
          One backend per evaluated model, named by the upstream&rsquo;s own id.
        </LI>
        <LI>
          No fallbacks, priority backends, or retries that move to another
          backend.
        </LI>
        <LI>
          No aliases, overrides, routing rules or configs on the
          evaluation&rsquo;s model names or key.
        </LI>
        <LI>
          Caching off, and a no-store header on every evaluation call where the
          gateway has one.
        </LI>
        <LI>
          No guardrail mutators; compatibility flags set to false explicitly.
        </LI>
        <LI>
          For every response, its named model, cache marker and rewrite markers
          recorded, and every response that fails a check left out and counted.
        </LI>
        <LI>
          No verdict for a model with more than a small share of its responses
          left out, until the route is fixed and the evaluation rerun.
        </LI>
        <LI>
          References exported only from routes without fallbacks, or from a log
          store that marks fallback rows.
        </LI>
        <LI>Evaluation traffic tagged, and left out of the next export.</LI>
      </UL>

      <H2>How rightmodeler applies these checks</H2>

      <P>
        rightmodeler is an MIT-licensed CLI on npm (npx rightmodeler init) that
        reads the traces you already export, replays recorded steps through
        cheaper candidates from your provider&rsquo;s live catalog, and judges
        them against the outputs your team already accepted, reporting reference
        agreement, sample size and abstentions against a held-out quality floor.
        It is never in the request path: its output is a draft pull request that
        changes only model identifiers, for a human to review and merge. It
        replays through any OpenAI-compatible base URL, including each gateway
        above.
      </P>

      <P>
        Every replayed and judge response goes through{" "}
        <A href={`${REPO}/harness/packages/replay/src/provenance.ts#L67-L132`}>
          the check in provenance.ts
        </A>{" "}
        before it counts. A response that names another model, reports a cache
        hit or reports a changed request is recorded as substituted, never
        graded, and counted as attribution_substituted. If more than 5% of a
        family&rsquo;s replays are left out of the evidence, the family{" "}
        <A href="/glossary#abstain">abstains</A> instead of deciding. A
        replay_responses_substituted warning names the requested and served
        models and the fix, and a judge that answers as another model is retired
        while the next-ranked judge takes over. The replay-safe setup for each
        gateway is on the <A href="/integrations/portkey">Portkey</A>,{" "}
        <A href="/integrations/bifrost">Bifrost</A> and{" "}
        <A href="/integrations/envoy-ai-gateway">Agent Router</A> integration
        pages, and the method is on <A href="/how-it-works">how it works</A>.
      </P>

      <H2>Reproduce it</H2>

      <P>
        The hermetic checks need no network and no keys. From a clone of the
        repository:
      </P>

      <Code>{`pnpm install --frozen-lockfile
pnpm --filter @rightmodeler/replay exec vitest run src/provenance.test.ts`}</Code>

      <P>
        The live provider tests need Docker and an AI_GATEWAY_API_KEY for Vercel
        AI Gateway, and each leg runs under a spend cap of $0.25 or less. The
        fixtures README maps each pitfall to its fixture, tests and evidence
        label, with the exact commands:{" "}
        <A
          href={`${MAIN}/harness/fixtures/gateways/README.md#reproducing-the-gateway-evaluation-pitfalls`}
        >
          Reproducing the gateway evaluation pitfalls
        </A>
        .
      </P>
    </Prose>
  );
}

// The same post as clean Markdown, for llms-context.txt and any LLM-facing surface. Kept in sync with
// Body above by hand.
export const markdown = `# How an AI gateway can invalidate your model evaluation.

You want to know whether a cheaper model can take over a step in your application. So you send the step's recorded inputs to the candidate through the gateway that already fronts your traffic, grade what comes back, and read the score. Every call returns HTTP 200. Some of those answers were not written by the candidate.

A gateway exists to keep production answering: it retries on another backend, maps one name to several deployments, serves repeats from a cache, and adjusts requests a provider cannot take. Each of those is a feature in production and a contamination in an evaluation, which makes one claim per row: this model, given this request, produced this output. This guide walks through the four ways a gateway breaks that claim: a fallback, an alias, a cached answer and a rewritten request. Each is shown on a response from [Portkey](https://github.com/Portkey-AI/gateway), [Bifrost](https://github.com/maximhq/bifrost) or [Agent Router](https://theagentrouter.ai/), formerly Envoy AI Gateway, captured from a running gateway or written from its pinned source, with the way to detect it and the fix.

## What an evaluation row has to prove

Before a row can count toward a decision, three things must be true:

- **The model you named answered.** Not a backup, not an alias target, not a model the provider swapped in.
- **It answered now.** A stored answer says nothing about the candidate today, and its latency and cost are the cache's.
- **It answered the request you sent.** If the gateway added text, removed a parameter or converted the call to another API, the candidate was graded on a request it never saw.

None of this shows up in the status code: a gateway's job is to turn trouble into a 200. The evidence is in the response body and headers, reported differently by each gateway, and sometimes not at all. An evaluation route needs configuration that turns these features off, and a check on every response that catches what the configuration missed.

## Where the examples come from

Every response below is a fixture in the open-source [rightmodeler repository](https://github.com/elm-os/rightmodeler), labeled by how it was produced:

- **Captured from a running gateway:** Portkey 1.15.2 on 2026-09-23, against a local echo upstream that answers with the model it receives; Agent Router v1.1.0, run standalone with aigw run, on 2026-09-23; Bifrost v2.2.1 on 2026-09-24. Agent Router and Bifrost called Vercel AI Gateway, and Bifrost also OpenRouter.
- **Written from pinned vendor source:** markers the stock images cannot produce locally, in [source-derived.json](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/gateways/source-derived.json), each entry citing the vendor file and lines at the pinned tag.
- **Hermetic stub test:** [provenance.test.ts](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/packages/replay/src/provenance.test.ts) runs the response check over every fixture, offline.
- **Live provider test:** opt-in suites run each pinned image in Docker against Vercel AI Gateway, with models discovered from its live catalog, through a full replay and judge pass under a spend cap. The integration pages record those runs on 2026-09-23.

The images are pinned by digest. Agent Router's image keeps its Envoy name:

    portkeyai/gateway:1.15.2
      sha256:97f094d9c8a764cbfaa2a7138c0017b247ca923bb06db1b4c13b7f8a33b5200d
    envoyproxy/ai-gateway-cli:v1.1.0
      sha256:df69760bb46b6dcb8e9c6cc3cbf040d02e1b970dab05568c478fdcc418d144b6
    maximhq/bifrost:v2.2.1
      sha256:a8942692af7b4b89196cd8fc33653b7353488dfd58b24078fe793b8574a8084b

## Pitfall 1: a fallback answers for the candidate

**What happens.** When a route's primary backend fails, the gateway sends the request to the next backend, often a different model, and returns that answer with a 200. [Portkey's fallback strategy](https://portkey.ai/docs/product/ai-gateway/fallbacks) triggers on any non-2xx status by default, and [Agent Router's documentation](https://theagentrouter.ai/docs/capabilities/traffic/model-name-virtualization) describes falling back from an expensive model to a less expensive one on the same provider. In an evaluation that does two kinds of damage: the fallback's answer is graded as the candidate's, and the candidate's failure, which you needed to count, disappears.

**The example.** The captured route, written by [capture-config.mjs](https://github.com/elm-os/rightmodeler/blob/main/harness/fixtures/gateways/envoy/capture-config.mjs) with the acceptance kit's [aigw-config.mjs](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/gateway-acceptance/envoy/aigw-config.mjs#L139-L181), answers the model name fallback-demo with two backends: a priority-0 backend, [mock-500.mjs](https://github.com/elm-os/rightmodeler/blob/main/harness/fixtures/gateways/envoy/mock-500.mjs), that answers every call with HTTP 500, and a priority-1 backend on Vercel AI Gateway whose modelNameOverride sends amazon/nova-micro upstream. A BackendTrafficPolicy retries on HTTP 500 with one attempt per priority, which, as [Agent Router's fallback guide](https://theagentrouter.ai/docs/capabilities/traffic/provider-fallback) describes, is what moves a failed call to the next priority. The captured response, trimmed:

    {
      "requestedModel": "fallback-demo",
      "status": 200,
      "headers": { "content-type": "application/json" },
      "body": {
        "model": "amazon/nova-micro",
        "choices": [
          {
            "message": {
              "role": "assistant",
              "content": "The town council approved the installation of …"
            }
          }
        ]
      }
    }

The status is 200 and the body names amazon/nova-micro. Nothing else in the captured response marks the fallback; the model field is the only witness.

Fallbacks can also happen where the gateway cannot see them. Bifrost v2.2.1 reports a swap made inside a single provider call, which [its source](https://github.com/maximhq/bifrost/blob/transports/v2.2.1/core/schemas/bifrost.go#L1812-L1836) describes as Anthropic's server-side fallback, in the server_side_fallback_model field of routing_info. In the entry written from that source, the response's own model field still names the model you asked for:

    "model": "anthropic/claude-sonnet-4.5",
    "extra_fields": {
      "routing_info": {
        "provider": "anthropic",
        "model": "claude-sonnet-4.5",
        "server_side_fallback_model": "anthropic/claude-haiku-4.5"
      }
    }

**Evidence.** Captured from a running gateway: [envoy/fallback.json](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/gateways/envoy/fallback.json) and [envoy/plain.json](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/gateways/envoy/plain.json). Written from pinned vendor source: the [bifrost-server-side-fallback entry](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/gateways/source-derived.json#L187-L217). Hermetic stub test: provenance.test.ts, in [the Envoy fallback test](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/packages/replay/src/provenance.test.ts#L111-L118) and [the Bifrost marker test](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/packages/replay/src/provenance.test.ts#L120-L156). Live provider test: [gateway-envoy.live.test.ts](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/packages/rightmodeler/src/gateway-envoy.live.test.ts#L375-L448) puts a server that answers every call with HTTP 500 at priority 0 and checks that every answer the candidate's route returned is left out of the evidence.

**Detect it.** Compare the model each response names with the model you requested, and read the gateway's own fallback markers. Names legitimately differ: Bifrost answers vercel/amazon/nova-micro as amazon/nova-micro, as [bifrost/chat.json](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/gateways/bifrost/chat.json) shows, and providers add dated snapshots such as gpt-4o-mini-2024-07-18 for gpt-4o-mini. A strict comparison flags those and a loose one lets substitutions through; the rule in [provenance.ts](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/packages/replay/src/provenance.ts#L36-L52) accepts those two differences, ignoring letter case, and refuses another model name, another vendor segment, or a suffix that is not a date. The check also needs a model field, and Agent Router's model name virtualization page notes that some upstreams, AWS Bedrock's Converse API among them, return none. There, the route configuration has to carry the guarantee.

**Fix it.** Give the evaluation its own route: one backend per model under the upstream's own id, with no priority fallback, no modelNameOverride and no retry policy that moves to another backend. On Portkey, send no config with fallback targets; on Bifrost, send no [fallbacks array](https://docs.getbifrost.ai/features/retries-and-fallbacks) in the request body. Treat a failed call as the candidate's result, not a gap to fill. Leave any answer from another model out of the evidence, and count it.

## Pitfall 2: an alias answers under another name

**What happens.** Every gateway here lets the name you send resolve to a different model: Portkey's override_params, Agent Router's modelNameOverride, Bifrost's key aliases and routing rules. [Bifrost's documentation](https://docs.getbifrost.ai/providers/aliasing-models) lists giving different teams different underlying models behind the same name as a use for aliases, and its routing-rule aliases apply per virtual key, team or customer. The same name can mean one model for your production key and another for your evaluation key.

**The example.** The Portkey 1.15.2 capture, [capture.sh](https://github.com/elm-os/rightmodeler/blob/main/harness/fixtures/gateways/portkey/capture.sh), routes to [an echo upstream](https://github.com/elm-os/rightmodeler/blob/main/harness/fixtures/gateways/portkey/echo-upstream.mjs) that answers with whatever model it receives, through an x-portkey-config whose override_params sets the model to stub/override. The response, trimmed:

    {
      "requestedModel": "stub/requested",
      "status": 200,
      "headers": {
        "x-portkey-cache-status": "DISABLED",
        "x-portkey-last-used-option-index": "config"
      },
      "body": {
        "model": "stub/override",
        "choices": [
          { "message": { "role": "assistant", "content": "echo 48" } }
        ]
      }
    }

The request asked for stub/requested and the upstream received stub/override. The same call with no config comes back naming stub/requested.

**Evidence.** Captured from a running gateway: [portkey/override-params.json](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/gateways/portkey/override-params.json) and [portkey/plain.json](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/gateways/portkey/plain.json). Hermetic stub test: provenance.test.ts, in [the override_params test](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/packages/replay/src/provenance.test.ts#L62-L74), beside [the test that accepts Bifrost's prefix-stripped answer](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/packages/replay/src/provenance.test.ts#L158-L162). Live provider test: [gateway-portkey.live.test.ts](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/packages/rightmodeler/src/gateway-portkey.live.test.ts#L161-L234) sends an x-portkey-config whose override_params names the dearer of two incumbent models, [gateway-bifrost.live.test.ts](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/packages/rightmodeler/src/gateway-bifrost.live.test.ts#L346-L411) maps a candidate to an incumbent with a key alias, and both check that every candidate answer is left out of the evidence.

**Detect it.** The served-model comparison from the first pitfall catches an alias whenever the upstream reports the model it ran. Portkey's x-portkey-last-used-option-index reports which target of a config served the call; with a single target it reads config, as in both captures, so for override_params the model field is the witness. Do not infer from your request that no alias applied: [Portkey's docs](https://portkey.ai/docs/product/ai-gateway/configs) note that a default config attached to an API key applies its routing, fallbacks and caching even when a request carries no x-portkey-config header.

**Fix it.** Name evaluation models by their upstream ids, configure no aliases, routing rules, overrides or configs for them, and run the evaluation with a key whose settings you have read.

## Pitfall 3: a cache answers instead of the model

**What happens.** A response cache returns a stored answer without calling the model: an exact cache for an identical request, a semantic cache for a merely similar one. The answer is not a fresh sample from the candidate, and its latency and cost belong to the cache, which flatters exactly the numbers a cost evaluation reads. A served-model check does not help, because a cached answer names the model that wrote it.

The details matter. [Portkey's semantic cache](https://portkey.ai/docs/product/ai-gateway/cache-simple-and-semantic) requires the model and every other body parameter to match exactly but ignores the system prompt, so an evaluation of a system-prompt change can be answered from an entry written under the old prompt. [Bifrost](https://docs.getbifrost.ai/features/semantic-caching) keys its cache by model by default (cache_by_model: true); turned off, different models can share entries. And Bifrost's x-bf-cache-no-store header skips writing the response but, in its docs' words, "still serves cached hits".

**The example.** Caching is compiled out of the stock Portkey image, whose [conf.json](https://github.com/Portkey-AI/gateway/blob/v1.15.2/conf.json) sets cache to false, so the captured Portkey responses report x-portkey-cache-status: DISABLED. The hit markers are written from pinned vendor source: Portkey's status values from [src/middlewares/cache/index.ts](https://github.com/Portkey-AI/gateway/blob/v1.15.2/src/middlewares/cache/index.ts#L5-L12) at v1.15.2, and Bifrost's cache_debug from core/schemas/bifrost.go at transports/v2.2.1:

    x-portkey-cache-status: SEMANTIC HIT

    "extra_fields": {
      "cache_debug": { "cache_hit": true, "hit_type": "semantic" }
    }

**Evidence.** Written from pinned vendor source: the [portkey-cache-hit](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/gateways/source-derived.json#L2-L24), [portkey-semantic-cache-hit](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/gateways/source-derived.json#L25-L47) and [bifrost-cache-hit](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/gateways/source-derived.json#L76-L102) entries. Captured from a running gateway: [portkey/plain.json](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/gateways/portkey/plain.json), whose DISABLED status counts as fresh. Hermetic stub test: provenance.test.ts, in [the Portkey cache-status test](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/packages/replay/src/provenance.test.ts#L76-L98) and [the Bifrost marker test](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/packages/replay/src/provenance.test.ts#L120-L156).

**Detect it.** Read the cache marker on every response. Portkey's x-portkey-cache-status reports HIT or SEMANTIC HIT for a cached answer, and MISS, SEMANTIC MISS, REFRESH or DISABLED for a fresh one. Bifrost reports the hit in the response body, as extra_fields.cache_debug.cache_hit, and on a stream only the final chunk carries the full payload, so the check has to read the body, and the last chunk of a stream, not only the headers.

**Fix it.** Turn caching off on the evaluation route. Bifrost caches only when a request carries x-bf-cache-key or the plugin has a default_cache_key, so send no cache key, leave the default empty, and add x-bf-cache-no-store: true so evaluation answers never land in production's cache. On Portkey, send no cache config. Leave out any hit that still arrives.

## Pitfall 4: the gateway rewrites the request

**What happens.** Some gateway features change the request on its way upstream: guardrail mutators that edit messages, and compatibility layers that drop parameters a model does not support or convert the call to another API. The model answers honestly, to a different question. This is the subtlest of the four: the served model is right and nothing was cached, yet the output is not evidence about the request you meant to test.

**The example.** [Bifrost's compat plugin](https://docs.getbifrost.ai/features/compat-plugin) drops parameters its model catalog does not list for a model and reports them in dropped_compat_plugin_params. The v2.2.1 capture sends response_format to openrouter/amazon/nova-micro-v1, whose catalog entry lists no structured output, under [compat-drop-config.json](https://github.com/elm-os/rightmodeler/blob/main/harness/fixtures/gateways/bifrost/compat-drop-config.json), whose client block leaves every compat flag out. The response, trimmed:

    {
      "requestedModel": "openrouter/amazon/nova-micro-v1",
      "status": 200,
      "body": {
        "model": "amazon/nova-micro-v1",
        "choices": [
          {
            "message": {
              "role": "assistant",
              "content": "The city mentioned in the note is Lisbon."
            }
          }
        ],
        "extra_fields": {
          "dropped_compat_plugin_params": ["response_format"]
        }
      }
    }

A structured-output request came back as a prose sentence, with a 200. An evaluation that scores JSON validity would fail the candidate for ignoring a parameter it never received; one that scores content would pass it on a request with no schema.

The defaults are the trap. [Bifrost's config reference](https://docs.getbifrost.ai/deployment-guides/config-json/client) lists each compat flag as false by default as of 2026-09-24, while in the [source at v2.2.1](https://github.com/maximhq/bifrost/blob/transports/v2.2.1/framework/configstore/clientconfig.go#L56-L76) a client block that omits a flag turns it on, and the capture matches the source. A request can also switch the plugin on with an x-bf-compat header.

Portkey reports its rewrites in hook_results. The third request in [capture.sh](https://github.com/elm-os/rightmodeler/blob/main/harness/fixtures/gateways/portkey/capture.sh) sends a config with the default.addPrefix mutator, which prepends text to the user message. The response, trimmed:

    "hook_results": {
      "before_request_hooks": [
        {
          "id": "input_guardrail_pod",
          "type": "mutator",
          "verdict": true,
          "transformed": true,
          "checks": [
            {
              "id": "default.addPrefix",
              "transformed": true,
              "data": {
                "prefix": "PREFIX-INJECTED: ",
                "applyToRole": "user"
              }
            }
          ]
        }
      ]
    }

[Portkey's guardrail docs](https://portkey.ai/docs/product/guardrails) define transformed as whether a guardrail modified the request or response; in a stream, hook_results are hidden unless x-portkey-strict-open-ai-compliance is false.

**Evidence.** Captured from a running gateway: [bifrost/compat-drop.json](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/gateways/bifrost/compat-drop.json) and [portkey/input-mutator.json](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/gateways/portkey/input-mutator.json). Written from pinned vendor source: the [bifrost-dropped-params](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/gateways/source-derived.json#L103-L129), [bifrost-dropped-tools](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/gateways/source-derived.json#L130-L159) and [bifrost-converted-request](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/gateways/source-derived.json#L160-L186) entries. Hermetic stub test: provenance.test.ts, in [the compat-drop test](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/packages/replay/src/provenance.test.ts#L164-L173), [the Portkey hook test](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/packages/replay/src/provenance.test.ts#L100-L109) and [the Bifrost marker test](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/packages/replay/src/provenance.test.ts#L120-L156).

**Detect it.** Treat any reported change as disqualifying: transformed: true in Portkey's hook results, and dropped_compat_plugin_params, dropped_unsupported_tools or converted_request_type in Bifrost's extra_fields.

**Fix it.** Set every compat flag to false explicitly, send no x-bf-compat header, and attach no guardrails or mutators to the evaluation route. The client block of the acceptance kit's replay-safe [bifrost/config.json](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/gateway-acceptance/bifrost/config.json):

    "client": {
      "enable_logging": true,
      "compat": {
        "convert_text_to_chat": false,
        "convert_chat_to_responses": false,
        "should_drop_params": false,
        "should_convert_params": false,
        "azure_deepseek": false
      }
    }

If a candidate cannot take response_format or tools, that is a finding about the candidate, not something for the route to smooth over.

## The reference can be contaminated too

An evaluation that grades candidates against the outputs your team already accepted, the approach called [reference evidence](https://www.rightmodeler.com/glossary#reference-evidence), has a second exposure: those outputs came through the same gateway. If production traffic fell back, some references were written by the fallback model and recorded under the name your application asked for.

Agent Router shows the difference. [Its tracing](https://theagentrouter.ai/docs/capabilities/observability/tracing) records the full request and response on each span by default, which makes the spans usable as references. On the evaluation route a priority-fallback answer is caught, because the response names another model. In exported traces it is not: the span recorded for the same captured fallback call, line 9 of [envoy-openinference.jsonl](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/fixtures/traces/envoy-openinference.jsonl#L9), carries a request body naming fallback-demo, an llm.model_name of amazon/nova-micro, and no attribute that says a fallback chose it. A modelNameOverride alias produces the same pair of names, so the span cannot tell the two apart. A reader that takes the requested model from the request body, as rightmodeler's does, records that output as fallback-demo's, as [its hermetic test](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/packages/rightmodeler/src/data/adapters/openinference.test.ts#L72-L113) asserts. The span does carry both names, which is enough to flag it: a span whose llm.model_name names another model than its request body was not answered by the model your application named, whether a fallback or an alias chose it. Line 9 is the only such span in the file. Keep fallback routes off the traffic you export as references.

Bifrost's log store keeps the difference visible: a fallback attempt is its own row with a fallback_index above 0, so [rightmodeler's Bifrost reader](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/packages/rightmodeler/src/data/adapters/bifrost.ts#L54-L62) leaves it out as fallback_answer and the failed primary as call_failed. The hermetic [bifrost.test.ts](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/packages/rightmodeler/src/data/adapters/bifrost.test.ts#L68-L83) checks this on a log export captured from v2.2.1 on 2026-09-24, and the Bifrost live provider test on a fresh one. Export without roots_only=true, which [Bifrost's API reference](https://docs.getbifrost.ai/api-reference/logging/get-logs) describes as collapsing fallback rows into their root.

## A checklist for an evaluation route

- One backend per evaluated model, named by the upstream's own id.
- No fallbacks, priority backends, or retries that move to another backend.
- No aliases, overrides, routing rules or configs on the evaluation's model names or key.
- Caching off, and a no-store header on every evaluation call where the gateway has one.
- No guardrail mutators; compatibility flags set to false explicitly.
- For every response, its named model, cache marker and rewrite markers recorded, and every response that fails a check left out and counted.
- No verdict for a model with more than a small share of its responses left out, until the route is fixed and the evaluation rerun.
- References exported only from routes without fallbacks, or from a log store that marks fallback rows.
- Evaluation traffic tagged, and left out of the next export.

## How rightmodeler applies these checks

rightmodeler is an MIT-licensed CLI on npm (npx rightmodeler init) that reads the traces you already export, replays recorded steps through cheaper candidates from your provider's live catalog, and judges them against the outputs your team already accepted, reporting reference agreement, sample size and abstentions against a held-out quality floor. It is never in the request path: its output is a draft pull request that changes only model identifiers, for a human to review and merge. It replays through any OpenAI-compatible base URL, including each gateway above.

Every replayed and judge response goes through [the check in provenance.ts](https://github.com/elm-os/rightmodeler/blob/27e877e1bed77a6fcf6e8ae8a879ba995dfb0355/harness/packages/replay/src/provenance.ts#L67-L132) before it counts. A response that names another model, reports a cache hit or reports a changed request is recorded as substituted, never graded, and counted as attribution_substituted. If more than 5% of a family's replays are left out of the evidence, the family [abstains](https://www.rightmodeler.com/glossary#abstain) instead of deciding. A replay_responses_substituted warning names the requested and served models and the fix, and a judge that answers as another model is retired while the next-ranked judge takes over. The replay-safe setup for each gateway is on the [Portkey](https://www.rightmodeler.com/integrations/portkey), [Bifrost](https://www.rightmodeler.com/integrations/bifrost) and [Agent Router](https://www.rightmodeler.com/integrations/envoy-ai-gateway) integration pages, and the method is on [how it works](https://www.rightmodeler.com/how-it-works).

## Reproduce it

The hermetic checks need no network and no keys. From a clone of the repository:

    pnpm install --frozen-lockfile
    pnpm --filter @rightmodeler/replay exec vitest run src/provenance.test.ts

The live provider tests need Docker and an AI_GATEWAY_API_KEY for Vercel AI Gateway, and each leg runs under a spend cap of $0.25 or less. The fixtures README maps each pitfall to its fixture, tests and evidence label, with the exact commands: [Reproducing the gateway evaluation pitfalls](https://github.com/elm-os/rightmodeler/blob/main/harness/fixtures/gateways/README.md#reproducing-the-gateway-evaluation-pitfalls).
`;
