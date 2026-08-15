import type { JsonValue } from "./facts.js";

export interface MatcherPlugin {
  readonly examples: readonly string[];
  match(content: string, path: string): readonly unknown[];
}

export type AgentAdapter = (
  input: unknown,
) => AsyncGenerator<unknown, unknown, void>;

export interface NotifierPlugin {
  notify(params: unknown): Promise<unknown>;
}

export interface EvaluatorCase {
  readonly caseId: string;
  readonly input: JsonValue;
  readonly expected: JsonValue;
  readonly output: JsonValue;
}

export interface EvaluatorLaunchInput {
  readonly experimentName: string;
  readonly cases: readonly EvaluatorCase[];
}

export type EvaluatorRunStatus = "pending" | "complete" | "failed";

export interface EvaluatorMetric {
  readonly metricName: string;
  readonly score: number;
  readonly passed: boolean | null;
  readonly rubricVersion?: string;
}

export interface EvaluatorCaseResult {
  readonly caseId: string;
  readonly metrics: readonly EvaluatorMetric[];
  readonly artifactRef?: JsonValue;
}

export interface EvaluatorProvider {
  readonly id: string;
  detectAvailability(): Promise<boolean>;
  launch(params: EvaluatorLaunchInput): Promise<{ providerRunId: string }>;
  status(runId: string): Promise<EvaluatorRunStatus>;
  collect(runId: string): Promise<readonly EvaluatorCaseResult[]>;
}

export interface TraceAdapter {
  detect(sample: unknown): number;
  adapt(records: unknown): unknown[];
}

export interface ModelProvider {
  listModels(): Promise<unknown>;
  chat(request: unknown): Promise<unknown>;
}

export interface OwnershipProvider {
  lookup(query: unknown): Promise<unknown>;
}

export interface PeopleProvider {
  lookup(query: unknown): Promise<unknown>;
}

export interface ExecutorProvider {
  launch(params: unknown): Promise<string>;
  collect(runId: string, request: unknown): Promise<unknown>;
  status(runId: string): Promise<unknown>;
  destroy(runId: string): Promise<void>;
}

export type CommandCallback = (program: unknown) => void;

export interface Plugin {
  readonly matchers?: readonly MatcherPlugin[];
  readonly agents?: readonly AgentAdapter[];
  readonly notifiers?: readonly NotifierPlugin[];
  readonly evaluators?: readonly EvaluatorProvider[];
  readonly traceAdapters?: readonly TraceAdapter[];
  readonly modelProviders?: readonly ModelProvider[];
  readonly ownership?: OwnershipProvider;
  readonly people?: PeopleProvider;
  readonly executor?: ExecutorProvider;
  readonly commands?: CommandCallback;
}

export class PluginRegistry {
  readonly matchers: readonly MatcherPlugin[];
  readonly agents: readonly AgentAdapter[];
  readonly notifiers: readonly NotifierPlugin[];
  readonly evaluators: readonly EvaluatorProvider[];
  readonly traceAdapters: readonly TraceAdapter[];
  readonly modelProviders: readonly ModelProvider[];
  readonly ownership: OwnershipProvider | undefined;
  readonly people: PeopleProvider | undefined;
  readonly executor: ExecutorProvider | undefined;
  readonly commands: readonly CommandCallback[];

  constructor(plugins: readonly Plugin[]) {
    const matchers: MatcherPlugin[] = [];
    const agents: AgentAdapter[] = [];
    const notifiers: NotifierPlugin[] = [];
    const evaluators: EvaluatorProvider[] = [];
    const traceAdapters: TraceAdapter[] = [];
    const modelProviders: ModelProvider[] = [];
    const commands: CommandCallback[] = [];
    let ownership: OwnershipProvider | undefined;
    let people: PeopleProvider | undefined;
    let executor: ExecutorProvider | undefined;

    for (const plugin of plugins) {
      matchers.push(...(plugin.matchers ?? []));
      agents.push(...(plugin.agents ?? []));
      notifiers.push(...(plugin.notifiers ?? []));
      evaluators.push(...(plugin.evaluators ?? []));
      traceAdapters.push(...(plugin.traceAdapters ?? []));
      modelProviders.push(...(plugin.modelProviders ?? []));
      if (plugin.ownership !== undefined) ownership = plugin.ownership;
      if (plugin.people !== undefined) people = plugin.people;
      if (plugin.executor !== undefined) executor = plugin.executor;
      if (plugin.commands !== undefined) commands.push(plugin.commands);
    }

    this.matchers = matchers;
    this.agents = agents;
    this.notifiers = notifiers;
    this.evaluators = evaluators;
    this.traceAdapters = traceAdapters;
    this.modelProviders = modelProviders;
    this.ownership = ownership;
    this.people = people;
    this.executor = executor;
    this.commands = commands;
  }
}
