import { defineHook } from "eve/hooks";

import { persistAgentRecord } from "../lib/persistence.js";

export default defineHook({
  events: {
    async "*"(event, ctx) {
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
