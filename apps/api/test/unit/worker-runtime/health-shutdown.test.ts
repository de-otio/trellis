/**
 * T7c — hardened health endpoint (finding 10) + graceful drain (§3.5).
 */

import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { startHealthServer } from "../../../../worker/src/health.js";
import { installShutdownHandlers } from "../../../../worker/src/shutdown.js";
import { QueuePoller } from "../../../../worker/src/consumer.js";
import { FakeQueue } from "./fake-queue.js";
import type { Logger } from "../../../src/lib/logger.js";

function makeLogger(): Logger {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function fetchText(port: number, path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.text() };
}

describe("health server (finding 10)", () => {
  it("healthz: fixed body 200; readyz: fixed 'ready'/'unready' — NEVER diagnostics", async () => {
    const port = await freePort();
    let ready = true;
    const server = startHealthServer({
      port,
      isReady: () => ready,
      logger: makeLogger(),
    });
    await sleep(50);
    try {
      expect(await fetchText(port, "/healthz")).toEqual({ status: 200, body: "ok" });
      expect(await fetchText(port, "/readyz")).toEqual({ status: 200, body: "ready" });

      ready = false;
      expect(await fetchText(port, "/readyz")).toEqual({ status: 503, body: "unready" });
    } finally {
      server.close();
    }
  });

  it("a THROWING readiness probe reports fixed-body 503 — the error text never leaks", async () => {
    const port = await freePort();
    const logger = makeLogger();
    const server = startHealthServer({
      port,
      isReady: () => {
        throw new Error("SECRET-DB-HOST-12345 connection refused");
      },
      logger,
    });
    await sleep(50);
    try {
      const res = await fetchText(port, "/readyz");
      expect(res.status).toBe(503);
      expect(res.body).toBe("unready");
      expect(res.body).not.toContain("SECRET");
      // Diagnostics went to the log instead.
      expect(logger.warn).toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("unknown paths are fixed-body 404 (no route reflection)", async () => {
    const port = await freePort();
    const server = startHealthServer({ port, isReady: () => true, logger: makeLogger() });
    await sleep(50);
    try {
      const res = await fetchText(port, "/debug/queues?x=1");
      expect(res.status).toBe(404);
      expect(res.body).toBe("not found");
    } finally {
      server.close();
    }
  });

  it("binds loopback by default (finding 10b)", async () => {
    const port = await freePort();
    const server = startHealthServer({ port, isReady: () => true, logger: makeLogger() });
    await sleep(50);
    try {
      const addr = server.address() as { address: string };
      expect(addr.address).toBe("127.0.0.1");
    } finally {
      server.close();
    }
  });
});

describe("graceful drain (§3.5)", () => {
  it("SIGTERM mid-message: in-flight work finishes and is acked; nothing lost; pools closed; exit(0)", async () => {
    const q = new FakeQueue();
    q.enqueue(JSON.stringify({ n: 1 }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const poller = new QueuePoller(
      q,
      async () => {
        await gate;
        return "ack";
      },
      { queueName: "q", concurrency: 1, logger: makeLogger() },
    );
    poller.start();
    while (poller.inFlightCount === 0) await sleep(5);

    const closeResources = vi.fn(async () => {});
    const exit = vi.fn();
    const { shutdown } = installShutdownHandlers({
      scheduler: { stop: vi.fn(async () => {}) },
      pollers: [poller],
      drainTimeoutMs: 2000,
      logger: makeLogger(),
      closeResources,
      exit,
    });

    const done = shutdown("SIGTERM");
    await sleep(20);
    release(); // in-flight message finishes inside the drain window
    await done;

    expect(q.deleted).toHaveLength(1); // finished work was acked — not lost
    expect(q.remaining).toBe(0);
    expect(closeResources).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("a wedged in-flight message is NOT acked after the drain window (redelivers — at-least-once)", async () => {
    const q = new FakeQueue();
    q.enqueue(JSON.stringify({ n: 1 }));
    const never = new Promise<never>(() => {});
    const poller = new QueuePoller(
      q,
      async () => {
        await never;
        return "ack";
      },
      { queueName: "q", concurrency: 1, logger: makeLogger() },
    );
    poller.start();
    while (poller.inFlightCount === 0) await sleep(5);

    const exit = vi.fn();
    const logger = makeLogger();
    const { shutdown } = installShutdownHandlers({
      scheduler: { stop: vi.fn(async () => {}) },
      pollers: [poller],
      drainTimeoutMs: 50, // tiny window: the message will NOT finish
      logger,
      closeResources: vi.fn(async () => {}),
      exit,
    });

    await shutdown("SIGTERM");

    expect(q.deleted).toHaveLength(0); // never acked
    expect(q.inflight.size).toBe(1); // → visibility timeout → redelivery
    expect(exit).toHaveBeenCalledWith(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("drain window elapsed"),
      expect.anything(),
    );
  });

  it("shutdown is idempotent (second signal is a no-op)", async () => {
    const exit = vi.fn();
    const stop = vi.fn(async () => {});
    const { shutdown } = installShutdownHandlers({
      scheduler: { stop },
      pollers: [],
      drainTimeoutMs: 100,
      logger: makeLogger(),
      exit,
    });
    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
