// Post: "LLM cost optimization tools: which approach fits your workload?" A practitioner guide that
// sorts six cost levers (model substitution, routing, caching, compression, batching, fine-tuning)
// by the problem each one solves, with prerequisites, rollout evidence, tradeoffs, and how they
// stack. A typed post module: `meta` (data) plus a `Body` composed from the prose primitives.
// Every vendor mechanic is attributed to the vendor's own documentation as of 2026-09-24; every
// rightmodeler claim matches harness/packages/rightmodeler/docs and the integration pages. No
// vendor ranking. Tables are written as lists because the blog parity check reads only literal
// JSX text.

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
  slug: "llm-cost-optimization-tools",
  title: "LLM cost optimization tools: which approach fits your workload?",
  description:
    "Substitution, routing, caching, compression, batching and fine-tuning each fix a different LLM cost problem. How to match one to your workload and prove it.",
  excerpt:
    "Six ways to cut an LLM bill, sorted by the problem each solves: what it needs, the evidence to demand, and how they stack.",
  kicker: "Guide · LLM costs",
  date: "2026-09-24",
  readingMinutes: 12,
  hero: {
    src: "/blog/llm-cost-optimization-tools-hero.jpg",
    alt: "A warm parchment field of distinct watercolor marks, a dot, a dash, a ring, a long stroke and a small cluster of dots, with the long stroke washed from violet into orange.",
  },
};

export function Body() {
  return (
    <Prose>
      <Lead>
        Search for LLM cost optimization tools and you get a list: gateways,
        routers, caches, compressors, fine-tuning platforms. The list hides the
        useful part. Each category fixes a different problem, and a tool pointed
        at a problem you do not have costs engineering time and saves nothing,
        or saves money by quietly lowering quality.
      </Lead>

      <P>
        This guide sorts six approaches by the problem each one solves. For
        each: what you need before you start, the evidence to have before it
        reaches production, and what it trades away. Then how they stack,
        because the order matters.
      </P>

      <P>
        A disclosure first: we build rightmodeler, a tool for the first of these
        approaches, and we say where it fits. Vendor details come from each
        vendor&rsquo;s own documentation, as of{" "}
        <span className="whitespace-nowrap">2026-09-24</span>.
      </P>

      <H2>Start with where the money goes</H2>

      <P>
        Each approach attacks a different slice of the bill, so slice it first:
        by step, meaning each place your code calls a model, and by token type.
        The traces you already record usually hold everything you need. Five
        questions sort most workloads:
      </P>

      <UL>
        <LI>
          Which steps run your most expensive model, and what does each of those
          steps actually do?
        </LI>
        <LI>
          Does one step receive a wide mix of easy and hard requests, or roughly
          the same kind every time?
        </LI>
        <LI>
          How much of each request repeats: a long system prompt, tool
          definitions, reference documents, the conversation so far? How many
          requests are exact duplicates?
        </LI>
        <LI>
          How much of the input does the step need? Tool output, logs and
          retrieved documents are often the bulk of it.
        </LI>
        <LI>
          Which jobs need an answer now, and which could wait an hour or a day?
        </LI>
      </UL>

      <P>
        In agent workloads the answers skew toward input, because the whole
        context is re-read on every turn. A study we wrote up in{" "}
        <A href="/blog/nobody-can-predict-the-bill">
          nobody can predict the bill
        </A>{" "}
        measured agentic coding at about 154 input tokens for every output
        token.
      </P>

      <H2>Frontier prices for easy steps: model substitution</H2>

      <P>
        A pipeline starts on one strong model, because that was the fastest way
        to make it work, and every step inherits it. Months later, the step that
        extracts a date and the step that plans a multi-tool task run the same
        frontier model at the same price.
      </P>

      <P>
        Substitution fixes this statically: measure whether a cheaper model does
        each step&rsquo;s job, and change the model identifier where it does.
        Nothing new enters the request path, and the saving lands on every call
        to that step.
      </P>

      <P>
        Prerequisites: step-level traces with each call&rsquo;s inputs and the
        outputs your team accepted, current prices for candidate models, and a
        way to judge whether a candidate agrees with the accepted output. Public
        benchmarks such as{" "}
        <A href="/vs/artificial-analysis">Artificial Analysis</A> and{" "}
        <A href="/vs/vals-ai">Vals AI</A> help you shortlist candidates; they
        cannot tell you how a model does on your step, with your prompts.
      </P>

      <H3>Evidence before rollout</H3>

      <UL>
        <LI>
          Agreement per step, not per pipeline. An average hides the one step
          that regressed.
        </LI>
        <LI>
          The case count beside every rate. A rate from a dozen cases is a hint,
          not evidence.
        </LI>
        <LI>
          A held-out check. Pick the best of many candidates on the same cases
          and part of its score is luck, so confirm the winner on cases it was
          not chosen on.
        </LI>
        <LI>
          A rule to <A href="/glossary#abstain">abstain</A>. When the evidence
          is thin, keep the current model.
        </LI>
        <LI>
          An independent judge from a different model family than either model
          being compared, or deterministic checks where the output has a fixed
          shape.
        </LI>
      </UL>

      <P>
        What it trades away: one model per step, chosen in advance, so it cannot
        adapt to a hard request inside an easy step. The accepted output is a{" "}
        <A href="/glossary#reference-evidence">reference, not ground truth</A>,
        so agreement means the candidate matches what you shipped. And models
        and prices keep changing, so the measurement has to be repeatable.
      </P>

      <P>
        This is the approach rightmodeler automates. It is an MIT-licensed CLI
        (npx rightmodeler init) that reads{" "}
        <A href="/integrations">the traces you already export</A> from tools
        such as Langfuse, Helicone or OpenTelemetry, resends recorded
        conversations to cheaper candidates from your provider&rsquo;s live
        model catalog, and has a judge from outside both model families grade
        each output against the one you accepted. The report gives each step
        family&rsquo;s pass count out of its trials, a worst-case bound, and an
        abstention reason wherever the evidence is too thin to recommend. A
        candidate chosen on one part of your traces must also clear your quality
        floor on a held-out part. Approved swaps arrive as a draft pull request
        that changes model identifiers only; a person reviews and merges it, and
        nothing runs in your request path.
      </P>

      <P>
        For what that evidence looks like on a real system, the{" "}
        <A href="/case-study/bside">B:Side Assist case study</A> follows 11 AI
        workloads from a single model and reasoning setting to a per-workload
        policy: a projected 70.8% lower inference cost, with the quality pass
        rate measured at 100% on a 20-query benchmark against the outputs B:Side
        had accepted. The{" "}
        <A href="/use-cases/reduce-llm-costs">reduce LLM costs</A> page covers
        the workflow end to end.
      </P>

      <H2>One step, easy and hard requests: routing</H2>

      <P>
        Sometimes the variation is inside a step. A support assistant&rsquo;s
        single entry point gets both password resets and multi-account billing
        disputes. Pin it to a cheap model and the hard cases fail; pin it to a
        strong one and the easy ones overpay.
      </P>

      <P>
        A router makes the choice per request, at runtime.{" "}
        <A href="https://docs.notdiamond.ai/docs/what-is-model-routing">
          Not Diamond
        </A>{" "}
        describes its router as analyzing each input and predicting which
        candidate model gives the best response at the lowest cost. Besides
        pre-trained routers, it offers{" "}
        <A href="https://docs.notdiamond.ai/docs/router-training-quickstart">
          custom routers
        </A>{" "}
        trained on your own evaluation data: representative inputs, each
        candidate&rsquo;s responses to them, and a score for every response.
      </P>

      <P>
        That requirement is the one to plan for. A router is only as good as the
        evaluation scores it learns from, so routing needs the same
        per-candidate evidence as substitution, plus a runtime component. Before
        rollout, evaluate it on held-out traffic: quality per type of request,
        each model&rsquo;s share of traffic, the cost, and what happens when the
        router or a candidate model is unavailable.
      </P>

      <P>
        What it trades away: a live dependency in the request path, and harder
        debugging when one step is answered by different models on different
        days. Where a step&rsquo;s traffic is roughly uniform, substitution gets
        most of the saving with neither. Our comparisons with{" "}
        <A href="/vs/not-diamond">Not Diamond</A> and{" "}
        <A href="/vs/martian">Martian</A> go further. Martian today{" "}
        <A href="https://docs.withmartian.com">describes itself</A> as an AI
        research lab whose Gateway offers one API to more than 200 models, with
        the model named on each request.
      </P>

      <H2>The same prompt, again and again: caching</H2>

      <P>
        Caching is two different mechanisms that share a name, and they carry
        different risks.
      </P>

      <H3>Provider prompt caching: repeated prefixes</H3>

      <P>
        Most agent requests start with the same long prefix: system prompt, tool
        definitions, reference material, the conversation so far. Prompt caching
        lets the provider reuse its work on that prefix at a discount; the model
        still generates a fresh answer.
      </P>

      <P>
        At{" "}
        <A href="https://developers.openai.com/api/docs/guides/prompt-caching">
          OpenAI
        </A>
        , prompt caching is on by default for supported models, and reused
        tokens are billed at a cached-input rate discounted by up to 90%. For{" "}
        <span className="whitespace-nowrap">GPT-5.6</span> and later, the
        minimum cacheable prefix is 1,024 tokens, a cache write costs 1.25 times
        the uncached input rate, and a read costs 0.1 times it. At{" "}
        <A href="https://platform.claude.com/docs/en/build-with-claude/prompt-caching">
          Anthropic
        </A>
        , a cache_control field turns caching on, once at the top level or on
        individual blocks, with a five-minute default lifetime and a one-hour
        option. Five-minute writes cost 1.25 times the base input price and
        reads 0.1 times it on most models. Both providers state that prompt
        caching does not change output generation.
      </P>

      <P>
        Prerequisites: stable content first and changing content last. Both
        providers match on the exact prefix, so a timestamp near the top of a
        system prompt can defeat the whole cache. Anthropic also sets a minimum
        cacheable length per model, from 512 tokens on models such as Claude
        Opus 5.5 to 4,096 on Claude Haiku 4.5, and a shorter prompt is processed
        without caching.
      </P>

      <P>
        Evidence before rollout is about cost only, because the output does not
        change: read the cache fields each provider returns with usage
        (cached_tokens at OpenAI, cache_read_input_tokens and
        cache_creation_input_tokens at Anthropic) and confirm the cached share
        of input rose. What it trades away is little beyond prompt
        restructuring, plus a write premium on prefixes that never get reused.
      </P>

      <H3>Gateway response caching: identical requests</H3>

      <P>
        A response cache sits in a gateway and returns a stored answer without
        calling the model at all.{" "}
        <A href="https://openrouter.ai/docs/guides/features/response-caching">
          OpenRouter
        </A>{" "}
        treats two requests as identical when the API key, model, endpoint type,
        streaming mode and request body all match; cache hits are not billed,
        and the default lifetime is five minutes, configurable up to 24 hours.{" "}
        <A href="https://docs.helicone.ai/features/advanced-usage/caching">
          Helicone
        </A>{" "}
        hashes the request URL, body and relevant headers, with a default
        lifetime of seven days.{" "}
        <A href="https://docs.litellm.ai/docs/proxy/caching">LiteLLM</A> offers
        exact-match caches keyed on the whole request, and semantic caches that
        serve the closest earlier match above a similarity threshold.{" "}
        <A href="https://portkey.ai/docs/product/ai-gateway/cache-simple-and-semantic">
          Portkey
        </A>{" "}
        offers both too; its semantic cache ignores the system prompt when
        matching and is available on select Enterprise plans.
      </P>

      <P>
        The problem this solves is narrow: truly repeated requests, such as a
        public FAQ assistant, a classifier fed the same inputs, or a test suite
        run during development. Agent traffic rarely qualifies, because the
        context grows on every turn. LiteLLM&rsquo;s own documentation warns
        that semantic caches suit single-shot prompts and go badly wrong on
        agentic traffic.
      </P>

      <P>
        Evidence before rollout: the share of exact duplicates in your traces
        within the cache lifetime, which caps what an exact-match cache can
        save. For a semantic cache, sample its hits and check that each served
        answer fits the new request; a wrong near match is a quality failure no
        cost report shows. What it trades away: freshness, and for semantic
        caching, correctness at the margin. Our comparisons with{" "}
        <A href="/vs/helicone">Helicone</A>, <A href="/vs/portkey">Portkey</A>,{" "}
        <A href="/vs/litellm">LiteLLM</A> and{" "}
        <A href="/vs/openrouter">OpenRouter</A> cover what else each gateway
        does.
      </P>

      <H2>Inputs far larger than the step needs: compression</H2>

      <P>
        In agent workloads, much of the input is tool output: logs, test
        results, search hits, documents read in full to find one line. The model
        pays to read it on the turn it arrives and on every turn after.
      </P>

      <P>
        Compression cuts that input before the model sees it. On the provider
        side, Anthropic&rsquo;s{" "}
        <A href="https://platform.claude.com/docs/en/build-with-claude/context-editing">
          context editing
        </A>{" "}
        clears old tool results once context passes a threshold you set, and
        OpenAI and Anthropic both offer compaction, which replaces earlier
        conversation with a shorter representation.{" "}
        <A href="https://codag.ai">Codag</A> works on the tool output itself: by
        its own description, it reduces large results such as logs, test and
        build output and search results to the evidence the agent needs, and
        passes source code, diffs and configuration through unchanged.{" "}
        <A href="https://www.mentlio.com">Mentlio</A> works at the team level:
        by its own description, it measures locally what a team&rsquo;s AI use
        costs and produces, and cuts token waste while keeping prompts and
        source code on the device.
      </P>

      <P>
        Prerequisites: know what share of each step&rsquo;s input is tool output
        or old history. Evidence before rollout: task success on the compressed
        inputs, not token counts, because a model cannot use what was removed.
        Then measure cost net of caching, since compaction and clearing change
        the prefix and both providers note this can reduce prompt-cache reuse.
        OpenAI&rsquo;s guidance is to compare total input cost before and after,
        because fewer input tokens can still save money when the cache-hit rate
        falls; Anthropic&rsquo;s tool-result clearing takes a clear_at_least
        setting so each clearing removes enough tokens to be worth the broken
        cache.
      </P>

      <P>
        What it trades away: information, on every turn after the cut. Our
        comparisons with <A href="/vs/codag">Codag</A> and{" "}
        <A href="/vs/mentlio">Mentlio</A> go into where each one sits.
      </P>

      <H2>Work that can wait: batching</H2>

      <P>
        Evaluations, backfills and nightly classification do not need an answer
        in two seconds, and both major providers sell the same models at half
        price for work that can wait.
      </P>

      <P>
        <A href="https://developers.openai.com/api/docs/guides/batch">
          OpenAI&rsquo;s Batch API
        </A>{" "}
        charges 50% less than the synchronous APIs, runs against a separate and
        larger rate-limit pool, and completes each batch within 24 hours, often
        sooner.{" "}
        <A href="https://platform.claude.com/docs/en/build-with-claude/batch-processing">
          Anthropic&rsquo;s Message Batches API
        </A>{" "}
        charges 50% of standard prices, finishes most batches in under an hour,
        and expires requests not processed within 24 hours. Its prompt-caching
        multipliers stack with the batch discount, although cache hits inside a
        batch are best-effort.
      </P>

      <P>
        Prerequisites: an asynchronous pipeline, a unique ID on every request,
        and handling for requests that expire. Evidence before rollout is
        operational, since the model and prompt are unchanged: completion times
        inside your deadline, and a working path for expired requests. What it
        trades away: latency, so it only fits jobs where nobody is waiting.
      </P>

      <H2>
        A narrow task a small model could learn: fine-tuning and distillation
      </H2>

      <P>
        Some steps are narrow, high-volume and stable, such as routing a ticket
        to one of forty queues. The current solution is often a large model with
        a long prompt full of examples. Training a smaller model on the task,
        including on a larger model&rsquo;s outputs, which is what distillation
        means, can shrink both the model and the prompt.
      </P>

      <P>
        OpenAI&rsquo;s{" "}
        <A href="https://developers.openai.com/api/docs/guides/model-optimization">
          model optimization guide
        </A>{" "}
        lists those benefits: shorter prompts with fewer examples, and a
        smaller, cheaper, faster model trained for a task where a larger model
        is not cost-effective. As of{" "}
        <span className="whitespace-nowrap">2026-09-24</span>, OpenAI is also
        winding down its self-serve fine-tuning platform. Its{" "}
        <A href="https://developers.openai.com/api/docs/deprecations">
          deprecations page
        </A>{" "}
        says organizations that had not fine-tuned before can no longer start,
        active existing customers lose the ability to create new jobs on January
        6, 2027, and inference on fine-tuned models continues until the base
        model is deprecated. The other routes are training an open-weight model
        yourself or working with a vendor: Agnost AI, per its{" "}
        <A href="https://www.ycombinator.com/companies/agnost-ai">
          Y Combinator profile
        </A>
        , turns an agent&rsquo;s production conversations into custom models,
        and <A href="https://thirdbrainlabs.ai">ThirdBrain Labs</A> helps domain
        experts train models they own.
      </P>

      <P>
        Prerequisites: a clean dataset of inputs and accepted outputs, an
        evaluation set held back from training, somewhere to serve the model,
        and a plan for retraining when the task drifts. Evidence before rollout:
        the trained model against the current one on held-out inputs from real
        traffic, and a lifecycle cost that includes training, hosting and
        retraining. What it trades away: the most upfront effort of any approach
        here, and a model you now maintain. Our comparisons with{" "}
        <A href="/vs/agnost-ai">Agnost AI</A> and{" "}
        <A href="/vs/thirdbrain-labs">ThirdBrain Labs</A> go deeper.
      </P>

      <H2>How the approaches stack</H2>

      <P>The approaches combine, and the order changes what each is worth.</P>

      <UL>
        <LI>
          <Strong>Take the quality-neutral wins first.</Strong> Prompt caching
          leaves the output unchanged, and batching runs the same model on the
          same prompt. Neither needs a quality evaluation, only proof the cost
          moved.
        </LI>
        <LI>
          <Strong>Compress, then re-measure the model choice.</Strong> A model
          choice measured on uncompressed traces describes a workload that no
          longer exists, so run substitution on traces recorded after the
          change. A step that needed a frontier model to find one failing test
          in a long log may not need it once the log is reduced to that test.
        </LI>
        <LI>
          <Strong>Substitute per step, route where difficulty varies.</Strong>{" "}
          Substitution covers steps with uniform traffic; a router earns its
          place only where traffic is mixed.
        </LI>
        <LI>
          <Strong>
            Price candidates at your cache mix, not at list price.
          </Strong>{" "}
          A model switch starts from a cold cache: OpenAI lists the model among
          the settings that affect the cached prefix. Cacheable minimums differ
          too. At Anthropic, a 2,000-token prefix that caches on Claude Sonnet
          5, with its 1,024-token minimum, falls below Claude Haiku 4.5&rsquo;s
          4,096-token minimum and is processed uncached. On that prefix, Sonnet
          5&rsquo;s cache reads at $0.20 per million tokens cost less than Haiku
          4.5&rsquo;s uncached input at $1. Compare each model&rsquo;s cost at
          your real cached share before acting on any per-token saving.
        </LI>
        <LI>
          <Strong>Keep response caching out of evaluation.</Strong> A cached
          response is evidence about the cache, not the model. rightmodeler
          leaves out of its evidence any replayed response that a gateway
          reports as a cache hit, such as a{" "}
          <A href="/integrations/portkey">Portkey</A> cache-status header or a{" "}
          <A href="/integrations/bifrost">Bifrost</A> cache flag, and its
          gateway setup keeps response caching off on the replay route.
          Fallbacks, aliases and rewritten requests contaminate an evaluation
          the same way;{" "}
          <A href="/blog/llm-gateway-evaluation-pitfalls">
            how an AI gateway can invalidate your model evaluation
          </A>{" "}
          covers all four.
        </LI>
        <LI>
          <Strong>Fine-tune last.</Strong> Training is the most expensive
          experiment, so run it after substitution has shown that no existing
          model clears the bar at an acceptable price.
        </LI>
      </UL>

      <H2>The short version</H2>

      <P>Match the approach to the problem you can see in your traces:</P>

      <UL>
        <LI>
          <Strong>Frontier prices on routine steps:</Strong> model substitution,
          proven per step on held-out cases.
        </LI>
        <LI>
          <Strong>One step with easy and hard requests:</Strong> routing, proven
          on held-out traffic.
        </LI>
        <LI>
          <Strong>Long repeated prefixes:</Strong> prompt caching, proven by the
          cached share of input.
        </LI>
        <LI>
          <Strong>Exact repeated requests:</Strong> response caching, proven by
          the duplicate rate.
        </LI>
        <LI>
          <Strong>Oversized inputs:</Strong> compression, proven by task success
          and cost net of cache effects.
        </LI>
        <LI>
          <Strong>Latency-tolerant bulk work:</Strong> batch APIs, proven by
          completion times.
        </LI>
        <LI>
          <Strong>A narrow, high-volume task:</Strong> fine-tuning or
          distillation, proven on held-out inputs at full lifecycle cost.
        </LI>
      </UL>

      <P>
        If the first line describes your bill, start with the traces you already
        have. <A href="/how-it-works">How it works</A> explains the
        replay-and-judge loop, and the{" "}
        <A href="/case-study/bside">B:Side Assist case study</A> shows the
        evidence from one audit, workload by workload.
      </P>
    </Prose>
  );
}

// The same post as clean Markdown, for llms-context.txt and any LLM-facing surface. Kept in sync with
// Body above by hand.
export const markdown = `# LLM cost optimization tools: which approach fits your workload?

Search for LLM cost optimization tools and you get a list: gateways, routers, caches, compressors, fine-tuning platforms. The list hides the useful part. Each category fixes a different problem, and a tool pointed at a problem you do not have costs engineering time and saves nothing, or saves money by quietly lowering quality.

This guide sorts six approaches by the problem each one solves. For each: what you need before you start, the evidence to have before it reaches production, and what it trades away. Then how they stack, because the order matters.

A disclosure first: we build rightmodeler, a tool for the first of these approaches, and we say where it fits. Vendor details come from each vendor's own documentation, as of 2026-09-24.

## Start with where the money goes

Each approach attacks a different slice of the bill, so slice it first: by step, meaning each place your code calls a model, and by token type. The traces you already record usually hold everything you need. Five questions sort most workloads:

- Which steps run your most expensive model, and what does each of those steps actually do?
- Does one step receive a wide mix of easy and hard requests, or roughly the same kind every time?
- How much of each request repeats: a long system prompt, tool definitions, reference documents, the conversation so far? How many requests are exact duplicates?
- How much of the input does the step need? Tool output, logs and retrieved documents are often the bulk of it.
- Which jobs need an answer now, and which could wait an hour or a day?

In agent workloads the answers skew toward input, because the whole context is re-read on every turn. A study we wrote up in [nobody can predict the bill](https://www.rightmodeler.com/blog/nobody-can-predict-the-bill) measured agentic coding at about 154 input tokens for every output token.

## Frontier prices for easy steps: model substitution

A pipeline starts on one strong model, because that was the fastest way to make it work, and every step inherits it. Months later, the step that extracts a date and the step that plans a multi-tool task run the same frontier model at the same price.

Substitution fixes this statically: measure whether a cheaper model does each step's job, and change the model identifier where it does. Nothing new enters the request path, and the saving lands on every call to that step.

Prerequisites: step-level traces with each call's inputs and the outputs your team accepted, current prices for candidate models, and a way to judge whether a candidate agrees with the accepted output. Public benchmarks such as [Artificial Analysis](https://www.rightmodeler.com/vs/artificial-analysis) and [Vals AI](https://www.rightmodeler.com/vs/vals-ai) help you shortlist candidates; they cannot tell you how a model does on your step, with your prompts.

### Evidence before rollout

- Agreement per step, not per pipeline. An average hides the one step that regressed.
- The case count beside every rate. A rate from a dozen cases is a hint, not evidence.
- A held-out check. Pick the best of many candidates on the same cases and part of its score is luck, so confirm the winner on cases it was not chosen on.
- A rule to [abstain](https://www.rightmodeler.com/glossary#abstain). When the evidence is thin, keep the current model.
- An independent judge from a different model family than either model being compared, or deterministic checks where the output has a fixed shape.

What it trades away: one model per step, chosen in advance, so it cannot adapt to a hard request inside an easy step. The accepted output is a [reference, not ground truth](https://www.rightmodeler.com/glossary#reference-evidence), so agreement means the candidate matches what you shipped. And models and prices keep changing, so the measurement has to be repeatable.

This is the approach rightmodeler automates. It is an MIT-licensed CLI (npx rightmodeler init) that reads [the traces you already export](https://www.rightmodeler.com/integrations) from tools such as Langfuse, Helicone or OpenTelemetry, resends recorded conversations to cheaper candidates from your provider's live model catalog, and has a judge from outside both model families grade each output against the one you accepted. The report gives each step family's pass count out of its trials, a worst-case bound, and an abstention reason wherever the evidence is too thin to recommend. A candidate chosen on one part of your traces must also clear your quality floor on a held-out part. Approved swaps arrive as a draft pull request that changes model identifiers only; a person reviews and merges it, and nothing runs in your request path.

For what that evidence looks like on a real system, the [B:Side Assist case study](https://www.rightmodeler.com/case-study/bside) follows 11 AI workloads from a single model and reasoning setting to a per-workload policy: a projected 70.8% lower inference cost, with the quality pass rate measured at 100% on a 20-query benchmark against the outputs B:Side had accepted. The [reduce LLM costs](https://www.rightmodeler.com/use-cases/reduce-llm-costs) page covers the workflow end to end.

## One step, easy and hard requests: routing

Sometimes the variation is inside a step. A support assistant's single entry point gets both password resets and multi-account billing disputes. Pin it to a cheap model and the hard cases fail; pin it to a strong one and the easy ones overpay.

A router makes the choice per request, at runtime. [Not Diamond](https://docs.notdiamond.ai/docs/what-is-model-routing) describes its router as analyzing each input and predicting which candidate model gives the best response at the lowest cost. Besides pre-trained routers, it offers [custom routers](https://docs.notdiamond.ai/docs/router-training-quickstart) trained on your own evaluation data: representative inputs, each candidate's responses to them, and a score for every response.

That requirement is the one to plan for. A router is only as good as the evaluation scores it learns from, so routing needs the same per-candidate evidence as substitution, plus a runtime component. Before rollout, evaluate it on held-out traffic: quality per type of request, each model's share of traffic, the cost, and what happens when the router or a candidate model is unavailable.

What it trades away: a live dependency in the request path, and harder debugging when one step is answered by different models on different days. Where a step's traffic is roughly uniform, substitution gets most of the saving with neither. Our comparisons with [Not Diamond](https://www.rightmodeler.com/vs/not-diamond) and [Martian](https://www.rightmodeler.com/vs/martian) go further. Martian today [describes itself](https://docs.withmartian.com) as an AI research lab whose Gateway offers one API to more than 200 models, with the model named on each request.

## The same prompt, again and again: caching

Caching is two different mechanisms that share a name, and they carry different risks.

### Provider prompt caching: repeated prefixes

Most agent requests start with the same long prefix: system prompt, tool definitions, reference material, the conversation so far. Prompt caching lets the provider reuse its work on that prefix at a discount; the model still generates a fresh answer.

At [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching), prompt caching is on by default for supported models, and reused tokens are billed at a cached-input rate discounted by up to 90%. For GPT-5.6 and later, the minimum cacheable prefix is 1,024 tokens, a cache write costs 1.25 times the uncached input rate, and a read costs 0.1 times it. At [Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), a cache_control field turns caching on, once at the top level or on individual blocks, with a five-minute default lifetime and a one-hour option. Five-minute writes cost 1.25 times the base input price and reads 0.1 times it on most models. Both providers state that prompt caching does not change output generation.

Prerequisites: stable content first and changing content last. Both providers match on the exact prefix, so a timestamp near the top of a system prompt can defeat the whole cache. Anthropic also sets a minimum cacheable length per model, from 512 tokens on models such as Claude Opus 5.5 to 4,096 on Claude Haiku 4.5, and a shorter prompt is processed without caching.

Evidence before rollout is about cost only, because the output does not change: read the cache fields each provider returns with usage (cached_tokens at OpenAI, cache_read_input_tokens and cache_creation_input_tokens at Anthropic) and confirm the cached share of input rose. What it trades away is little beyond prompt restructuring, plus a write premium on prefixes that never get reused.

### Gateway response caching: identical requests

A response cache sits in a gateway and returns a stored answer without calling the model at all. [OpenRouter](https://openrouter.ai/docs/guides/features/response-caching) treats two requests as identical when the API key, model, endpoint type, streaming mode and request body all match; cache hits are not billed, and the default lifetime is five minutes, configurable up to 24 hours. [Helicone](https://docs.helicone.ai/features/advanced-usage/caching) hashes the request URL, body and relevant headers, with a default lifetime of seven days. [LiteLLM](https://docs.litellm.ai/docs/proxy/caching) offers exact-match caches keyed on the whole request, and semantic caches that serve the closest earlier match above a similarity threshold. [Portkey](https://portkey.ai/docs/product/ai-gateway/cache-simple-and-semantic) offers both too; its semantic cache ignores the system prompt when matching and is available on select Enterprise plans.

The problem this solves is narrow: truly repeated requests, such as a public FAQ assistant, a classifier fed the same inputs, or a test suite run during development. Agent traffic rarely qualifies, because the context grows on every turn. LiteLLM's own documentation warns that semantic caches suit single-shot prompts and go badly wrong on agentic traffic.

Evidence before rollout: the share of exact duplicates in your traces within the cache lifetime, which caps what an exact-match cache can save. For a semantic cache, sample its hits and check that each served answer fits the new request; a wrong near match is a quality failure no cost report shows. What it trades away: freshness, and for semantic caching, correctness at the margin. Our comparisons with [Helicone](https://www.rightmodeler.com/vs/helicone), [Portkey](https://www.rightmodeler.com/vs/portkey), [LiteLLM](https://www.rightmodeler.com/vs/litellm) and [OpenRouter](https://www.rightmodeler.com/vs/openrouter) cover what else each gateway does.

## Inputs far larger than the step needs: compression

In agent workloads, much of the input is tool output: logs, test results, search hits, documents read in full to find one line. The model pays to read it on the turn it arrives and on every turn after.

Compression cuts that input before the model sees it. On the provider side, Anthropic's [context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) clears old tool results once context passes a threshold you set, and OpenAI and Anthropic both offer compaction, which replaces earlier conversation with a shorter representation. [Codag](https://codag.ai) works on the tool output itself: by its own description, it reduces large results such as logs, test and build output and search results to the evidence the agent needs, and passes source code, diffs and configuration through unchanged. [Mentlio](https://www.mentlio.com) works at the team level: by its own description, it measures locally what a team's AI use costs and produces, and cuts token waste while keeping prompts and source code on the device.

Prerequisites: know what share of each step's input is tool output or old history. Evidence before rollout: task success on the compressed inputs, not token counts, because a model cannot use what was removed. Then measure cost net of caching, since compaction and clearing change the prefix and both providers note this can reduce prompt-cache reuse. OpenAI's guidance is to compare total input cost before and after, because fewer input tokens can still save money when the cache-hit rate falls; Anthropic's tool-result clearing takes a clear_at_least setting so each clearing removes enough tokens to be worth the broken cache.

What it trades away: information, on every turn after the cut. Our comparisons with [Codag](https://www.rightmodeler.com/vs/codag) and [Mentlio](https://www.rightmodeler.com/vs/mentlio) go into where each one sits.

## Work that can wait: batching

Evaluations, backfills and nightly classification do not need an answer in two seconds, and both major providers sell the same models at half price for work that can wait.

[OpenAI's Batch API](https://developers.openai.com/api/docs/guides/batch) charges 50% less than the synchronous APIs, runs against a separate and larger rate-limit pool, and completes each batch within 24 hours, often sooner. [Anthropic's Message Batches API](https://platform.claude.com/docs/en/build-with-claude/batch-processing) charges 50% of standard prices, finishes most batches in under an hour, and expires requests not processed within 24 hours. Its prompt-caching multipliers stack with the batch discount, although cache hits inside a batch are best-effort.

Prerequisites: an asynchronous pipeline, a unique ID on every request, and handling for requests that expire. Evidence before rollout is operational, since the model and prompt are unchanged: completion times inside your deadline, and a working path for expired requests. What it trades away: latency, so it only fits jobs where nobody is waiting.

## A narrow task a small model could learn: fine-tuning and distillation

Some steps are narrow, high-volume and stable, such as routing a ticket to one of forty queues. The current solution is often a large model with a long prompt full of examples. Training a smaller model on the task, including on a larger model's outputs, which is what distillation means, can shrink both the model and the prompt.

OpenAI's [model optimization guide](https://developers.openai.com/api/docs/guides/model-optimization) lists those benefits: shorter prompts with fewer examples, and a smaller, cheaper, faster model trained for a task where a larger model is not cost-effective. As of 2026-09-24, OpenAI is also winding down its self-serve fine-tuning platform. Its [deprecations page](https://developers.openai.com/api/docs/deprecations) says organizations that had not fine-tuned before can no longer start, active existing customers lose the ability to create new jobs on January 6, 2027, and inference on fine-tuned models continues until the base model is deprecated. The other routes are training an open-weight model yourself or working with a vendor: Agnost AI, per its [Y Combinator profile](https://www.ycombinator.com/companies/agnost-ai), turns an agent's production conversations into custom models, and [ThirdBrain Labs](https://thirdbrainlabs.ai) helps domain experts train models they own.

Prerequisites: a clean dataset of inputs and accepted outputs, an evaluation set held back from training, somewhere to serve the model, and a plan for retraining when the task drifts. Evidence before rollout: the trained model against the current one on held-out inputs from real traffic, and a lifecycle cost that includes training, hosting and retraining. What it trades away: the most upfront effort of any approach here, and a model you now maintain. Our comparisons with [Agnost AI](https://www.rightmodeler.com/vs/agnost-ai) and [ThirdBrain Labs](https://www.rightmodeler.com/vs/thirdbrain-labs) go deeper.

## How the approaches stack

The approaches combine, and the order changes what each is worth.

- **Take the quality-neutral wins first.** Prompt caching leaves the output unchanged, and batching runs the same model on the same prompt. Neither needs a quality evaluation, only proof the cost moved.
- **Compress, then re-measure the model choice.** A model choice measured on uncompressed traces describes a workload that no longer exists, so run substitution on traces recorded after the change. A step that needed a frontier model to find one failing test in a long log may not need it once the log is reduced to that test.
- **Substitute per step, route where difficulty varies.** Substitution covers steps with uniform traffic; a router earns its place only where traffic is mixed.
- **Price candidates at your cache mix, not at list price.** A model switch starts from a cold cache: OpenAI lists the model among the settings that affect the cached prefix. Cacheable minimums differ too. At Anthropic, a 2,000-token prefix that caches on Claude Sonnet 5, with its 1,024-token minimum, falls below Claude Haiku 4.5's 4,096-token minimum and is processed uncached. On that prefix, Sonnet 5's cache reads at $0.20 per million tokens cost less than Haiku 4.5's uncached input at $1. Compare each model's cost at your real cached share before acting on any per-token saving.
- **Keep response caching out of evaluation.** A cached response is evidence about the cache, not the model. rightmodeler leaves out of its evidence any replayed response that a gateway reports as a cache hit, such as a [Portkey](https://www.rightmodeler.com/integrations/portkey) cache-status header or a [Bifrost](https://www.rightmodeler.com/integrations/bifrost) cache flag, and its gateway setup keeps response caching off on the replay route. Fallbacks, aliases and rewritten requests contaminate an evaluation the same way; [how an AI gateway can invalidate your model evaluation](https://www.rightmodeler.com/blog/llm-gateway-evaluation-pitfalls) covers all four.
- **Fine-tune last.** Training is the most expensive experiment, so run it after substitution has shown that no existing model clears the bar at an acceptable price.

## The short version

Match the approach to the problem you can see in your traces:

- **Frontier prices on routine steps:** model substitution, proven per step on held-out cases.
- **One step with easy and hard requests:** routing, proven on held-out traffic.
- **Long repeated prefixes:** prompt caching, proven by the cached share of input.
- **Exact repeated requests:** response caching, proven by the duplicate rate.
- **Oversized inputs:** compression, proven by task success and cost net of cache effects.
- **Latency-tolerant bulk work:** batch APIs, proven by completion times.
- **A narrow, high-volume task:** fine-tuning or distillation, proven on held-out inputs at full lifecycle cost.

If the first line describes your bill, start with the traces you already have. [How it works](https://www.rightmodeler.com/how-it-works) explains the replay-and-judge loop, and the [B:Side Assist case study](https://www.rightmodeler.com/case-study/bside) shows the evidence from one audit, workload by workload.
`;
