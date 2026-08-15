declare module "@rightmodeler/cli" {
  export type ApplySwapsOptions =
    import("../../../../packages/rightmodeler/src/apply/index.js").ApplySwapsOptions;
  export type ApplySwapsResult =
    import("../../../../packages/rightmodeler/src/apply/index.js").ApplySwapsResult;
  export type ApprovedSwapSet =
    import("../../../../packages/rightmodeler/src/pipeline.js").ApprovedSwapSet;
  export type WatchablePullRequest =
    import("../../../../packages/rightmodeler/src/pipeline.js").WatchablePullRequest;
  export type RunStatusResult =
    import("../../../../packages/rightmodeler/src/pipeline.js").RunStatusResult;

  export function applySwaps(
    options: ApplySwapsOptions,
  ): Promise<ApplySwapsResult>;
  export function listApprovedSwapSets(options: {
    readonly repo: string;
    readonly store?: string;
  }): Promise<ApprovedSwapSet[]>;
  export function listWatchablePullRequests(options: {
    readonly repo: string;
    readonly store?: string;
  }): Promise<WatchablePullRequest[]>;
  export function readActiveDetachedReplay(options: {
    readonly repo: string;
    readonly store?: string;
  }): Promise<RunStatusResult | null>;
}
