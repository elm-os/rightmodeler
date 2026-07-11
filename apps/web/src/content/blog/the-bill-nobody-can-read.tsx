// Post: "The bill nobody can read" — part one of the vision series (Crucible). A typed post
// module: `meta` (data) plus a `Body` composed from the prose primitives. Registered in ./index.
// Voice matches the founding story: measured, honest, story-first. The scene is a composite of
// launches we have watched (and run) ourselves; no named customers, no invented figures beyond the
// story's own furniture. No accent hues in the copy; the accents live in the hero art.

import { A, H2, Lead, P, Prose, PullQuote } from "@/components/blog/prose";
import type { PostMeta } from "@/content/blog/types";

export const meta: PostMeta = {
  slug: "the-bill-nobody-can-read",
  title: "The bill nobody can read.",
  description:
    "Why your agent bill has no line items, and what to do about it. Part one of the rightmodeler vision: Crucible, the analytics and optimization suite for AI agents.",
  excerpt:
    "An agent feature ships, the invoice arrives as one number, and nobody can say which layer spent it. Part one of our vision: giving agents the instruments every other system already has.",
  kicker: "The vision · Part one",
  date: "2026-07-10",
  readingMinutes: 5,
  hero: {
    src: "/blog/the-bill-nobody-can-read-hero.jpg",
    alt: "A warm parchment field with stacked grain-textured gradient strata in rightmodeler's violet and orange brand accents.",
  },
};

export function Body() {
  return (
    <Prose>
      <Lead>
        Three weeks after the launch, finance forwarded the invoice with a
        one-line email: is this right? Nobody on the team could answer. Not
        because the number was secret, but because the number was one number,
        and the thing that produced it was not one thing.
      </Lead>

      <P>
        The details change from team to team, and we have now watched this
        scene play out at several, including our own. The shape is always the
        same. An agent feature ships on a Thursday. The demo lands, everyone is
        pleased, the system quietly goes to work. Then the bill arrives,
        several times larger than anyone expected, formatted as a single line
        item. Model usage. As if that explained anything.
      </P>

      <P>
        So someone stays late and goes spelunking. They export the usage CSVs.
        They grep logs. They build the spreadsheet every team builds
        eventually, the one with a tab per day and a formula nobody fully
        trusts. And buried in that spreadsheet they find the anatomy the
        invoice refused to show. An orchestrator calling a frontier model to
        decide which of three branches to take, thousands of times a day. A
        research subagent summarizing documents, and a coordinator summarizing
        the summaries. And the one that stings: a tool call that had been
        failing quietly for eleven days, caught by a fallback, retried three
        times per request. Every retry billed. No error ever surfaced, because
        technically nothing was down.
      </P>

      <H2>We instrument everything except the layer that thinks</H2>

      <P>
        Here is the strange part. That team was not sloppy. They had tracing
        on every service, dashboards for CPU and memory, alerts on p95s,
        budgets for every queue. Twenty years of observability practice, fully
        applied. And all of it stopped one layer short. The moment a request
        crossed into the agent system, the instruments went quiet. The stack
        saw a request go out and a response come back. What happened in
        between, which agent called which model, at which step, for how much,
        was a black box wearing a dashboard.
      </P>

      <PullQuote>
        Agents are systems now. We just have not given them the instruments we
        give every other system.
      </PullQuote>

      <P>
        A modern agent feature is not a model call. It is an orchestrator, a
        handful of subagents, tool calls, retries, judges, and glue steps,
        each with its own model, its own latency, and its own ways of failing.
        We would never run a fleet of services without per-service metrics. We
        run fleets of agents that way every day.
      </P>

      <H2>What seeing actually changes</H2>

      <P>
        Imagine the same three weeks with instruments. Cost has line items:
        this agent, this step, this model, this many dollars, ranked. The
        orchestrator&rsquo;s glue calls show up on day one as the most
        expensive routing decision in company history, instead of hiding in an
        aggregate for a quarter. Speed has a shape: p50 and p95 per step, so
        the slow layer cannot hide inside an average. And failures have a
        feed: the tool call that starts failing shows up the hour it starts,
        tagged with its retry bill, eleven days before the invoice does.
      </P>

      <P>
        None of this is exotic. It is the ordinary decency we already extend
        to databases and queues, extended to the layer that now does the
        thinking.
      </P>

      <H2>Crucible</H2>

      <P>
        <A href="/crucible">Crucible</A> is that instrument panel. It connects
        over MCP to the tracing you already emit, no new SDK, no
        re-instrumentation, and it never sits in your request path. It watches
        passively: cost per layer, speed per step, failed tool calls, silent
        retries, and quality regressions as they happen.
      </P>

      <P>
        And it does one thing a dashboard cannot. Crucible runs the
        rightmodeler proof loop continuously, the same replay-and-judge engine
        you can <A href="https://github.com/elm-os/rightmodeler">run by hand
        today</A>. So when it finds a layer overpaying for its work, it does
        not just chart the problem. It proves the cheaper model that holds
        your quality, and keeps the stack it watches right-sized.
      </P>

      <P>
        Seeing is the foundation. It is the half of the vision that makes the
        other half safe: once you can see every layer and prove every claim,
        changing models stops being frightening. What happens when a
        brand-new model ships on a Tuesday, and why that should end as a pull
        request in your repo, is{" "}
        <A href="/blog/the-tuesday-problem">part two</A>.
      </P>

      <P>
        Crucible is in early access. Join the waitlist on{" "}
        <A href="/crucible">the Crucible page</A> and we will send one note
        when it opens.
      </P>
    </Prose>
  );
}

// The same post as clean Markdown, for llms-full.txt and any LLM-facing surface. Kept in sync with
// Body above by hand.
export const markdown = `# The bill nobody can read.

Three weeks after the launch, finance forwarded the invoice with a one-line email: is this right? Nobody on the team could answer. Not because the number was secret, but because the number was one number, and the thing that produced it was not one thing.

The details change from team to team, and we have now watched this scene play out at several, including our own. The shape is always the same. An agent feature ships on a Thursday. The demo lands, everyone is pleased, the system quietly goes to work. Then the bill arrives, several times larger than anyone expected, formatted as a single line item. Model usage. As if that explained anything.

So someone stays late and goes spelunking. They export the usage CSVs. They grep logs. They build the spreadsheet every team builds eventually, the one with a tab per day and a formula nobody fully trusts. And buried in that spreadsheet they find the anatomy the invoice refused to show. An orchestrator calling a frontier model to decide which of three branches to take, thousands of times a day. A research subagent summarizing documents, and a coordinator summarizing the summaries. And the one that stings: a tool call that had been failing quietly for eleven days, caught by a fallback, retried three times per request. Every retry billed. No error ever surfaced, because technically nothing was down.

## We instrument everything except the layer that thinks

Here is the strange part. That team was not sloppy. They had tracing on every service, dashboards for CPU and memory, alerts on p95s, budgets for every queue. Twenty years of observability practice, fully applied. And all of it stopped one layer short. The moment a request crossed into the agent system, the instruments went quiet. The stack saw a request go out and a response come back. What happened in between, which agent called which model, at which step, for how much, was a black box wearing a dashboard.

> Agents are systems now. We just have not given them the instruments we give every other system.

A modern agent feature is not a model call. It is an orchestrator, a handful of subagents, tool calls, retries, judges, and glue steps, each with its own model, its own latency, and its own ways of failing. We would never run a fleet of services without per-service metrics. We run fleets of agents that way every day.

## What seeing actually changes

Imagine the same three weeks with instruments. Cost has line items: this agent, this step, this model, this many dollars, ranked. The orchestrator's glue calls show up on day one as the most expensive routing decision in company history, instead of hiding in an aggregate for a quarter. Speed has a shape: p50 and p95 per step, so the slow layer cannot hide inside an average. And failures have a feed: the tool call that starts failing shows up the hour it starts, tagged with its retry bill, eleven days before the invoice does.

None of this is exotic. It is the ordinary decency we already extend to databases and queues, extended to the layer that now does the thinking.

## Crucible

[Crucible](https://www.rightmodeler.com/crucible) is that instrument panel. It connects over MCP to the tracing you already emit, no new SDK, no re-instrumentation, and it never sits in your request path. It watches passively: cost per layer, speed per step, failed tool calls, silent retries, and quality regressions as they happen.

And it does one thing a dashboard cannot. Crucible runs the rightmodeler proof loop continuously, the same replay-and-judge engine you can [run by hand today](https://github.com/elm-os/rightmodeler). So when it finds a layer overpaying for its work, it does not just chart the problem. It proves the cheaper model that holds your quality, and keeps the stack it watches right-sized.

Seeing is the foundation. It is the half of the vision that makes the other half safe: once you can see every layer and prove every claim, changing models stops being frightening. What happens when a brand-new model ships on a Tuesday, and why that should end as a pull request in your repo, is [part two](https://www.rightmodeler.com/blog/the-tuesday-problem).

Crucible is in early access. Join the waitlist on [the Crucible page](https://www.rightmodeler.com/crucible) and we will send one note when it opens.
`;
