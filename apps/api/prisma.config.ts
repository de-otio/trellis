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
    // The shadow database is only used by `migrate dev` to diff migrations, and
    // Prisma 7 rejects a shadow that equals the main database. Only set it when
    // DIRECT_DATABASE_URL points at a DIFFERENT database (local `migrate dev`
    // against a dedicated shadow DB). In CI/prod, `migrate deploy` runs with
    // DIRECT_DATABASE_URL == DATABASE_URL and needs no shadow — leaving it unset
    // avoids the "shadow appears to be the same as the main database" error.
    ...(process.env.DIRECT_DATABASE_URL &&
    process.env.DIRECT_DATABASE_URL !== process.env.DATABASE_URL
      ? { shadowDatabaseUrl: process.env.DIRECT_DATABASE_URL }
      : {}),
  },
});
