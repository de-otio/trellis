/**
 * EMF-backed MetricsPort adapter (WS-2 §5.2) — AWS entrypoints ONLY.
 *
 * Wraps a powertools `Metrics` instance so the extracted cores' `MetricsPort`
 * emissions produce byte-identical EMF to the pre-extraction handlers:
 *
 * - non-empty dimensions → `singleMetric()` + `addDimension` per dim +
 *   `addMetric` per datum (one immediate EMF blob — hourly-cron's per-table
 *   retention metrics, e2e-sweeper's Stage-dimensioned count);
 * - empty dimensions → `addMetric` per datum + `publishStoredMetrics()`
 *   (nightly-cron's deletion counters).
 *
 * Fail-open: a metrics failure never affects the worker's disposition.
 */

import { MetricUnit, type Metrics } from "@aws-lambda-powertools/metrics";
import type { MetricsPort } from "../lib/workers/metrics-port.js";

export function makeEmfMetricsPort(metrics: Metrics): MetricsPort {
  return {
    emitCounts(dimensions, data) {
      try {
        if (Object.keys(dimensions).length > 0) {
          const m = metrics.singleMetric();
          for (const [name, value] of Object.entries(dimensions)) {
            m.addDimension(name, value);
          }
          for (const d of data) {
            m.addMetric(d.name, MetricUnit.Count, d.value);
          }
        } else {
          for (const d of data) {
            metrics.addMetric(d.name, MetricUnit.Count, d.value);
          }
          metrics.publishStoredMetrics();
        }
      } catch {
        // Fail-open by contract (metrics are observability, never control flow).
      }
    },
  };
}
