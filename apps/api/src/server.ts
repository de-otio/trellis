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
import { randomUUID } from "node:crypto";
import type { CrossTenantReadDelegate } from "@de-otio/trellis-extension-api";
import type { RawPrismaLike } from "./lib/extension-scoped-db.js";
import { buildEnv, validateEnv } from "./env.js";
import { startExtensionJobRunners } from "./lib/extension-job-runner.js";
import { validateBootEnv } from "./env-schema.js";
import { verifyKeycloakProfileLockdownAtBoot } from "./lib/identity/identity-provider.js";
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

  // [F3] Startup health-check (Keycloak only): verify the realm's User Profile
  // config locks the privilege-bearing custom:* attributes admin-edit-only, so
  // a user cannot self-assign roles / switch active tenant by editing their own
  // profile. Fail boot otherwise. Bypassable ONLY via
  // KC_SKIP_PROFILE_LOCKDOWN_CHECK=true (logs a loud warning). No-op on Cognito.
  try {
    await verifyKeycloakProfileLockdownAtBoot(logger);
  } catch (err) {
    console.error("Keycloak user-profile lockdown check failed at boot:");
    console.error(`  - ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

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

  // O-1: in-process extension job runner (design §5.2/§12.4 item 2). Declared
  // jobs run HERE (the API container is the only process that loads extensions;
  // worker Lambdas load none), single-flighted cluster-wide by a DynamoDB
  // conditional-put lock. Clock + uuid + DynamoDB client are injected. No-ops
  // cleanly when no extension declares a job (the O-1 v1 reality — dogs owns no
  // jobs yet). L1's enforce-always tenant-scoped-DB factory is wired into
  // `scopedDbFactory` below (Phase-2 integration): a declared job's
  // `ctx.tenant(tid)` returns a scoped surface bound to that tenant. The scoped
  // model metas are built once from the (currently empty) composed-model
  // registry; they carry only the tenant-scoped core delegates today.
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoKvStore } = await import("@de-otio/saas-foundation/kv");
  const { sharedDatabaseConnectionManager: dbManager } = await import(
    "./lib/database-connection-manager.js"
  );
  const { createScopedDb, buildScopedModelMetas } = await import(
    "./lib/extension-scoped-db.js"
  );
  const scopedModelMetas = buildScopedModelMetas();
  const jobRunnerHandle = startExtensionJobRunners(
    {
      // Single-flight lock via the KvStore port (WS-1 §3.9). Default DynamoKvStore
      // over the byte-compat `job` layout (pk `job:{extId}:{jobId}`, sk `lock`)
      // — zero AWS behavior change; only the additive `_v` version attribute.
      kvStore: new DynamoKvStore(new DynamoDBClient({ region: env.AWS_REGION }), {
        tableName: process.env.DYNAMODB_TABLE ?? `${env.STAGE ?? "dev"}-trellis`,
        pkPrefix: "job",
        pkSeparator: ":",
        skName: "sk",
        skValue: "lock",
        ttlAttr: "ttl",
        versionAttr: "_v",
        allowSeparatorInKey: true,
      }),
      now: () => Date.now(),
      uuid: () => randomUUID(),
      readDelegateSource: (model) => {
        const { client } = dbManager.acquireClient("primary", env);
        return (client as unknown as Record<string, CrossTenantReadDelegate | undefined>)[
          model
        ];
      },
      scopedDbFactory: (tid) => {
        const { client } = dbManager.acquireClient("primary", env);
        // Brand adaptation at the L3→L1 integration boundary: the runner mints
        // the core (saas-foundation) `TenantId`, while L1's `createScopedDb`
        // params the extension-api `TenantId` brand. Both wrap the identical
        // runtime string; the tags are nominal-only. See ASSUMPTIONS A-P2.1.
        return createScopedDb(
          client as unknown as RawPrismaLike,
          tid as unknown as Parameters<typeof createScopedDb>[1],
          scopedModelMetas,
        );
      },
      stage: env.STAGE ?? "dev",
      logger,
    },
    extensions,
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
    // Stop extension job timers first so no new tick starts mid-drain.
    jobRunnerHandle.stop();
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
