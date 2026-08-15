import { afterEach, expect, it, vi } from "vitest";

vi.mock("@vercel/sandbox", () => {
  throw new Error("optional package not installed");
});

import { detectCloudAvailability } from "./cloud-sandbox.js";

const originalOidcToken = process.env.VERCEL_OIDC_TOKEN;

afterEach(() => {
  if (originalOidcToken === undefined) delete process.env.VERCEL_OIDC_TOKEN;
  else process.env.VERCEL_OIDC_TOKEN = originalOidcToken;
});

it("reports an absent optional SDK with a named reason", async () => {
  process.env.VERCEL_OIDC_TOKEN = "test-oidc";

  await expect(detectCloudAvailability()).resolves.toMatchObject({
    available: false,
    reason: "sdk-unavailable",
    message: expect.stringContaining("@vercel/sandbox is unavailable"),
  });
});
