# `lib/metrics/` — OTLP adapter for the MetricsPort (WS-5)

`otlp-metrics.ts` implements the WS-2 `MetricsPort`
(`lib/workers/metrics-port.ts`) as an OTLP/HTTP binary-protobuf
exporter of cumulative monotonic sums. It targets:

- **Scaleway Cockpit** — metrics data source (Mimir) OTLP write route
  `https://<data-source-id>.metrics.cockpit.<region>.scw.cloud/otlp/v1/metrics`,
  Cockpit token (push permission) as `Authorization: Bearer`.
  Docs: <https://www.scaleway.com/en/docs/cockpit/reference-content/cockpit-supported-endpoints/>
- **Any OTLP collector** — point `endpoint` at its metrics route.

## Wiring TODO (fenced out of WS-5 — apps/worker is WS-2-owned)

The worker container (`apps/worker/src/main.ts`) currently injects
`noopMetrics` into the extracted cores. When the WS-2 lane's files are
free, wire this adapter behind env selection (manifest D8a DRAFT names):

```ts
// apps/worker/src/main.ts (TODO — do not apply while WS-2 owns the file)
import { OtlpMetrics } from "@de-otio/trellis/…/lib/metrics/otlp-metrics.js";

const metrics =
  process.env.METRICS_PROVIDER === "otlp"
    ? new OtlpMetrics({
        endpoint: requireEnv("OTLP_METRICS_ENDPOINT"), // full …/otlp/v1/metrics URL
        authToken: process.env.OTLP_METRICS_TOKEN,     // Cockpit push token; resolve
                                                       // via the secrets port in prod
        resourceAttributes: {
          "service.name": "trellis-worker",
          "deployment.environment": process.env.STAGE ?? "dev",
        },
      })
    : noopMetrics; // AWS profile keeps the EMF adapter (lambda/emf-metrics-adapter.ts)
// …pass `metrics` into the worker context where noopMetrics is passed today,
// and call `metrics.shutdown()` in the drain path.
```

- `METRICS_PROVIDER` unset keeps today's behavior (EMF on Lambda,
  noop in the container) — zero AWS change; the greenfield Scaleway env
  config sets `METRICS_PROVIDER=otlp` (2026-07-20 scope decision:
  Scaleway-native defaults live in env configs, not code defaults).
- The AWS API container could adopt the same adapter against an ADOT
  collector sidecar later; nothing in this module is Scaleway-specific.

## Why cumulative sums

`emitCounts` is event-shaped (each call is an increment, mirroring
powertools EMF). Mimir-family OTLP endpoints do not accept delta
temporality, so the adapter keeps per-(metric, dimension-set) running
totals with a stable `start_time_unix_nano` and exports
`AGGREGATION_TEMPORALITY_CUMULATIVE`. Restarts reset the total — a
normal counter-reset for PromQL `rate()`/`increase()`.
