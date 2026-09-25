// The aigw run configuration behind plain.json and fallback.json, captured on 2026-09-23: the
// acceptance kit's generator called with the capture's arguments. Its fallback route answers
// fallback-demo from a priority-0 backend, mock-500.mjs on the port given as the first argument,
// and retries on HTTP 500 to a priority-1 Vercel AI Gateway backend whose modelNameOverride sends
// amazon/nova-micro upstream. Usage: node capture-config.mjs <mock port> > aigw.yaml
import { aigwConfig } from "../../gateway-acceptance/envoy/aigw-config.mjs";

process.stdout.write(
  aigwConfig({
    models: ["amazon/nova-micro", "vercel-missing/model"],
    fallbacks: [{ id: "fallback-demo", overrideModel: "amazon/nova-micro" }],
    mockPort: Number(process.argv[2]),
  }),
);
