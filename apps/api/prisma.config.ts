import { defineConfig } from "prisma/config";

// Prisma 7 moved schema-location and datasource connection config out of
// package.json#prisma and the datasource block in schema.prisma into this
// file. The schema still lives at the repo root (../../prisma/schema.prisma)
// and is shared across the monorepo; migrations live alongside it.
//
// `datasource.url` / `shadowDatabaseUrl` are only consulted by migration /
// introspection commands (migrate dev/deploy, db pull). At runtime the API
// connects through the PrismaPg driver adapter (see
// lib/database-connection-manager.ts), not through this file.
//
// We read straight from process.env rather than Prisma's `env()` helper: that
// helper resolves eagerly at config-load time and throws when the variable is
// unset, which would break `prisma generate` in environments without a live
// database (CI, fresh checkouts). Migration commands still require a real
// DATABASE_URL / DIRECT_DATABASE_URL to be present in the environment.
export default defineConfig({
  schema: "../../prisma/schema.prisma",
  migrations: {
    path: "../../prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "",
    // Prisma 7 removed datasource.directUrl. The shadow database used by
    // `migrate dev` is the direct (non-pooled) connection; map the previous
    // DIRECT_DATABASE_URL onto it.
    shadowDatabaseUrl: process.env.DIRECT_DATABASE_URL,
  },
});
