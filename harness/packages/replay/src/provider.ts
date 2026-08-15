import type { JsonValue } from "@rightmodeler/core";

export interface ModelPricing {
  input: number;
  output: number;
}

export interface ModelCatalogEntry {
  id: string;
  family: string;
  contextLength: number;
  pricing: ModelPricing | null;
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
}

export type ChatMessage =
  | {
      role: "system" | "developer" | "user" | "assistant";
      content: string;
    }
  | {
      role: "tool";
      content: string;
      tool_call_id: string;
    };

export interface ChatRequest {
  model: string;
  messages: readonly ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  estimatedInputTokens?: number;
  tools?: JsonValue;
  toolChoice?: JsonValue;
  responseFormat?: JsonValue;
  headers?: Readonly<Record<string, string>>;
  onAttempt?: (attempt: ProviderAttempt) => void | Promise<void>;
}

export interface ChatResponse {
  content: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    status?: "usage_unreported";
  };
  costUsd: number;
  costIsEstimate: boolean;
}

export interface ProviderErrorDetail {
  status: number | null;
  bodyExcerpt: string;
}

export interface ProviderAttempt extends ChatResponse {
  outcome: "completed" | "provider_error";
  errorDetail?: ProviderErrorDetail;
}

export interface ProviderClient {
  readonly providerId: string;
  listModels(): Promise<ModelCatalogEntry[]>;
  chat(request: ChatRequest): Promise<ChatResponse>;
}

export interface CreateProviderOptions {
  providerId: string;
  baseUrl: string;
  apiKeyEnv: string;
  maxConcurrency?: number;
}

export class BlockedError extends Error {
  readonly kind: "rate-limit" | "provider";
  readonly observedCeiling: number | null;
  readonly providerId: string | null;
  readonly errorDetail?: ProviderErrorDetail;

  constructor(status: number, observedCeiling: number);
  constructor(providerId: string, errorDetail: ProviderErrorDetail);
  constructor(
    statusOrProvider: number | string,
    ceilingOrDetail: number | ProviderErrorDetail,
  ) {
    const rateLimited = typeof statusOrProvider === "number";
    super(
      rateLimited
        ? `Provider retries exhausted after HTTP ${statusOrProvider}; observed concurrency ceiling: ${ceilingOrDetail as number}`
        : `Provider ${statusOrProvider} returned a malformed model catalog`,
    );
    this.name = "BlockedError";
    this.kind = rateLimited ? "rate-limit" : "provider";
    this.observedCeiling = rateLimited ? (ceilingOrDetail as number) : null;
    this.providerId = rateLimited ? null : statusOrProvider;
    if (!rateLimited) {
      this.errorDetail = ceilingOrDetail as ProviderErrorDetail;
    }
  }
}

export class ProviderRequestError extends Error {}

export class ProviderHttpError extends ProviderRequestError {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`Provider request failed with HTTP ${status}: ${body}`);
    this.name = "ProviderHttpError";
    this.status = status;
  }
}

export class ProviderConfigurationError extends Error {}
export class ProviderResponseError extends ProviderRequestError {
  readonly status: number;
  readonly bodyExcerpt: string;
  readonly redacted = true;

  constructor(
    message: string,
    { status, bodyExcerpt }: ProviderErrorDetail & { status: number },
  ) {
    super(message);
    this.name = "ProviderResponseError";
    this.status = status;
    this.bodyExcerpt = bodyExcerpt.slice(0, 500);
  }
}

class AdaptiveLimiter {
  private readonly ceiling: number;
  private cap: number;
  private active = 0;
  private successStreak = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(ceiling: number) {
    if (!Number.isSafeInteger(ceiling) || ceiling < 1) {
      throw new Error("maxConcurrency must be a positive integer");
    }
    this.ceiling = ceiling;
    this.cap = ceiling;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.drain();
    }
  }

  rateLimited(): void {
    this.cap = Math.max(1, Math.floor(this.cap / 2));
    this.successStreak = 0;
  }

  failed(): void {
    this.successStreak = 0;
  }

  succeeded(): void {
    if (this.cap >= this.ceiling) return;
    this.successStreak += 1;
    if (this.successStreak >= this.cap) {
      this.cap += 1;
      this.successStreak = 0;
      this.drain();
    }
  }

  get currentCap(): number {
    return this.cap;
  }

  private acquire(): Promise<void> {
    if (this.active < this.cap) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private drain(): void {
    while (this.active < this.cap) {
      const next = this.waiters.shift();
      if (next === undefined) return;
      next();
    }
  }
}

interface PhysicalResponse {
  response: Response;
  apiKey: string;
}

const retryAttempts = 5;

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonnegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return value;
}

function tokenCount(value: unknown, label: string): number {
  const count = nonnegativeNumber(value, label);
  if (!Number.isSafeInteger(count)) {
    throw new Error(`${label} must be an integer`);
  }
  return count;
}

function price(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(parsed)) return null;
  return nonnegativeNumber(parsed, label);
}

function responsePrice(value: unknown, label: string): number | null {
  const parsed = price(value, label);
  if (
    parsed === null &&
    value !== undefined &&
    value !== null &&
    value !== ""
  ) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return parsed;
}

function redact(value: string, apiKey: string): string {
  return apiKey.length === 0 ? value : value.split(apiKey).join("[redacted]");
}

function errorExcerpt(value: string, apiKey: string): string {
  return redact(value, apiKey).slice(0, 500);
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  const backoff = 100 * 2 ** (attempt - 1);
  return backoff + Math.random() * backoff * 0.25;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function normalizeModel(
  value: unknown,
  index: number,
): ModelCatalogEntry | null {
  const model = objectValue(value, `models[${index}]`);
  if (typeof model.id !== "string" || model.id.length === 0) {
    throw new Error(`models[${index}].id must be a non-empty string`);
  }
  if (model.type !== undefined && typeof model.type !== "string") {
    throw new Error(`models[${index}].type must be a string`);
  }
  if (model.type !== undefined && model.type !== "language") return null;
  const rawPricing = objectValue(
    model.pricing ?? {},
    `models[${index}].pricing`,
  );
  const supported = Array.isArray(model.supported_parameters)
    ? model.supported_parameters
    : [];
  if (!supported.every((parameter) => typeof parameter === "string")) {
    throw new Error(
      `models[${index}].supported_parameters must contain strings`,
    );
  }
  const contextField =
    model.context_window === undefined ? "context_length" : "context_window";
  const rawContext = model.context_window ?? model.context_length ?? 0;
  const contextLength = tokenCount(
    rawContext,
    `models[${index}].${contextField}`,
  );

  return {
    id: model.id,
    family: model.id.split("/", 1)[0]!,
    contextLength,
    pricing: (() => {
      const input = price(
        rawPricing.prompt ?? rawPricing.input_per_token ?? rawPricing.input,
        `models[${index}].pricing.input`,
      );
      const output = price(
        rawPricing.completion ??
          rawPricing.output_per_token ??
          rawPricing.output,
        `models[${index}].pricing.output`,
      );
      return input === null || output === null ? null : { input, output };
    })(),
    supportsTools: supported.includes("tools"),
    supportsStructuredOutput:
      supported.includes("response_format") ||
      supported.includes("structured_outputs"),
  };
}

function normalizeUsage(value: unknown): ChatResponse["usage"] | null {
  if (value === undefined || value === null) return null;
  const usage = objectValue(value, "chat response usage");
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  if (input === undefined && output === undefined) return null;
  return {
    inputTokens: tokenCount(input, "usage.prompt_tokens"),
    outputTokens: tokenCount(output, "usage.completion_tokens"),
  };
}

export function createProvider(options: CreateProviderOptions): ProviderClient {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const limiter = new AdaptiveLimiter(options.maxConcurrency ?? 8);
  let catalog: ModelCatalogEntry[] | undefined;
  let catalogRequest: Promise<ModelCatalogEntry[]> | undefined;

  function apiKey(): string {
    const value = process.env[options.apiKeyEnv];
    if (value === undefined || value.length === 0) {
      throw new ProviderConfigurationError(
        `Provider API key environment variable is not set: ${options.apiKeyEnv}`,
      );
    }
    return value;
  }

  async function physicalFetch(
    path: string,
    init: RequestInit,
  ): Promise<PhysicalResponse> {
    const key = apiKey();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${key}`);
    return limiter.run(async () => {
      try {
        const response = await fetch(`${baseUrl}${path}`, {
          ...init,
          headers,
        });
        if (response.status === 429) limiter.rateLimited();
        else if (response.ok) limiter.succeeded();
        else limiter.failed();
        return { response, apiKey: key };
      } catch (error) {
        limiter.failed();
        throw new ProviderRequestError(
          error instanceof Error ? error.message : String(error),
        );
      }
    });
  }

  async function withRetries(
    path: string,
    init: RequestInit,
    onRejectedAttempt?: (attempt: ProviderAttempt) => void | Promise<void>,
  ): Promise<PhysicalResponse> {
    for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
      let result: PhysicalResponse;
      try {
        result = await physicalFetch(path, init);
      } catch (error) {
        if (error instanceof ProviderConfigurationError) throw error;
        const bodyExcerpt = errorExcerpt(
          error instanceof Error ? error.message : String(error),
          apiKey(),
        );
        await onRejectedAttempt?.({
          outcome: "provider_error",
          content: "",
          usage: { inputTokens: 0, outputTokens: 0 },
          costUsd: 0,
          costIsEstimate: true,
          errorDetail: { status: null, bodyExcerpt },
        });
        throw error;
      }
      if (result.response.ok) {
        return result;
      }

      const bodyExcerpt = errorExcerpt(
        await result.response.text(),
        result.apiKey,
      );

      await onRejectedAttempt?.({
        outcome: "provider_error",
        content: "",
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        costIsEstimate: true,
        errorDetail: {
          status: result.response.status,
          bodyExcerpt,
        },
      });

      if (isRetryable(result.response.status)) {
        if (attempt === retryAttempts) {
          throw new BlockedError(result.response.status, limiter.currentCap);
        }
        await sleep(retryDelay(result.response, attempt));
        continue;
      }

      throw new ProviderHttpError(result.response.status, bodyExcerpt);
    }
    throw new BlockedError(429, limiter.currentCap);
  }

  async function fetchCatalog(): Promise<ModelCatalogEntry[]> {
    const { response, apiKey: requestKey } = await withRetries("/models", {
      method: "GET",
    });
    const responseText = await response.text();
    try {
      const value: unknown = JSON.parse(responseText);
      const envelope = objectValue(value, "model catalog");
      if (!Array.isArray(envelope.data)) {
        throw new Error("model catalog data must be an array");
      }
      catalog = envelope.data
        .map(normalizeModel)
        .filter((model) => model !== null);
      return catalog;
    } catch (error) {
      throw new BlockedError(options.providerId, {
        status: response.status,
        bodyExcerpt: errorExcerpt(responseText, requestKey),
      });
    }
  }

  function listModels(): Promise<ModelCatalogEntry[]> {
    if (catalog !== undefined) return Promise.resolve(catalog);
    if (catalogRequest !== undefined) return catalogRequest;
    catalogRequest = fetchCatalog().finally(() => {
      catalogRequest = undefined;
    });
    return catalogRequest;
  }

  async function chat(request: ChatRequest): Promise<ChatResponse> {
    const models = await listModels();
    const maxTokens =
      request.maxOutputTokens === undefined
        ? undefined
        : Math.max(16, request.maxOutputTokens);
    const body = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      // AI Gateway rejects output limits below 16 even when the upstream model accepts them.
      max_tokens: maxTokens,
      tools: request.tools,
      tool_choice: request.toolChoice,
      response_format: request.responseFormat,
      stream: false,
    };
    const { response, apiKey: requestKey } = await withRetries(
      "/chat/completions",
      {
        method: "POST",
        headers: {
          ...request.headers,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      request.onAttempt,
    );

    const responseText = await response.text();
    let normalized: ChatResponse;
    try {
      const value: unknown = JSON.parse(responseText);
      const envelope = objectValue(value, "chat response");
      if (!Array.isArray(envelope.choices) || envelope.choices.length === 0) {
        throw new Error("chat response choices must be a non-empty array");
      }
      const choice = objectValue(envelope.choices[0], "chat response choice");
      const message = objectValue(choice.message, "chat response message");
      if (typeof message.content !== "string" && message.content !== null) {
        throw new Error(
          "chat response message content must be a string or null",
        );
      }
      const content = message.content ?? "";
      const reportedUsage = normalizeUsage(envelope.usage);
      const usageObject =
        envelope.usage === undefined || envelope.usage === null
          ? {}
          : objectValue(envelope.usage, "chat response usage");
      const usageUnreported =
        content.trim().length > 0 &&
        (reportedUsage === null || reportedUsage.outputTokens === 0);
      const usage: ChatResponse["usage"] = usageUnreported
        ? {
            inputTokens:
              reportedUsage?.inputTokens ||
              request.estimatedInputTokens ||
              Math.max(
                1,
                Math.ceil(
                  Buffer.byteLength(JSON.stringify(request.messages)) / 4,
                ),
              ),
            outputTokens: Math.max(
              1,
              Math.ceil(Buffer.byteLength(content) / 4),
            ),
            status: "usage_unreported",
          }
        : (reportedUsage ?? {
            inputTokens: 0,
            outputTokens: 0,
          });
      const costDetails =
        usageObject.cost_details === undefined ||
        usageObject.cost_details === null
          ? {}
          : objectValue(usageObject.cost_details, "usage.cost_details");
      const billedCost = responsePrice(usageObject.cost, "usage.cost");
      const marketCost = responsePrice(
        usageObject.market_cost,
        "usage.market_cost",
      );
      const upstreamCost = responsePrice(
        costDetails.upstream_inference_cost,
        "usage.cost_details.upstream_inference_cost",
      );
      let costUsd: number;
      let costIsEstimate: boolean;
      // Prefer positive billed cost, then market cost, then upstream cost; a BYOK billed zero is not free.
      const providerCost =
        billedCost !== null && billedCost > 0
          ? billedCost
          : (marketCost ?? upstreamCost);
      if (!usageUnreported && providerCost !== null) {
        costUsd = providerCost;
        costIsEstimate = false;
      } else {
        const model = models.find((item) => item.id === request.model);
        if (model === undefined) {
          throw new Error(
            `Requested model is absent from the catalog: ${request.model}`,
          );
        }
        if (model.pricing === null) {
          throw new Error(`Requested model has no pricing: ${request.model}`);
        }
        costUsd =
          usage.inputTokens * model.pricing.input +
          usage.outputTokens * model.pricing.output;
        costIsEstimate = true;
      }
      normalized = {
        content,
        usage,
        costUsd,
        costIsEstimate,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorDetail = {
        status: response.status,
        bodyExcerpt: errorExcerpt(responseText, requestKey),
      };
      await request.onAttempt?.({
        outcome: "provider_error",
        content: "",
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        costIsEstimate: true,
        errorDetail,
      });
      throw new ProviderResponseError(
        `Invalid chat response: ${redact(message, requestKey)}`,
        errorDetail,
      );
    }
    await request.onAttempt?.({ outcome: "completed", ...normalized });
    return normalized;
  }

  return { providerId: options.providerId, listModels, chat };
}
