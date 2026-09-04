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

function rlsMigrationSql(): string {
  const dir = readdirSync(MIGRATIONS_DIR).find((d) =>
    d.includes("rls_backstop"),
  );
  expect(dir, "the RLS backstop migration must exist").toBeDefined();
  return readFileSync(join(MIGRATIONS_DIR, dir!, "migration.sql"), "utf8");
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

  it("every table the migration policies is also armed and disarmed by the scripts", () => {
    /** Pull the table names out of the `ARRAY[ … ]` literal, layout-agnostic. */
    const tablesIn = (sql: string) => {
      const block = /ARRAY\[([\s\S]*?)\]/.exec(sql);
      expect(block, "each RLS file declares its table list as ARRAY[…]").not
        .toBeNull();
      return new Set(
        [...block![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
      );
    };

    const policied = tablesIn(rlsMigrationSql());
    const armed = tablesIn(readFileSync(join(RLS_DIR, "enable-rls.sql"), "utf8"));

    expect(policied.size).toBeGreaterThan(0);
    // A table policied but never armed is a silent gap; a table armed but never
    // policied is a lockout (RLS on, no policy = deny all).
    expect([...policied].sort()).toEqual([...armed].sort());
  });
});
