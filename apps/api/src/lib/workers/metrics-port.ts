/**
 * MetricsPort — provider-neutral metric emission for extracted worker cores
 * (WS-2 §5.2).
 *
 * Powertools `Metrics` emits EMF (embedded metric format) that only CloudWatch
 * consumes. Extracted cores emit through this port instead:
 *
 * - AWS entrypoints inject an EMF-backed adapter (wraps powertools `Metrics`)
 *   so the CloudWatch alarms (`PruneFailed`, `PruneCircuitBreakerTripped`,
 *   deletion `FailedCount`, …) keep working byte-identically.
 * - The worker container injects an OTel/Cockpit adapter (WS-5) or
 *   {@link noopMetrics} until that lands.
 *
 * `emitCounts` is the grouped primitive: one call = one metric blob sharing one
 * dimension set. This mirrors powertools' `singleMetric()` /
 * `publishStoredMetrics()` grouping exactly, which is what keeps the AWS EMF
 * output byte-identical after extraction (three counts on one blob must not
 * become three blobs).
 */

export interface MetricDatum {
  readonly name: string;
  /** Count value (all current emissions are Count-unit). */
  readonly value: number;
}

export interface MetricsPort {
  /**
   * Emit a group of Count metrics sharing one dimension set as ONE metric
   * blob. Implementations must be fail-open: a metrics failure never affects
   * the worker's disposition (adapters catch + log internally).
   */
  emitCounts(
    dimensions: Readonly<Record<string, string>>,
    metrics: readonly MetricDatum[],
  ): void;
}

/** No-op adapter for tests and profiles without a metrics backend. */
export const noopMetrics: MetricsPort = {
  emitCounts: () => {},
};

/** In-memory capture adapter for unit tests. */
export class CapturingMetrics implements MetricsPort {
  readonly emitted: Array<{
    dimensions: Readonly<Record<string, string>>;
    metrics: readonly MetricDatum[];
  }> = [];

  emitCounts(
    dimensions: Readonly<Record<string, string>>,
    metrics: readonly MetricDatum[],
  ): void {
    this.emitted.push({ dimensions, metrics });
  }
}
