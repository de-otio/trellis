/**
 * Tenant Audit Log Routes
 *
 * GET /api/tenants/:id/audit
 *   Paginated, filterable audit log for a specific tenant.
 *   Tenant admins see only their own tenant; SUPER_ADMIN sees all.
 *   Supports JSON (default) and CSV export formats.
 *
 * Query params:
 *   from        ISO-8601 start datetime (inclusive)
 *   to          ISO-8601 end datetime (inclusive)
 *   type        Filter by event type string
 *   format      "json" (default) | "csv"
 *   cursor      Opaque pagination cursor (base64-encoded JSON)
 *   limit       Page size; default 50, max 500 (1000 in SUPER_ADMIN CSV)
 */

import type { Prisma } from "@prisma/client";
import { corsMiddleware } from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import { authMiddleware, requireActiveTenant } from "../auth/auth-middleware.js";
import { renderCsv } from "../audit/csv-export.js";
import { unauthorizedError } from "./errors.js";
import type { Route } from "./types.js";
import type { AuthContext } from "../auth/auth-context.js";
import type { Env } from "../../env.js";

const ROUTE_RE = /^\/api\/tenants\/([^/]+)\/audit$/;

interface AuditQueryParams {
  from?: Date;
  to?: Date;
  type?: string;
  format: "json" | "csv";
  cursor?: { createdAt: string; id: string };
  limit: number;
}

function parseQueryParams(url: URL, isSuperAdmin: boolean): AuditQueryParams | Response {
  const rawFrom = url.searchParams.get("from");
  const rawTo = url.searchParams.get("to");
  const format = url.searchParams.get("format") === "csv" ? "csv" : "json";
  const rawLimit = url.searchParams.get("limit");
  const rawCursor = url.searchParams.get("cursor");
  const type = url.searchParams.get("type") ?? undefined;

  const maxLimit = format === "csv" && isSuperAdmin ? 1000 : 500;
  let limit = 50;
  if (rawLimit) {
    const parsed = parseInt(rawLimit, 10);
    if (isNaN(parsed) || parsed < 1) {
      return new Response(
        JSON.stringify({ error: "VALIDATION_ERROR", message: "limit must be a positive integer" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    limit = Math.min(parsed, maxLimit);
  }

  let from: Date | undefined;
  let to: Date | undefined;
  if (rawFrom) {
    from = new Date(rawFrom);
    if (isNaN(from.getTime())) {
      return new Response(
        JSON.stringify({ error: "VALIDATION_ERROR", message: "from must be a valid ISO-8601 datetime" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
  }
  if (rawTo) {
    to = new Date(rawTo);
    if (isNaN(to.getTime())) {
      return new Response(
        JSON.stringify({ error: "VALIDATION_ERROR", message: "to must be a valid ISO-8601 datetime" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
  }

  let cursor: { createdAt: string; id: string } | undefined;
  if (rawCursor) {
    try {
      cursor = JSON.parse(Buffer.from(rawCursor, "base64").toString("utf8")) as {
        createdAt: string;
        id: string;
      };
    } catch {
      return new Response(
        JSON.stringify({ error: "VALIDATION_ERROR", message: "cursor is invalid" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
  }

  return { from, to, type, format, cursor, limit };
}

async function handleAuditRead(
  tenantId: string,
  auth: AuthContext,
  env: Env,
  url: URL,
): Promise<Response> {
  const denied = requireActiveTenant(auth, tenantId);
  if (denied) return denied;

  const isSuperAdmin = auth.globalRole === "SUPER_ADMIN";
  const params = parseQueryParams(url, isSuperAdmin);
  if (params instanceof Response) return params;

  const { createPrisma } = await import("../../db.js");
  const db = createPrisma(env);

  const where: Prisma.AuditEventWhereInput = {
    tenantId,
  };

  // The `type` query param filters by the audit `action` string (the
  // foundation AuditEvent open-union action; was SecurityEvent.type).
  if (params.type) {
    where.action = params.type;
  }

  if (params.from || params.to) {
    where.timestamp = {};
    if (params.from) where.timestamp.gte = params.from;
    if (params.to) where.timestamp.lte = params.to;
  }

  if (params.cursor) {
    const cursorDate = new Date(params.cursor.createdAt);
    const cursorId = params.cursor.id;
    where.AND = [
      {
        OR: [
          { timestamp: { lt: cursorDate } },
          {
            AND: [
              { timestamp: { equals: cursorDate } },
              { id: { lt: cursorId } },
            ],
          },
        ],
      },
    ];
  }

  const MAX_CSV_ROWS = 10_000;
  const fetchLimit = params.format === "csv" ? MAX_CSV_ROWS : params.limit + 1;

  const events = await db.auditEvent.findMany({
    where,
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    take: fetchLimit,
    select: {
      id: true,
      action: true,
      tenantId: true,
      actorId: true,
      ipAddress: true,
      metadata: true,
      timestamp: true,
    },
  });

  if (params.format === "csv") {
    const rows = events.map((e: {
      id: string;
      action: string;
      tenantId: string | null;
      actorId: string;
      ipAddress: string | null;
      metadata: unknown;
      timestamp: Date;
    }) => ({
      // The audit-event ulid is the canonical event id (was details.eventId).
      eventId: e.id,
      type: e.action,
      tenantId: e.tenantId ?? "",
      actorUserId: e.actorId ?? "",
      createdAt: e.timestamp.toISOString(),
      sourceIp: e.ipAddress ?? "",
      // metadata is a JSON column (already an object) — stringify for the cell.
      payload: e.metadata == null ? "" : JSON.stringify(e.metadata),
    }));

    const csv = renderCsv(rows);
    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="audit-${tenantId}.csv"`,
      },
    });
  }

  const hasMore = events.length > params.limit;
  const page = hasMore ? events.slice(0, params.limit) : events;

  let nextCursor: string | null = null;
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1];
    if (last) {
      nextCursor = Buffer.from(
        JSON.stringify({ createdAt: last.timestamp.toISOString(), id: last.id }),
        "utf8",
      ).toString("base64");
    }
  }

  return new Response(
    JSON.stringify({
      events: page.map((e: {
        id: string;
        action: string;
        tenantId: string | null;
        actorId: string;
        ipAddress: string | null;
        metadata: unknown;
        timestamp: Date;
      }) => ({
        id: e.id,
        type: e.action,
        tenantId: e.tenantId,
        actorUserId: e.actorId,
        sourceIp: e.ipAddress,
        // metadata is a JSON column — already structured, return as-is.
        payload: e.metadata ?? null,
        createdAt: e.timestamp.toISOString(),
      })),
      nextCursor,
      hasMore,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

export const tenantAuditRoutes: Route[] = [
  {
    path: ROUTE_RE,
    method: "GET",
    handler: async (request, env, { pathname, url }) => {
      const securityHeaders = new SecurityHeaders(env);

      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);

      const tenantId = pathname.match(ROUTE_RE)?.[1] ?? "";
      const response = await handleAuditRead(tenantId, auth, env, url);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware()],
    description: "Get tenant audit log (paginated, filterable, CSV-exportable)",
  },
];
