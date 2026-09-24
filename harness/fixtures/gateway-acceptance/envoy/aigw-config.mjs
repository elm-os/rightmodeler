const quote = (value) => JSON.stringify(value);

function headerMatch(id) {
  return `        - headers:
            - type: Exact
              name: x-ai-eg-model
              value: ${quote(id)}`;
}

function backend(name, hostname, port) {
  return `apiVersion: gateway.envoyproxy.io/v1alpha1
kind: Backend
metadata:
  name: ${name}
  namespace: default
spec:
  endpoints:
    - fqdn:
        hostname: ${quote(hostname)}
        port: ${port}
---
apiVersion: aigateway.envoyproxy.io/v1beta1
kind: AIServiceBackend
metadata:
  name: ${name}
  namespace: default
spec:
  schema:
    name: OpenAI
    prefix: v1
  backendRef:
    name: ${name}
    kind: Backend
    group: gateway.envoyproxy.io`;
}

function apiKey(name, value) {
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${name}-apikey
  namespace: default
type: Opaque
stringData:
  apiKey: ${quote(value)}
---
apiVersion: aigateway.envoyproxy.io/v1beta1
kind: BackendSecurityPolicy
metadata:
  name: ${name}-apikey
  namespace: default
spec:
  targetRefs:
    - group: aigateway.envoyproxy.io
      kind: AIServiceBackend
      name: ${name}
  type: APIKey
  apiKey:
    secretRef:
      name: ${name}-apikey`;
}

function route(name, rules) {
  return `apiVersion: aigateway.envoyproxy.io/v1beta1
kind: AIGatewayRoute
metadata:
  name: ${name}
  namespace: default
spec:
  parentRefs:
    - name: aigw-run
      kind: Gateway
      group: gateway.networking.k8s.io
  rules:
${rules.join("\n")}`;
}

export function aigwConfig({
  models,
  fallbacks = [],
  mockPort,
  secretEnv = "AI_GATEWAY_API_KEY",
}) {
  const documents = [
    `apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: aigw-run
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller`,
    `apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: aigw-run
  namespace: default
spec:
  gatewayClassName: aigw-run
  listeners:
    - name: http
      protocol: HTTP
      port: 1975`,
    `apiVersion: gateway.envoyproxy.io/v1alpha1
kind: ClientTrafficPolicy
metadata:
  name: client-buffer-limit
  namespace: default
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: aigw-run
  connection:
    bufferLimit: 50Mi`,
    route("replay", [
      `    - matches:
${models.map(headerMatch).join("\n")}
      modelsOwnedBy: vercel-ai-gateway
      backendRefs:
        - name: vercel
      timeouts:
        request: 300s`,
    ]),
    backend("vercel", "ai-gateway.vercel.sh", 443),
    `apiVersion: gateway.networking.k8s.io/v1alpha3
kind: BackendTLSPolicy
metadata:
  name: vercel-tls
  namespace: default
spec:
  targetRefs:
    - group: gateway.envoyproxy.io
      kind: Backend
      name: vercel
  validation:
    wellKnownCACertificates: System
    hostname: ai-gateway.vercel.sh`,
    apiKey("vercel", `\${${secretEnv}}`),
  ];
  if (fallbacks.length > 0) {
    documents.push(
      route(
        "fallback",
        fallbacks.map(
          ({ id, overrideModel }) => `    - matches:
${headerMatch(id)}
      backendRefs:
        - name: mock
          priority: 0
        - name: vercel
          modelNameOverride: ${quote(overrideModel)}
          priority: 1`,
        ),
      ),
      `apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: fallback-retry
  namespace: default
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: fallback
  retry:
    numAttemptsPerPriority: 1
    numRetries: 3
    perRetry:
      backOff:
        baseInterval: 100ms
        maxInterval: 1s
      timeout: 30s
    retryOn:
      httpStatusCodes:
        - 500
      triggers:
        - connect-failure
        - retriable-status-codes`,
      backend("mock", "host.docker.internal", mockPort),
      apiKey("mock", "mock-backend-key-not-secret"),
    );
  }
  return `${documents.join("\n---\n")}\n`;
}
