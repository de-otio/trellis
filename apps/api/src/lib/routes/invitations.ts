/**
 * Invitations Routes
 */

import { addCorsHeaders } from "../../worker.js";
import { InvitationHandler } from "../invitation-handler.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import type { Route } from "./types.js";

export const invitationsRoutes: Route[] = [
  {
    path: "/api/invitations",
    method: "POST",
    handler: async (request, env) => {
      const invitationHandler = new InvitationHandler();
      const response = await invitationHandler.handleCreateInvitation(
        request,
        env,
      );
      return addCorsHeaders(response, request, env);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Create invitation",
  },

  {
    path: "/api/invitations",
    method: "GET",
    handler: async (request, env) => {
      const invitationHandler = new InvitationHandler();
      const response = await invitationHandler.handleListInvitations(
        request,
        env,
      );
      return addCorsHeaders(response, request, env);
    },
    middleware: [corsMiddleware()],
    description: "List invitations",
  },

  {
    path: "/api/invitations/inviter-info",
    method: "GET",
    handler: async (request, env) => {
      const invitationHandler = new InvitationHandler();
      const response = await invitationHandler.handleGetInviterInfo(
        request,
        env,
      );
      return addCorsHeaders(response, request, env);
    },
    middleware: [corsMiddleware()],
    description: "Get inviter info",
  },

  {
    path: "/api/invitations/validate",
    method: "POST",
    handler: async (request, env) => {
      const invitationHandler = new InvitationHandler();
      const response = await invitationHandler.handleValidateInvitation(
        request,
        env,
      );
      return addCorsHeaders(response, request, env);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Validate invitation",
  },

  {
    path: /^\/api\/invitations\/(.+)$/,
    method: "DELETE",
    handler: async (request, env) => {
      const invitationHandler = new InvitationHandler();
      const response = await invitationHandler.handleDeleteInvitation(
        request,
        env,
      );
      return addCorsHeaders(response, request, env);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Delete invitation",
  },
];
