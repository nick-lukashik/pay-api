Source: official docs (summarized): https://github.com/prometheus/client_js (README @prometheus-io/client), https://prometheus.io/docs/practices/naming/, https://prometheus.io/docs/practices/instrumentation/, https://prometheus.io/docs/practices/histograms/. There are no official agent rules or llms.txt (prometheus/prometheus-mcp is an MCP server for Prometheus itself, not rules for the client). The API was checked against the installed @prometheus-io/client 0.16.1.

# Prometheus: @prometheus-io/client (successor to prom-client)

- The package is `@prometheus-io/client`, not `prom-client`. It is CommonJS, but named imports work in ESM: `import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from '@prometheus-io/client'`.
- Use your own `Registry`, one per application, as a provider by token. Don't use the global `register`: a metric without `registers: [registry]` lands in the global registry, and creating it again (for example, a second Nest application in tests) fails with "already been registered".
- Call `collectDefaultMetrics({ register: registry })` once, when the registry is created.
- Every metric has `name`, `help`, `labelNames` and `registers: [registry]`. Create metrics once in a provider, not in a request handler.
- Names:
  - snake_case and base units (`_seconds`, `_bytes`), counters get the `_total` suffix;
  - a subsystem prefix: `http_`, `outbox_`, `jobs_`, `amqp_`;
  - examples: `http_server_request_duration_seconds` (Histogram), `outbox_published_total`.
- Labels have low cardinality and a closed set of values:
  - allowed: `method`, `route`, `status_code` (or the status class), `queue`, `result`;
  - `route` is the Nest route template such as `/items/:id`, not `req.url`;
  - not allowed: ids, email, the raw path, the query, error text, requestId;
  - a request with no route (a 404 before routing) gets a constant, for example `route="unmatched"`.
- Measure durations with a Histogram, not a Summary: histograms aggregate across replicas. Timer: `startTimer(labels)` returns an `end(moreLabels)` function. Choose buckets to fit the SLO, and no more than needed.
- Instantaneous values (queue depth, connection pool, outbox backlog) are a Gauge with `collect()`, which is called on scrape. Don't update them with `setInterval`.
- The `/metrics` endpoint:
  - responds with `res.type(registry.contentType)` and `await registry.metrics()`;
  - sits outside the global API prefix, with no throttler and no request logging;
  - is not published externally through the ingress.
- Don't add instance and pod labels through `setDefaultLabels`: Prometheus itself sets them from the target.
- In tests, each application instance gets a fresh `Registry`. Check values with `await metric.get()` or `registry.getSingleMetricAsString(name)`.
