import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

import { scanToReportResponder } from "./lib/eval-model.js";

export default defineAgent({
  model:
    process.env.RIGHTMODELER_AGENT_EVAL === "1"
      ? mockModel({
          modelId: "rightmodeler-fixture",
          provider: "rightmodeler-fixtures",
          respond: scanToReportResponder,
        })
      : "zai/glm-5.2",
  modelContextWindowTokens:
    process.env.RIGHTMODELER_AGENT_EVAL === "1" ? 128_000 : undefined,
  reasoning: "medium",
  limits: {
    sessionTimeoutMs: 60 * 60 * 1_000,
  },
  compaction: {
    thresholdPercent: 0.75,
  },
  build: {
    externalDependencies: ["@rightmodeler/cli"],
  },
});
