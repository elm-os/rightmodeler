import {
  createClaudeLoginProvider,
  createProvider,
  type CreateProviderOptions,
  type ModelCatalogEntry,
  type PlanProviderOptions,
  type PlanRouteKind,
  type ProviderClient,
} from "@rightmodeler/replay";

export type RouteKind = "api" | PlanRouteKind;

export const DEFAULT_PLAN_PRICE_LIST = "https://ai-gateway.vercel.sh/v1/models";

export interface RouteHandle {
  readonly label: string;
  readonly provider: ProviderClient;
  callable(): Promise<ModelCatalogEntry[]>;
  known(): Promise<ModelCatalogEntry[]>;
}

export function apiRoute(
  options: Omit<CreateProviderOptions, "providerId">,
): RouteHandle {
  const provider = createProvider({
    providerId: "configured-provider",
    ...options,
  });
  return {
    label: options.baseUrl,
    provider,
    callable: () => provider.listModels(),
    known: () => provider.listModels(),
  };
}

export function planRoute(
  kind: PlanRouteKind,
  options: PlanProviderOptions,
): RouteHandle {
  const provider = createClaudeLoginProvider(options);
  return {
    label: `the ${kind} price list ${options.priceList}`,
    provider,
    callable: () => provider.listModels(),
    known: () => provider.knownModels(),
  };
}
