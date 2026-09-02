import { createHmac, timingSafeEqual } from "node:crypto";

import { defineChannel, POST } from "eve/channels";
import { createUnauthorizedResponse } from "eve/channels/auth";
import { z } from "zod";

import { watchPullRequestOnEvent } from "../lib/pr-watch.js";

const reviewSchema = z.object({
  action: z.string(),
  repository: z.object({
    owner: z.object({ login: z.string().min(1) }),
    name: z.string().min(1),
  }),
  pull_request: z.object({ number: z.number().int().positive() }),
});

function hasValidSignature(header: string | null, body: string): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (secret === undefined || secret.length === 0 || header === null) {
    return false;
  }
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    "utf8",
  );
  const received = Buffer.from(header, "utf8");
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}

function ignoredResponse(): Response {
  return Response.json({ ok: true, ignored: true });
}

export default defineChannel({
  routes: [
    POST("/eve/v1/github-review", async (request, { waitUntil }) => {
      const body = await request.text();
      if (
        !hasValidSignature(request.headers.get("x-hub-signature-256"), body)
      ) {
        return createUnauthorizedResponse({
          message: "The GitHub webhook signature did not verify.",
        });
      }
      if (request.headers.get("x-github-event") !== "pull_request_review") {
        return ignoredResponse();
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        return ignoredResponse();
      }
      const parsed = reviewSchema.safeParse(payload);
      if (!parsed.success || parsed.data.action !== "submitted") {
        return ignoredResponse();
      }
      waitUntil(
        watchPullRequestOnEvent(
          "pull_request_review",
          parsed.data.repository.owner.login,
          parsed.data.repository.name,
          parsed.data.pull_request.number,
        ),
      );
      return Response.json({ ok: true });
    }),
  ],
});
