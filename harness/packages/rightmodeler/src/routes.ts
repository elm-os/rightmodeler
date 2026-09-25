import {
  createProvider,
  type CreateProviderOptions,
  type ModelCatalogEntry,
  type ProviderClient,
} from "@rightmodeler/replay";

export type RouteKind = "api";

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
