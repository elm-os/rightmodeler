import { describe, expect, it } from "vitest";

import type {
  AgentAdapter,
  CommandCallback,
  EvaluatorProvider,
  ExecutorProvider,
  MatcherPlugin,
  ModelProvider,
  NotifierPlugin,
  OwnershipProvider,
  PeopleProvider,
  TraceAdapter,
} from "./plugins.js";
import { PluginRegistry } from "./plugins.js";

describe("PluginRegistry", () => {
  it("accumulates additive kinds and commands in plugin order", () => {
    const matcherA: MatcherPlugin = { examples: ["a"], match: () => ["a"] };
    const matcherB: MatcherPlugin = { examples: ["b"], match: () => ["b"] };
    const agentA: AgentAdapter = async function* (
      _input: unknown,
    ): AsyncGenerator<unknown, unknown, void> {
      return "a";
    };
    const agentB: AgentAdapter = async function* (
      _input: unknown,
    ): AsyncGenerator<unknown, unknown, void> {
      return "b";
    };
    const notifierA: NotifierPlugin = { notify: async () => "a" };
    const notifierB: NotifierPlugin = { notify: async () => "b" };
    const evaluatorA: EvaluatorProvider = {
      id: "a",
      detectAvailability: async () => true,
      launch: async () => ({ providerRunId: "a" }),
      status: async () => "complete",
      collect: async () => [],
    };
    const evaluatorB: EvaluatorProvider = {
      id: "b",
      detectAvailability: async () => true,
      launch: async () => ({ providerRunId: "b" }),
      status: async () => "complete",
      collect: async () => [],
    };
    const commandOrder: string[] = [];
    const commandA: CommandCallback = () => commandOrder.push("a");
    const commandB: CommandCallback = () => commandOrder.push("b");

    const registry = new PluginRegistry([
      {
        matchers: [matcherA],
        agents: [agentA],
        notifiers: [notifierA],
        evaluators: [evaluatorA],
        commands: commandA,
      },
      {
        matchers: [matcherB],
        agents: [agentB],
        notifiers: [notifierB],
        evaluators: [evaluatorB],
        commands: commandB,
      },
    ]);

    expect(registry.matchers).toEqual([matcherA, matcherB]);
    expect(registry.agents).toEqual([agentA, agentB]);
    expect(registry.notifiers).toEqual([notifierA, notifierB]);
    expect(registry.evaluators).toEqual([evaluatorA, evaluatorB]);
    expect(registry.commands).toEqual([commandA, commandB]);

    for (const command of registry.commands) command({});
    expect(commandOrder).toEqual(["a", "b"]);
  });

  it("uses the last declared ownership, people, and executor providers", () => {
    const ownershipA: OwnershipProvider = { lookup: async () => "a" };
    const ownershipB: OwnershipProvider = { lookup: async () => "b" };
    const peopleA: PeopleProvider = { lookup: async () => "a" };
    const peopleB: PeopleProvider = { lookup: async () => "b" };
    const executorA: ExecutorProvider = {
      launch: async () => "a",
      collect: async (_runId, _request) => "a",
      status: async () => "a",
      destroy: async () => undefined,
    };
    const executorB: ExecutorProvider = {
      launch: async () => "b",
      collect: async (_runId, _request) => "b",
      status: async () => "b",
      destroy: async () => undefined,
    };

    const registry = new PluginRegistry([
      { ownership: ownershipA, people: peopleA, executor: executorA },
      { ownership: ownershipB },
      { people: peopleB, executor: executorB },
    ]);

    expect(registry.ownership).toBe(ownershipB);
    expect(registry.people).toBe(peopleB);
    expect(registry.executor).toBe(executorB);
  });

  it("accumulates trace adapters in plugin order", () => {
    const adapterA: TraceAdapter = { detect: () => 0.9, adapt: () => ["a"] };
    const adapterB: TraceAdapter = { detect: () => 0.8, adapt: () => ["b"] };

    const registry = new PluginRegistry([
      { traceAdapters: [adapterA] },
      { traceAdapters: [adapterB] },
    ]);

    expect(registry.traceAdapters).toEqual([adapterA, adapterB]);
  });

  it("accumulates model providers in plugin order", () => {
    const providerA: ModelProvider = {
      listModels: async () => ["a"],
      chat: async () => "a",
    };
    const providerB: ModelProvider = {
      listModels: async () => ["b"],
      chat: async () => "b",
    };

    const registry = new PluginRegistry([
      { modelProviders: [providerA] },
      { modelProviders: [providerB] },
    ]);

    expect(registry.modelProviders).toEqual([providerA, providerB]);
  });

  it("starts with empty additive kinds and no last-wins providers", () => {
    const registry = new PluginRegistry([]);

    expect(registry.matchers).toEqual([]);
    expect(registry.agents).toEqual([]);
    expect(registry.notifiers).toEqual([]);
    expect(registry.evaluators).toEqual([]);
    expect(registry.traceAdapters).toEqual([]);
    expect(registry.modelProviders).toEqual([]);
    expect(registry.commands).toEqual([]);
    expect(registry.ownership).toBeUndefined();
    expect(registry.people).toBeUndefined();
    expect(registry.executor).toBeUndefined();
  });
});
