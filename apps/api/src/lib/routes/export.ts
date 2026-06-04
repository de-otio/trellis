/**
 * Export Routes
 */

import { addCorsHeaders } from "../../worker.js";
import { getLogger, Logger } from "../logger.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { UserExportHandler } from "../user-export-handler.js";
import type { Route } from "./types.js";

export const exportRoutes: Route[] = [
  {
    path: "/api/user/export",
    method: "POST",
    handler: async (request, env, { requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const userExportHandler = new UserExportHandler();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      try {
        const body = (await request.json().catch(() => ({}))) as {
          format?: string;
        };
        const format = (body.format || "json") as "json" | "atproto";

        const job = await userExportHandler.createExportJob(
          session,
          env,
          format,
          requestContext,
        );

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            jobId: job.jobId,
            status: job.status,
            message:
              "Export job created. Check status at /api/user/export/status/:jobId",
            estimatedCompletion: "Within 24 hours",
          }),
          { status: 202, headers: { "content-type": "application/json" } },
        );
        return await addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("Error creating export job:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Failed to create export job",
            message: error.message,
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return await addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Create export job",
  },

  {
    path: /^\/api\/user\/export\/status\/(.+)$/,
    method: "GET",
    handler: async (request, env, { pathname }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const userExportHandler = new UserExportHandler();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      try {
        const jobId = pathname.split("/api/user/export/status/")[1];
        const job = await userExportHandler.getJobStatus(
          jobId,
          session.userId,
          env,
        );

        if (!job) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Job not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }

        const response = securityHeaders.createSecureResponse(
          JSON.stringify(job),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return await addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("Error getting export job status:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Failed to get export job status",
            message: error.message,
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return await addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware()],
    description: "Get export job status",
  },

  {
    path: /^\/api\/user\/export\/download\/(.+)$/,
    method: "GET",
    handler: async (request, env, { pathname }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const userExportHandler = new UserExportHandler();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      try {
        const jobId = pathname.split("/api/user/export/download/")[1];
        const fileResponse = await userExportHandler.getExportFile(
          jobId,
          session.userId,
          env,
        );

        if (!fileResponse) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Export file not found or not ready" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }

        const securedResponse =
          securityHeaders.addSecurityHeaders(fileResponse);
        return await addCorsHeaders(securedResponse, request, env);
      } catch (error: any) {
        logger.error("Error downloading export file:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Failed to download export file",
            message: error.message,
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return await addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware()],
    description: "Download export file",
  },
];
