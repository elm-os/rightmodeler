import { claudeAdapter } from "./claude-route.js";
import { createCodexAdapter } from "./codex-route.js";
import {
  PlanLoginError,
  PlanRouteUnavailableError,
  preflightPlanCli,
  type PlanRouteKind,
} from "./plan-route.js";

export interface PlanLoginStatus {
  readonly kind: PlanRouteKind;
  readonly ready: boolean;
  readonly line: string;
}

export async function detectPlanLogins(
  env: NodeJS.ProcessEnv,
  withhold: readonly string[] = [],
): Promise<PlanLoginStatus[]> {
  return Promise.all(
    [createCodexAdapter({ env }), claudeAdapter].map(async (adapter) => {
      try {
        const { version } = await preflightPlanCli(adapter, env, withhold);
        return {
          kind: adapter.kind,
          ready: true,
          line: `${adapter.command} ${version}: signed in with your plan`,
        };
      } catch (error) {
        return {
          kind: adapter.kind,
          ready: false,
          line:
            error instanceof PlanLoginError
              ? `${adapter.command}: not signed in with a plan. ${error.remedy}`
              : error instanceof PlanRouteUnavailableError
                ? `${adapter.command}: cannot be used here. ${error.remedy}`
                : `${adapter.command}: could not be checked.`,
        };
      }
    }),
  );
}
