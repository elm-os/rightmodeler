import { defineHook } from "eve/hooks";

import { persistAgentRecord } from "../lib/persistence.js";

const skippedAuditEvents = new Set([
  "action.partial",
  "message.appended",
  "reasoning.appended",
]);

export default defineHook({
  events: {
    async "*"(event, ctx) {
      if (skippedAuditEvents.has(event.type)) return;
      await persistAgentRecord("audit", event.meta.id, {
        schemaVersion: 1,
        kind: "agent_audit_event",
        eventId: event.meta.id,
        emittedAt: event.meta.at,
        sessionId: ctx.session.id,
        agent: ctx.agent,
        channel: ctx.channel,
        event,
      });
    },
  },
});
