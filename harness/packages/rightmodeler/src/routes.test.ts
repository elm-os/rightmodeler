import { afterEach, describe, expect, it } from "vitest";

import { apiRoute } from "./routes.js";

interface StubProvider {
  port: number;
  close(): Promise<void>;
  getRequestHeaders(): Array<{ method: string; path: string }>;
}

const stubModuleUrl = new URL(
  "../../../fixtures/stub-provider/server.mjs",
  import.meta.url,
).href;
const apiKeyEnv = "RIGHTMODELER_ROUTES_TEST_API_KEY";

afterEach(() => {
  delete process.env[apiKeyEnv];
});

describe("API route", () => {
  it("lists the API route's catalog once for candidates and the judge", async () => {
    const { startStubProvider } = (await import(stubModuleUrl)) as {
      startStubProvider(options: { port: number }): Promise<StubProvider>;
    };
    const stub = await startStubProvider({ port: 0 });
    process.env[apiKeyEnv] = "fixture-key";
    try {
      const baseUrl = `http://127.0.0.1:${stub.port}/v1`;
      const route = apiRoute({ baseUrl, apiKeyEnv });

      const [known, callable] = await Promise.all([
        route.known(),
        route.callable(),
      ]);

      expect(callable).toBe(known);
      expect(known.map(({ id }) => id)).toContain("acme/small-1");
      expect(route.provider.providerId).toBe("configured-provider");
      expect(route.label).toBe(baseUrl);
      expect(
        stub
          .getRequestHeaders()
          .filter(
            ({ method, path }) => method === "GET" && path === "/v1/models",
          ),
      ).toHaveLength(1);
    } finally {
      await stub.close();
    }
  });
});
