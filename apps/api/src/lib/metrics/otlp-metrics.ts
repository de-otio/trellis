/**
 * OTLP metrics adapter for the WS-2 {@link MetricsPort} (WS-5).
 *
 * Exports the grouped `emitCounts` streams as OTLP/HTTP **binary
 * protobuf** to any OTLP metrics receiver:
 *
 * - **Scaleway Cockpit**: the metrics data source (Mimir) accepts OTLP
 *   writes at `https://<data-source-id>.metrics.cockpit.<region>.scw.cloud/otlp/v1/metrics`,
 *   authenticated with a Cockpit token (push permission) via
 *   `Authorization: Bearer <token>`. Grounding (2026-07-20):
 *   https://www.scaleway.com/en/docs/cockpit/reference-content/cockpit-supported-endpoints/
 *   (write endpoints `/api/v1/push` + `/otlp/v1/metrics`) and
 *   https://www.scaleway.com/en/docs/cockpit/how-to/send-metrics-logs-to-cockpit/
 *   (Bearer-token auth).
 * - **Any OTLP collector** (otel-collector, Alloy, Grafana Cloud):
 *   point `endpoint` at its `/v1/metrics` (collectors) or
 *   `/otlp/v1/metrics` (Mimir-style) route.
 *
 * Binary protobuf (not OTLP/JSON) is used because Mimir-family
 * endpoints require it; JSON is at best a low-traffic testing mode
 * (https://grafana.com/docs/grafana-cloud/send-data/otlp/otlp-format-considerations/).
 * The encoder below hand-writes the tiny subset of
 * opentelemetry-proto's `ExportMetricsServiceRequest` this adapter
 * needs (monotonic cumulative Sum data points) — field numbers per
 * https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/metrics/v1/metrics.proto
 * — so the API bundle takes no OTel SDK dependency.
 *
 * Semantics:
 * - `emitCounts` groups become **cumulative monotonic sums**: the
 *   adapter keeps a running total per (metric name, dimension set)
 *   stream with a stable `start_time_unix_nano`. Cumulative (not
 *   delta) temporality is deliberate — Mimir does not ingest delta.
 * - Fail-open (MetricsPort contract): `emitCounts` never throws and
 *   never blocks; export runs on a timer (default 15 s, unref'd) and
 *   failures only reach `onError` (default: one console.error per
 *   process — metrics must never take a worker down or spam logs).
 *
 * NOT wired into apps/worker here — that directory is owned by the
 * WS-2 lane; see lib/metrics/README.md for the wiring TODO.
 */

import type { MetricDatum, MetricsPort } from "../workers/metrics-port.js";

// ---------------------------------------------------------------------------
// Minimal protobuf writer (wire format only — varint, length-delimited,
// 64-bit). Field numbers/types follow opentelemetry-proto metrics.proto v1.
// ---------------------------------------------------------------------------

function varint(value: number): number[] {
  // Values here are small non-negative ints (tags, lengths, enum values).
  const out: number[] = [];
  let v = value >>> 0;
  for (;;) {
    if (v < 0x80) {
      out.push(v);
      return out;
    }
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
}

/** tag = (fieldNumber << 3) | wireType */
function tag(field: number, wireType: number): number[] {
  return varint((field << 3) | wireType);
}

function lengthDelimited(field: number, payload: Uint8Array): Uint8Array {
  return concat([
    Uint8Array.from(tag(field, 2)),
    Uint8Array.from(varint(payload.length)),
    payload,
  ]);
}

function stringField(field: number, value: string): Uint8Array {
  return lengthDelimited(field, new TextEncoder().encode(value));
}

/** fixed64 (wire type 1) from a BigInt (time_unix_nano). */
function fixed64Field(field: number, value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, value, true);
  return concat([Uint8Array.from(tag(field, 1)), buf]);
}

/** double (wire type 1) — NumberDataPoint.as_double. */
function doubleField(field: number, value: number): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setFloat64(0, value, true);
  return concat([Uint8Array.from(tag(field, 1)), buf]);
}

function varintField(field: number, value: number): Uint8Array {
  return concat([Uint8Array.from(tag(field, 0)), Uint8Array.from(varint(value))]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** common.v1.KeyValue { key=1, value=2 AnyValue{ string_value=1 } } */
function keyValue(key: string, value: string): Uint8Array {
  const anyValue = stringField(1, value); // AnyValue.string_value
  return concat([stringField(1, key), lengthDelimited(2, anyValue)]);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

interface StreamState {
  readonly metricName: string;
  readonly dimensions: Readonly<Record<string, string>>;
  total: number;
  readonly startTimeUnixNano: bigint;
}

export interface OtlpMetricsOptions {
  /**
   * Full OTLP metrics URL — e.g. Cockpit's
   * `https://<data-source-id>.metrics.cockpit.fr-par.scw.cloud/otlp/v1/metrics`
   * or a collector's `http://otel-collector:4318/v1/metrics`.
   */
  readonly endpoint: string;
  /** Cockpit token / collector credential. Omit for unauthenticated collectors. */
  readonly authToken?: string;
  /**
   * How to send the token. Cockpit documents `Authorization: Bearer`
   * (default); `x-token` covers deployments preferring the X-Token form.
   */
  readonly authHeader?: "authorization-bearer" | "x-token";
  /** OTLP resource attributes (e.g. service.name, deployment env). */
  readonly resourceAttributes?: Readonly<Record<string, string>>;
  /** Export cadence. Default 15 000 ms. 0 disables the timer (manual flush). */
  readonly flushIntervalMs?: number;
  /** Injectable fetch (tests). Default global fetch. */
  readonly fetchFn?: typeof fetch;
  /** Injectable clock returning ms-since-epoch. Default Date.now. */
  readonly clock?: () => number;
  /** Failure sink. Default: console.error once per process. */
  readonly onError?: (err: unknown) => void;
}

let warnedOnce = false;

/**
 * MetricsPort → OTLP cumulative-sum exporter. See module header.
 */
export class OtlpMetrics implements MetricsPort {
  private readonly options: OtlpMetricsOptions;
  private readonly clock: () => number;
  private readonly streams = new Map<string, StreamState>();
  private timer: NodeJS.Timeout | null = null;
  private exporting = false;

  constructor(options: OtlpMetricsOptions) {
    if (!options.endpoint) {
      // Fail closed at construction — a half-configured exporter that
      // silently dropped every metric would defeat the alarms built on it.
      throw new Error("OtlpMetrics requires an endpoint");
    }
    this.options = options;
    this.clock = options.clock ?? Date.now;
    const interval = options.flushIntervalMs ?? 15_000;
    if (interval > 0) {
      this.timer = setInterval(() => {
        void this.flush();
      }, interval);
      // Never keep the process alive for metrics.
      this.timer.unref?.();
    }
  }

  emitCounts(
    dimensions: Readonly<Record<string, string>>,
    metrics: readonly MetricDatum[],
  ): void {
    try {
      const dimKey = JSON.stringify(
        Object.keys(dimensions)
          .sort()
          .map((k) => [k, dimensions[k]]),
      );
      const nowNano = BigInt(Math.round(this.clock())) * 1_000_000n;
      for (const metric of metrics) {
        const key = `${metric.name}|${dimKey}`;
        const stream = this.streams.get(key);
        if (stream) {
          stream.total += metric.value;
        } else {
          this.streams.set(key, {
            metricName: metric.name,
            dimensions,
            total: metric.value,
            startTimeUnixNano: nowNano,
          });
        }
      }
    } catch (err) {
      this.reportError(err); // fail-open, always
    }
  }

  /**
   * Export the current cumulative state. Safe to call concurrently with
   * emits; overlapping flushes coalesce (a flush already in flight wins).
   * Never throws.
   */
  async flush(): Promise<void> {
    if (this.exporting || this.streams.size === 0) return;
    this.exporting = true;
    try {
      const body = this.encodeRequest();
      const headers: Record<string, string> = {
        "Content-Type": "application/x-protobuf",
      };
      if (this.options.authToken) {
        if ((this.options.authHeader ?? "authorization-bearer") === "x-token") {
          headers["X-Token"] = this.options.authToken;
        } else {
          headers.Authorization = `Bearer ${this.options.authToken}`;
        }
      }
      const fetchFn = this.options.fetchFn ?? fetch;
      const response = await fetchFn(this.options.endpoint, {
        method: "POST",
        headers,
        // Cast: the ambient fetch typings' BodyInit doesn't unify with
        // Uint8Array<ArrayBufferLike> under the current TS lib set, but the
        // runtime (undici) accepts a Uint8Array body as-is.
        body: body as unknown as BodyInit,
      });
      if (!response.ok) {
        this.reportError(
          new Error(
            `OTLP export failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`,
          ),
        );
      }
    } catch (err) {
      this.reportError(err);
    } finally {
      this.exporting = false;
    }
  }

  /** Stop the timer and push a final export. */
  async shutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  private reportError(err: unknown): void {
    if (this.options.onError) {
      this.options.onError(err);
      return;
    }
    if (!warnedOnce) {
      warnedOnce = true;
      console.error("[OtlpMetrics] metric export failing (fail-open):", err);
    }
  }

  /** Build the ExportMetricsServiceRequest for the current streams. */
  private encodeRequest(): Uint8Array {
    const nowNano = BigInt(Math.round(this.clock())) * 1_000_000n;

    // Group streams by metric name → one Metric with N data points.
    const byMetric = new Map<string, StreamState[]>();
    for (const stream of this.streams.values()) {
      const list = byMetric.get(stream.metricName);
      if (list) list.push(stream);
      else byMetric.set(stream.metricName, [stream]);
    }

    const metrics: Uint8Array[] = [];
    for (const [name, streams] of byMetric) {
      const dataPoints = streams.map((stream) => {
        const attrs = Object.entries(stream.dimensions).map(([k, v]) =>
          lengthDelimited(7, keyValue(k, v)),
        );
        return lengthDelimited(
          1, // Sum.data_points
          concat([
            ...attrs,
            fixed64Field(2, stream.startTimeUnixNano), // start_time_unix_nano
            fixed64Field(3, nowNano), // time_unix_nano
            doubleField(4, stream.total), // as_double
          ]),
        );
      });
      const sum = concat([
        ...dataPoints,
        varintField(2, 2), // aggregation_temporality = CUMULATIVE(2)
        varintField(3, 1), // is_monotonic = true
      ]);
      metrics.push(
        lengthDelimited(
          2, // ScopeMetrics.metrics
          concat([
            stringField(1, name), // Metric.name
            lengthDelimited(7, sum), // Metric.sum
          ]),
        ),
      );
    }

    const scope = lengthDelimited(1, stringField(1, "trellis-metrics")); // InstrumentationScope.name
    const scopeMetrics = lengthDelimited(2, concat([scope, ...metrics])); // ResourceMetrics.scope_metrics

    const resourceAttrs = Object.entries(this.options.resourceAttributes ?? {}).map(
      ([k, v]) => lengthDelimited(1, keyValue(k, v)), // Resource.attributes
    );
    const resource = lengthDelimited(1, concat(resourceAttrs)); // ResourceMetrics.resource

    const resourceMetrics = lengthDelimited(1, concat([resource, scopeMetrics]));
    return resourceMetrics; // ExportMetricsServiceRequest.resource_metrics = 1
  }
}
