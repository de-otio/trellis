/**
 * health.ts — hardened liveness/readiness endpoint (WS-2 T7c, finding 10).
 *
 * - `GET /healthz` — process alive. Fixed body `ok` / 200.
 * - `GET /readyz`  — pollers running + a readiness probe (DB reachable).
 *   Fixed body `ready` / 200 or `unready` / 503.
 *
 * FINDING 10 (all three are load-bearing):
 *  (a) FIXED BODIES ONLY — never error text, secret-resolution state, queue
 *      URLs, DB host, versions, or any infra detail. A probe is a liveness
 *      signal, not a diagnostics endpoint; structured logs carry diagnostics.
 *  (b) binds to loopback / the internal pod network ONLY (default
 *      127.0.0.1) — never a public interface.
 *  (c) the WS-4 `workers` module must NOT attach this port to any public
 *      LB/ingress (verified in T8's wiring inputs).
 */

import { createServer, type Server } from "node:http";
import type { Logger } from "../../api/src/lib/logger.js";

export interface HealthServerOptions {
  /** Bind host. MUST stay loopback/internal (finding 10b). */
  readonly host?: string;
  readonly port: number;
  /** Readiness probe: true ⇒ ready. Errors count as NOT ready (fail-closed)
   *  but are logged, never echoed. */
  readonly isReady: () => Promise<boolean> | boolean;
  readonly logger: Logger;
}

const BODY_OK = "ok";
const BODY_READY = "ready";
const BODY_UNREADY = "unready";
const BODY_NOT_FOUND = "not found";

export function startHealthServer(options: HealthServerOptions): Server {
  const host = options.host ?? "127.0.0.1";
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "text/plain" });
        res.end(BODY_NOT_FOUND);
        return;
      }
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(BODY_OK);
        return;
      }
      if (req.url === "/readyz") {
        let ready = false;
        try {
          ready = await options.isReady();
        } catch (err) {
          // Diagnostics go to the LOG, never the response body (finding 10a).
          options.logger.warn("readiness probe errored — reporting unready", {
            error: err,
          });
          ready = false;
        }
        if (ready) {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end(BODY_READY);
        } else {
          res.writeHead(503, { "content-type": "text/plain" });
          res.end(BODY_UNREADY);
        }
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(BODY_NOT_FOUND);
    })();
  });
  server.listen(options.port, host, () => {
    options.logger.info("health server listening", { host, port: options.port });
  });
  return server;
}
