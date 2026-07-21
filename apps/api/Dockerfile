# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app

# Copy workspace root files
COPY package*.json ./
COPY tsconfig.json ./
COPY tsconfig.build.json ./
COPY apps/api/package*.json ./apps/api/
COPY packages/extension-api/package*.json packages/extension-api/tsconfig.json ./packages/extension-api/

# Create stub src dirs so workspace prepare scripts (tsc --build) succeed during install
RUN mkdir -p packages/extension-api/src && \
    echo "export {};" > packages/extension-api/src/index.ts

# Install dependencies
RUN npm ci --workspace=apps/api --workspace=packages/extension-api

# Copy source
COPY prisma/ ./prisma/
COPY packages/extension-api/ ./packages/extension-api/
COPY apps/api/ ./apps/api/

# Generate Prisma client first — tsc needs @prisma/client types
RUN npm run prisma:generate

# Build all workspace packages in dependency order (extension-api → api)
# --force ignores stale stub outputs left by npm ci's prepare scripts
RUN npx tsc --build --force tsconfig.build.json

# Stage 2: Production runner
FROM node:22-alpine AS runner
RUN apk add --no-cache curl dumb-init

# Create non-root user
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

# Copy only production artifacts
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/apps/api/dist ./dist
COPY --from=builder --chown=app:app /app/prisma ./prisma
COPY --from=builder --chown=app:app /app/packages/extension-api/lib ./packages/extension-api/lib
COPY --from=builder --chown=app:app /app/packages/extension-api/package.json ./packages/extension-api/package.json

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

USER app

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
