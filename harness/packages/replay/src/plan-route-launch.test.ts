import { describe, expect, it, vi } from "vitest";

import { PlanRouteUnavailableError } from "./plan-route.js";
import { planStubHarness } from "./test-utils/plan-cli-stub.js";

// Each case makes the CLI fail to start the way Node reports it, on any OS.
const launchFailure = vi.hoisted(() => ({ code: "" }));
vi.mock("@rightmodeler/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rightmodeler/core")>()),
  resolveCommand: () => {
    throw Object.assign(new Error(`spawn ${launchFailure.code}`), {
      code: launchFailure.code,
    });
  },
}));

describe("plan route launch failures", () => {
  it.each([
    [
      "EINVAL",
      "spawn EINVAL",
      "Install claude with its own installer or WinGet, or with npm outside a version manager such as Volta, or use an API route with --base-url <url> and --api-key-env <name>.",
    ],
    [
      "ENAMETOOLONG",
      "claude could not start: its command line is longer than the system allows (32,767 characters on Windows), usually because a step's structured-output schema is large.",
      "Use an API route with --base-url <url> and --api-key-env <name> for this run.",
    ],
    [
      "E2BIG",
      "claude could not start: its command line is longer than the system allows (32,767 characters on Windows), usually because a step's structured-output schema is large.",
      "Use an API route with --base-url <url> and --api-key-env <name> for this run.",
    ],
  ])("stops the route with a remedy on %s", async (code, message, remedy) => {
    launchFailure.code = code;
    const harness = await planStubHarness();
    const error = await harness.provider.listModels().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(PlanRouteUnavailableError);
    expect(error).toMatchObject({ message, remedy });
  });
});
