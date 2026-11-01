/**
 * Unit Test: the RLS GUC name cannot drift.
 *
 * The Row-Level-Security backstop has two halves that live in different
 * languages and different files:
 *
 *   - SQL   — `app_current_tenant_id()` in
 *             prisma/migrations/*_rls_backstop_policies_inert/migration.sql,
 *             which every tenant policy calls;
 *   - TS    — `withTenantTx` in src/lib/database-connection-manager.ts, which
 *             issues `set_config('app.current_tenant', …, true)` as the first
 *             statement of each tenant transaction.
 *
 * If those two strings ever disagree, the policies read a GUC nobody sets. The
 * failure is not a type error, not a test failure, and not a runtime exception:
 * once RLS is armed, every SELECT on a policied table returns ZERO ROWS and
 * every INSERT fails its WITH CHECK. The application presents as empty rather
 * than as broken, which is the hardest possible shape of outage to diagnose.
 *
 * A rename is the obvious way to cause it — someone tidies the SQL to
 * `app.tenant_id` (which is, in fact, the name the remediation plan uses) and
 * the TypeScript keeps setting the old one. This test is the tripwire: it reads
 * both files and asserts they name the same GUC. It costs one file read and
 * removes an entire class of silent outage.
 *
 * This test does NOT need a database, and it does NOT arm anything.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
  extensionScopedModelNames,
  TENANT_SCOPED_MODELS,
  UNSCOPED_MODELS,
} from "../../src/lib/tenant-scope.js";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "prisma", "migrations");
const RLS_DIR = join(REPO_ROOT, "prisma", "rls");
const CONNECTION_MANAGER = join(
  REPO_ROOT,
  "apps",
  "api",
  "src",
  "lib",
  "database-connection-manager.ts",
);

/** The single GUC name both halves must use. */
const GUC = "app.current_tenant";

/** The original backstop migration: the resolver function and the first policies. */
function rlsMigrationSql(): string {
  const dir = readdirSync(MIGRATIONS_DIR).find((d) => d.includes("rls_backstop_policies_inert"));
  expect(dir, "the RLS backstop migration must exist").toBeDefined();
  return readFileSync(join(MIGRATIONS_DIR, dir!, "migration.sql"), "utf8");
}

/** Pull the table names out of an `ARRAY[ … ]` literal, layout-agnostic. */
function arrayTables(sql: string): string[] {
  const block = /ARRAY\[([\s\S]*?)\]/.exec(sql);
  return block ? [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
}

/**
 * Every table any `*_rls_backstop_*` migration policies. The original one
 * loops over an ARRAY; later ones add a table with a direct
 * `CREATE POLICY tenant_isolation ON <table>`.
 */
function policiedTables(): Set<string> {
  const tables = new Set<string>();
  for (const dir of readdirSync(MIGRATIONS_DIR).filter((d) => d.includes("rls_backstop"))) {
    // Comments are stripped so a commented-out policy never counts as live.
    const sql = readFileSync(join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8").replace(
      /--.*$/gm,
      "",
    );
    for (const t of arrayTables(sql)) tables.add(t);
    for (const m of sql.matchAll(/CREATE POLICY tenant_isolation ON ([a-z_]+)/g)) {
      tables.add(m[1]);
    }
  }
  return tables;
}

describe("RLS GUC name", () => {
  it("the migration's resolver reads the GUC the application sets", () => {
    const sql = rlsMigrationSql();
    const ts = readFileSync(CONNECTION_MANAGER, "utf8");

    expect(sql).toContain(`current_setting('${GUC}', true)`);
    expect(ts).toContain(`set_config('${GUC}'`);
  });

  it("no other GUC name appears in the RLS SQL", () => {
    const sql = rlsMigrationSql();

    // Catches the specific rename that would break it silently. Comments in the
    // migration deliberately MENTION `app.tenant_id` to explain the deviation
    // from the remediation plan, so only executable references are checked.
    const executable = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(executable).not.toContain("app.tenant_id");
  });

  it("the resolver is fail-closed: unset GUC yields NULL, not a wildcard", () => {
    const sql = rlsMigrationSql();

    // `missing_ok = true` + NULLIF('') → NULL → `tenant_id = NULL` → NULL →
    // not TRUE → the policy denies. Any of these three disappearing turns an
    // unset GUC from "deny everything" into an error or, worse, a match.
    expect(sql).toContain("NULLIF(current_setting");
    expect(sql).toContain(", true)");
    expect(sql).toMatch(/STABLE/);
  });

  it("the migration does NOT arm RLS — merging it must change nothing", () => {
    const sql = rlsMigrationSql();

    // The policies are inert without ENABLE. If an ENABLE ever lands in the
    // migration, `migrate deploy` starts arming RLS automatically, which is the
    // one thing this whole design is arranged to prevent.
    expect(sql).not.toMatch(/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    expect(sql).toMatch(/CREATE POLICY/);
  });

  it("arming and standing down are both provided, as scripts outside migrations", () => {
    const enable = readFileSync(join(RLS_DIR, "enable-rls.sql"), "utf8");
    const disable = readFileSync(join(RLS_DIR, "disable-rls.sql"), "utf8");

    expect(enable).toMatch(/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    // FORCE matters: without it the table owner bypasses every policy, so a
    // rehearsal run as the owner passes while the app role is locked out.
    expect(enable).toMatch(/FORCE\s+ROW\s+LEVEL\s+SECURITY/i);
    expect(disable).toMatch(/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i);
  });

  it("every table the migrations policy is also armed and disarmed by the scripts", () => {
    const policied = policiedTables();
    const armed = arrayTables(readFileSync(join(RLS_DIR, "enable-rls.sql"), "utf8"));
    const disarmed = arrayTables(readFileSync(join(RLS_DIR, "disable-rls.sql"), "utf8"));

    expect(policied.size).toBeGreaterThan(0);
    expect(armed.length, "enable-rls.sql declares its table list as ARRAY[…]").toBeGreaterThan(0);
    // A table policied but never armed is a silent gap; a table armed but never
    // policied is a lockout (RLS on, no policy = deny all).
    expect([...policied].sort()).toEqual([...armed].sort());
    expect([...disarmed].sort()).toEqual([...armed].sort());
  });

  it("every table-backed TENANT_SCOPED_MODELS entry has a policy", () => {
    // Model → table, for the scoped models (ext_* tables are policied by the
    // composer that creates them, so the registry-derived names are excluded).
    const policied = policiedTables();
    const ext = new Set(extensionScopedModelNames());
    const tableOf = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m.dbName ?? m.name]));
    const unpolicied = [...TENANT_SCOPED_MODELS]
      .filter((name) => !ext.has(name))
      .map((name) => tableOf.get(name))
      .filter((table) => !policied.has(table!));
    expect(unpolicied).toEqual([]);
  });

  it("every by-relation model with its own tenant_id has a policy, or a recorded exemption", () => {
    // Exemptions, each with its reason. Nothing else may be left out.
    const exempt = new Map([
      // Follows its tenant-admin parent (tenant_classifications), which
      // platform admins update across tenants and which has no policy.
      ["TenantClassificationTag", "parent is tenant-admin"],
    ]);
    const policied = policiedTables();
    const unpolicied = Prisma.dmmf.datamodel.models
      .filter((m) => UNSCOPED_MODELS.get(m.name)?.startsWith("by-relation"))
      .filter((m) => m.fields.some((f) => f.name === "tenantId" && f.kind === "scalar"))
      .filter((m) => !exempt.has(m.name))
      .filter((m) => !policied.has(m.dbName ?? m.name))
      .map((m) => m.name);
    expect(unpolicied).toEqual([]);
    // A stale exemption hides nothing but misleads; keep the list honest.
    for (const name of exempt.keys()) {
      expect(UNSCOPED_MODELS.get(name), `${name} is still by-relation`).toMatch(/^by-relation/);
    }
  });
});
