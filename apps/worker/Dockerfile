# apps/worker — provider-neutral worker container (WS-2 T8).
#
# BUILD CONTEXT: the repo root (the worker compiles against apps/api sources):
#   docker build -f apps/worker/Dockerfile -t trellis-worker .
#
# NOTE (blocker until the coordinated saas-foundation publish): the worktree's
# root package.json carries local-dev `file:` overrides pointing OUTSIDE this
# repo (../saas-foundation-wt-scaleway). `npm ci` inside this build only works
# once `@de-otio/saas-foundation` / `@de-otio/vestibulum` 0.4.0 are published
# and the overrides are dropped. Until then, build the image from a checkout
# without the overrides (CI does; local dev worktrees cannot).

# ── build stage ─────────────────────────────────────────────────────────────
FROM node:24-slim AS build
WORKDIR /repo

# Install the workspace (worker + api + extension-api).
COPY package.json package-lock.json tsconfig.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages ./packages
RUN npm ci

# Sources + prisma schema; generate the client the api sources import.
COPY prisma ./prisma
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
RUN npm run -w @de-otio/trellis prisma:generate

# Compile the worker (emits apps/worker/dist/{apps/worker,apps/api}/src).
RUN cd apps/worker && npx tsc -p tsconfig.build.json

# ── runtime stage ───────────────────────────────────────────────────────────
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /repo

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/worker/dist ./apps/worker/dist
COPY --from=build /repo/prisma ./prisma
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build /repo/apps/worker/package.json ./apps/worker/package.json
COPY package.json ./

# Non-root (the health port is unprivileged; no listener below 1024).
USER node

# Health endpoint (finding 10): orchestrator-internal ONLY — the WS-4
# `workers` module must NOT attach this port to any public LB/ingress.
EXPOSE 8081

CMD ["node", "apps/worker/dist/apps/worker/src/main.js"]
