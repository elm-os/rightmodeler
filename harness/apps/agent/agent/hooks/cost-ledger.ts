import { defineHook } from "eve/hooks";

import { persistAgentRecord } from "../lib/persistence.js";

export default defineHook({
  events: {
    async "step.completed"(event, ctx) {
      const usage = event.data.usage;
      if (usage?.costUsd === undefined) return;
      await persistAgentRecord("spend", event.meta.id, {
        schemaVersion: 1,
        kind: "agent_spend",
        eventId: event.meta.id,
        emittedAt: event.meta.at,
        sessionId: ctx.session.id,
        turnId: event.data.turnId,
        agent: ctx.agent.name,
        channel: ctx.channel.kind ?? null,
        costUsd: usage.costUsd,
        usage: {
          ...(usage.inputTokens === undefined
            ? {}
            : { inputTokens: usage.inputTokens }),
          ...(usage.outputTokens === undefined
            ? {}
            : { outputTokens: usage.outputTokens }),
          ...(usage.cacheReadTokens === undefined
            ? {}
            : { cacheReadTokens: usage.cacheReadTokens }),
          ...(usage.cacheWriteTokens === undefined
            ? {}
            : { cacheWriteTokens: usage.cacheWriteTokens }),
        },
      });
    },
  },
});
