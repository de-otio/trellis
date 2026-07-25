/**
 * Unit tests: OTLP metrics adapter (WS-5).
 *
 * The exported protobuf is verified with a small wire-format reader
 * below (varint / length-delimited / 64-bit fields per the protobuf
 * spec; field numbers per opentelemetry-proto metrics.proto v1) — so
 * these tests fail if the hand-rolled encoder drifts from the proto.
 * All HTTP goes through an injected fake fetch; the clock is frozen.
 */

import { describe, expect, it, vi } from "vitest";

import { OtlpMetrics } from "../../../src/lib/metrics/otlp-metrics.js";

// ---------------------------------------------------------------------------
// Minimal protobuf wire reader (test-side decoder).
// ---------------------------------------------------------------------------

interface Field {
  field: number;
  wireType: number;
  value: number | bigint | Uint8Array;
}

function readVarint(buf: Uint8Array, pos: number): { value: number; pos: number } {
  let value = 0;
  let shift = 0;
  for (;;) {
    const byte = buf[pos++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, pos };
    shift += 7;
  }
}

function readFields(buf: Uint8Array): Field[] {
  const fields: Field[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const tagRead = readVarint(buf, pos);
    pos = tagRead.pos;
    const field = tagRead.value >>> 3;
    const wireType = tagRead.value & 0x7;
    if (wireType === 0) {
      const v = readVarint(buf, pos);
      fields.push({ field, wireType, value: v.value });
      pos = v.pos;
    } else if (wireType === 1) {
      const view = new DataView(buf.buffer, buf.byteOffset + pos, 8);
      fields.push({ field, wireType, value: view.getBigUint64(0, true) });
      pos += 8;
    } else if (wireType === 2) {
      const len = readVarint(buf, pos);
      pos = len.pos;
      fields.push({ field, wireType, value: buf.slice(pos, pos + len.value) });
      pos += len.value;
    } else {
      throw new Error(`unexpected wire type ${wireType}`);
    }
  }
  return fields;
}

const sub = (f: Field): Uint8Array => f.value as Uint8Array;
const str = (f: Field): string => new TextDecoder().decode(sub(f));
const f64 = (f: Field): number => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, f.value as bigint, true);
  return new DataView(bytes.buffer).getFloat64(0, true);
};

/** Decode the request into a comparable JS structure. */
function decodeExport(body: Uint8Array) {
  const resourceMetrics = readFields(body).filter((f) => f.field === 1);
  expect(resourceMetrics).toHaveLength(1);
  const rmFields = readFields(sub(resourceMetrics[0]));

  const resourceField = rmFields.find((f) => f.field === 1);
  const resourceAttrs: Record<string, string> = {};
  if (resourceField) {
    for (const attr of readFields(sub(resourceField)).filter((f) => f.field === 1)) {
      const kv = readFields(sub(attr));
      const key = str(kv.find((f) => f.field === 1)!);
      const anyValue = readFields(sub(kv.find((f) => f.field === 2)!));
      resourceAttrs[key] = str(anyValue.find((f) => f.field === 1)!);
    }
  }

  const scopeMetrics = rmFields.find((f) => f.field === 2)!;
  const smFields = readFields(sub(scopeMetrics));
  const scope = readFields(sub(smFields.find((f) => f.field === 1)!));
  const scopeName = str(scope.find((f) => f.field === 1)!);

  const metrics = smFields
    .filter((f) => f.field === 2)
    .map((metricField) => {
      const mFields = readFields(sub(metricField));
      const name = str(mFields.find((f) => f.field === 1)!);
      const sumFields = readFields(sub(mFields.find((f) => f.field === 7)!));
      const temporality = sumFields.find((f) => f.field === 2)!.value as number;
      const isMonotonic = sumFields.find((f) => f.field === 3)!.value as number;
      const dataPoints = sumFields
        .filter((f) => f.field === 1)
        .map((dp) => {
          const dpFields = readFields(sub(dp));
          const attrs: Record<string, string> = {};
          for (const attr of dpFields.filter((f) => f.field === 7)) {
            const kv = readFields(sub(attr));
            const key = str(kv.find((f) => f.field === 1)!);
            const anyValue = readFields(sub(kv.find((f) => f.field === 2)!));
            attrs[key] = str(anyValue.find((f) => f.field === 1)!);
          }
          return {
            attrs,
            startTime: dpFields.find((f) => f.field === 2)!.value as bigint,
            time: dpFields.find((f) => f.field === 3)!.value as bigint,
            value: f64(dpFields.find((f) => f.field === 4)!),
          };
        });
      return { name, temporality, isMonotonic, dataPoints };
    });

  return { resourceAttrs, scopeName, metrics };
}

// ---------------------------------------------------------------------------

function makeAdapter(overrides: Partial<ConstructorParameters<typeof OtlpMetrics>[0]> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => "" } as Response;
  }) as unknown as typeof fetch;
  const clockRef = { current: 1_000_000 };
  const errors: unknown[] = [];
  const adapter = new OtlpMetrics({
    endpoint: "https://dsid.metrics.cockpit.fr-par.scw.cloud/otlp/v1/metrics",
    authToken: "cockpit-token",
    flushIntervalMs: 0, // manual flush in tests
    fetchFn,
    clock: () => clockRef.current,
    onError: (e) => errors.push(e),
    ...overrides,
  });
  return { adapter, calls, clockRef, errors, fetchFn };
}

describe("OtlpMetrics — export shape", () => {
  it("exports grouped counts as cumulative monotonic sums with dimension attributes", async () => {
    const { adapter, calls } = makeAdapter({
      resourceAttributes: { "service.name": "trellis-worker" },
    });

    adapter.emitCounts({ service: "prune", stage: "dev" }, [
      { name: "PruneFailed", value: 2 },
      { name: "PruneSucceeded", value: 5 },
    ]);
    await adapter.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://dsid.metrics.cockpit.fr-par.scw.cloud/otlp/v1/metrics",
    );
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-protobuf");
    expect(headers.Authorization).toBe("Bearer cockpit-token");

    const decoded = decodeExport(calls[0].init.body as Uint8Array);
    expect(decoded.resourceAttrs).toEqual({ "service.name": "trellis-worker" });
    expect(decoded.scopeName).toBe("trellis-metrics");
    expect(decoded.metrics.map((m) => m.name).sort()).toEqual([
      "PruneFailed",
      "PruneSucceeded",
    ]);
    for (const metric of decoded.metrics) {
      expect(metric.temporality).toBe(2); // CUMULATIVE
      expect(metric.isMonotonic).toBe(1);
      expect(metric.dataPoints).toHaveLength(1);
      expect(metric.dataPoints[0].attrs).toEqual({ service: "prune", stage: "dev" });
    }
    const failed = decoded.metrics.find((m) => m.name === "PruneFailed")!;
    expect(failed.dataPoints[0].value).toBe(2);
  });

  it("accumulates across emits (cumulative), keeps a stable start time, advances time", async () => {
    const { adapter, calls, clockRef } = makeAdapter();

    adapter.emitCounts({ service: "deletion" }, [{ name: "FailedCount", value: 1 }]);
    clockRef.current = 2_000_000;
    adapter.emitCounts({ service: "deletion" }, [{ name: "FailedCount", value: 3 }]);
    await adapter.flush();

    const first = decodeExport(calls[0].init.body as Uint8Array);
    const dp1 = first.metrics[0].dataPoints[0];
    expect(dp1.value).toBe(4); // 1 + 3, cumulative
    expect(dp1.startTime).toBe(1_000_000n * 1_000_000n); // stream creation
    expect(dp1.time).toBe(2_000_000n * 1_000_000n);

    // Second flush still reports the running total (not reset to 0).
    clockRef.current = 3_000_000;
    adapter.emitCounts({ service: "deletion" }, [{ name: "FailedCount", value: 1 }]);
    await adapter.flush();
    const second = decodeExport(calls[1].init.body as Uint8Array);
    expect(second.metrics[0].dataPoints[0].value).toBe(5);
    expect(second.metrics[0].dataPoints[0].startTime).toBe(1_000_000n * 1_000_000n);
  });

  it("keeps separate streams per dimension set under one metric name", async () => {
    const { adapter, calls } = makeAdapter();
    adapter.emitCounts({ queue: "media" }, [{ name: "Handled", value: 1 }]);
    adapter.emitCounts({ queue: "deletion" }, [{ name: "Handled", value: 7 }]);
    await adapter.flush();

    const decoded = decodeExport(calls[0].init.body as Uint8Array);
    expect(decoded.metrics).toHaveLength(1);
    const points = decoded.metrics[0].dataPoints;
    expect(points).toHaveLength(2);
    const byQueue = Object.fromEntries(points.map((p) => [p.attrs.queue, p.value]));
    expect(byQueue).toEqual({ media: 1, deletion: 7 });
  });

  it("supports the X-Token auth header variant", async () => {
    const { adapter, calls } = makeAdapter({ authHeader: "x-token" });
    adapter.emitCounts({}, [{ name: "M", value: 1 }]);
    await adapter.flush();
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["X-Token"]).toBe("cockpit-token");
    expect(headers.Authorization).toBeUndefined();
  });
});

describe("OtlpMetrics — fail-open contract", () => {
  it("emitCounts never throws and flush swallows network failures into onError", async () => {
    const errors: unknown[] = [];
    const adapter = new OtlpMetrics({
      endpoint: "http://collector.invalid/v1/metrics",
      flushIntervalMs: 0,
      fetchFn: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
      clock: () => 0,
      onError: (e) => errors.push(e),
    });

    expect(() => adapter.emitCounts({}, [{ name: "M", value: 1 }])).not.toThrow();
    await expect(adapter.flush()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it("non-2xx export responses are reported, not thrown, and state is retained", async () => {
    const errors: unknown[] = [];
    let status = 500;
    const calls: Array<Uint8Array> = [];
    const adapter = new OtlpMetrics({
      endpoint: "http://collector.invalid/v1/metrics",
      flushIntervalMs: 0,
      fetchFn: vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(init.body as Uint8Array);
        return { ok: status < 400, status, text: async () => "err" } as Response;
      }) as unknown as typeof fetch,
      clock: () => 1000,
      onError: (e) => errors.push(e),
    });

    adapter.emitCounts({}, [{ name: "M", value: 2 }]);
    await adapter.flush();
    expect(errors).toHaveLength(1);

    // Cumulative state survives a failed export; the next flush re-sends it.
    status = 200;
    await adapter.flush();
    const decoded = decodeExport(calls[1]);
    expect(decoded.metrics[0].dataPoints[0].value).toBe(2);
  });

  it("flush with no streams is a no-op (no empty export)", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.flush();
    expect(calls).toHaveLength(0);
  });

  it("fails closed at construction on a missing endpoint", () => {
    expect(
      () => new OtlpMetrics({ endpoint: "" } as ConstructorParameters<typeof OtlpMetrics>[0]),
    ).toThrow(/endpoint/);
  });

  it("shutdown stops the timer and performs a final export", async () => {
    const calls: Array<Uint8Array> = [];
    const adapter = new OtlpMetrics({
      endpoint: "http://collector.invalid/v1/metrics",
      flushIntervalMs: 60_000,
      fetchFn: vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(init.body as Uint8Array);
        return { ok: true, status: 200, text: async () => "" } as Response;
      }) as unknown as typeof fetch,
      clock: () => 1000,
    });
    adapter.emitCounts({}, [{ name: "M", value: 1 }]);
    await adapter.shutdown();
    expect(calls).toHaveLength(1);
  });
});
