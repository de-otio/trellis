/**
 * HTTP Server Entry Point
 *
 * Wraps the existing route handlers (originally for Cloudflare Workers) in a
 * Node.js HTTP server. Converts Node IncomingMessage <-> Web Fetch API Request/Response
 * so all handler code works unchanged.
 *
 * Verticals call registerExtension() before startServer().
 * See the Trellis repo for an example.
 */

import http from "node:http";
import { buildEnv, validateEnv } from "./env.js";
import { validateBootEnv } from "./env-schema.js";
import { buildHonoApp } from "./lib/app.js";
import { getLogger, Logger } from "./lib/logger.js";
import { TrellisRequestContextManager } from "./lib/request-context.js";
import { SessionManager } from "./lib/session-cookie.js";
import { getExtensions } from "./extensions.js";
import { validateExtensions } from "./lib/extension-validator.js";

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB
const REQUEST_TIMEOUT_MS = 25_000; // 25 seconds

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("PAYLOAD_TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function startServer(): Promise<http.Server> {
  const PORT = parseInt(process.env.PORT || "3000", 10);

  // AR12 — boot-time env validation (Zod, src/env-schema.ts): fail fast,
  // naming the missing/invalid key, BEFORE any AWS client is constructed or
  // secret resolution is attempted. Dev-only-overridable keys (SESSION_SALT,
  // MEDIA_THRESHOLDS_JSON) are enforced only when STAGE === "prod".
  const bootIssues = validateBootEnv(process.env);
  if (bootIssues.length > 0) {
    console.error("Environment validation failed at boot:");
    for (const issue of bootIssues) {
      console.error(`  - ${issue}`);
    }
    process.exit(1);
  }

  const env = await buildEnv();

  // S1.4 — Validate critical environment variables at startup
  const envErrors = validateEnv(env);
  if (envErrors.length > 0) {
    console.error("Environment validation failed:");
    for (const err of envErrors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }
  const logger = getLogger();

  // Validate extensions
  const extensions = getExtensions();
  validateExtensions([...extensions]);

  // Validate extension config schemas against scoped env vars
  for (const ext of extensions) {
    if (ext.configSchema && "shape" in ext.configSchema) {
      const scopedEnv: Record<string, string | undefined> = {};
      for (const key of Object.keys((ext.configSchema as any).shape)) {
        scopedEnv[key] = process.env[key];
      }
      const result = ext.configSchema.safeParse(scopedEnv);
      if (!result.success) {
        console.error(`Extension "${ext.id}" config invalid:`, result.error);
        process.exit(1);
      }
    }
  }

  logger.info(
    `Loaded ${extensions.length} extension(s): ${extensions.map((e) => e.id).join(", ")}`,
  );

  // Stream 2.1: Hono app coexists with the legacy router. Built once
  // (stateless); per-request env/context are passed via app.fetch. Requests
  // try Hono first and fall back to the legacy router on a fallthrough 404.
  const honoApp = buildHonoApp();

  // Connection tracking for graceful shutdown
  let activeConnections = 0;

  const server = http.createServer(async (req, res) => {
    const startMs = Date.now();
    const method = req.method || "GET";
    const rawUrl = req.url || "/";
    const host = req.headers.host || `localhost:${PORT}`;

    try {
      const url = new URL(rawUrl, `http://${host}`);

      // Build headers — filter out undefined values
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v) headers[k] = Array.isArray(v) ? v.join(", ") : v;
      }

      // Only include body for methods that have one
      const hasBody = !["GET", "HEAD", "OPTIONS"].includes(method);
      const body = hasBody ? await readBody(req) : undefined;

      const webRequest = new Request(url, {
        method,
        headers,
        body: body && body.byteLength > 0 ? (body as unknown as BodyInit) : undefined,
        // @ts-ignore — duplex required in Node.js 18+ for body streams
        duplex: "half",
      });

      // Build request context (region, session) — non-fatal if it fails
      let requestContext: import("./lib/request-context.js").TrellisRequestContext | undefined;
      try {
        const ctxManager = new TrellisRequestContextManager(env);
        const sessionManager = new SessionManager();
        const secret = env.SESSION_SECRET;
        const session = secret
          ? await sessionManager.getSession(webRequest, secret, env)
          : null;
        requestContext = await ctxManager.createRequestContext(
          webRequest,
          sessionManager,
          session,
        );
      } catch (ctxErr) {
        logger.error("Failed to create request context", ctxErr);
        // Continue without context — some routes (e.g. /health) don't need it
      }

      // Dispatch via Hono (the sole router). Raced against a timeout.
      const dispatch = async (): Promise<Response> =>
        honoApp.fetch(webRequest, { trellisEnv: env, requestContext });

      const timeoutPromise = new Promise<Response>((_, reject) => {
        setTimeout(() => reject(new Error("REQUEST_TIMEOUT")), REQUEST_TIMEOUT_MS);
      });

      const response = await Promise.race([dispatch(), timeoutPromise]);

      if (!response) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }

      // Write response headers
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => { responseHeaders[key] = value; });
      res.writeHead(response.status, responseHeaders);

      // Stream response body
      const buffer = await response.arrayBuffer();
      res.end(Buffer.from(buffer));

      const duration = Date.now() - startMs;
      logger.info(`${method} ${url.pathname} ${response.status} ${duration}ms`);
    } catch (err: any) {
      const duration = Date.now() - startMs;

      if (err?.message === "PAYLOAD_TOO_LARGE") {
        logger.warn(`${method} ${rawUrl} 413 ${duration}ms — payload too large`);
        if (!res.headersSent) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Payload too large" }));
        }
        return;
      }

      if (err?.message === "REQUEST_TIMEOUT") {
        logger.warn(`${method} ${rawUrl} 504 ${duration}ms — request timeout`);
        if (!res.headersSent) {
          res.writeHead(504, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Gateway timeout" }));
        }
        return;
      }

      logger.error(`${method} ${rawUrl} 500 ${duration}ms`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  // Track active connections for graceful shutdown
  server.on("connection", (conn) => {
    activeConnections++;
    conn.on("close", () => {
      activeConnections--;
    });
  });

  // Graceful shutdown — drain HTTP connections, then close database pools
  async function shutdown() {
    logger.info(`Shutting down... (${activeConnections} active connections)`);
    server.close(async () => {
      try {
        // Shutdown extensions
        for (const ext of extensions) {
          if (ext.shutdown) {
            try {
              await ext.shutdown();
            } catch (err: any) {
              logger.error(`Extension "${ext.id}" shutdown failed`, { error: err?.message });
            }
          }
        }
        const { sharedDatabaseConnectionManager } = await import("./lib/database-connection-manager.js");
        await sharedDatabaseConnectionManager.shutdown();
        const { closeSharedGraphService } = await import("./lib/graph/index.js");
        await closeSharedGraphService();
        logger.info("Server and database pools closed");
      } catch (err: any) {
        logger.error("Error shutting down database pools", { error: err?.message });
      }
      process.exit(0);
    });
    setTimeout(() => {
      logger.error(`Forced shutdown after 10s (${activeConnections} connections remaining)`);
      process.exit(1);
    }, 10000);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Warm the primary DB connection pool BEFORE accepting traffic, so the first
  // real request doesn't pay cold-start (pool-init + TLS-handshake) latency.
  // Best-effort and non-fatal: warmup() never throws — if the DB is briefly
  // unreachable at boot the pool warms on first use instead.
  {
    const { sharedDatabaseConnectionManager } = await import(
      "./lib/database-connection-manager.js"
    );
    await sharedDatabaseConnectionManager.warmup("primary", env);
  }

  server.listen(PORT, () => {
    logger.info(`Trellis API listening on port ${PORT}`);
  });

  return server;
}

// Auto-start only when this exact file is the entry point (not when imported as @de-otio/trellis)
const entryFile = process.argv[1];
const thisFile = import.meta.filename;
if (entryFile === thisFile) {
  startServer().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}
