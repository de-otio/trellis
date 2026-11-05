/**
 * Role-matrix guard: every code path that WRITES `User.role` is known and
 * reviewed.
 *
 * `User.role = SUPER_ADMIN` short-circuits every `requireRole` /
 * `requireCapability` / `requireActiveTenant` check (auth/require.ts), so the
 * set of code that can write a global role is the privilege boundary of the
 * whole product. The Nov-2026 review found one writer (the dashboard PATCH) that
 * let an INTERNAL operator promote anyone — including themselves — to
 * SUPER_ADMIN. This test scans the source for every prisma write to `user`
 * whose data carries a `role` key and pins the set: a NEW writer fails here
 * until a human has checked it cannot be reached by anyone below SUPER_ADMIN and
 * added it to the allow-list with its justification.
 *
 * It is deliberately a source scan, not a behavioural test: behaviour of each
 * known writer is covered where it lives (routes/dashboard.test.ts H1/X3,
 * routes/admin.test.ts). What a scan adds is that nobody can add a tenth writer
 * and forget the guard.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOTS = [
  join(here, "../../../src"), // apps/api/src
  join(here, "../../../../worker/src"), // apps/worker/src
];

/** `file (relative to apps/) -> why it may write User.role`. */
const ALLOWED_ROLE_WRITERS: Readonly<Record<string, string>> = {
  "api/src/lib/routes/dashboard.ts":
    "PATCH /api/dashboard/users/:id (INTERNAL or SUPER_ADMIN; role changes need SUPER_ADMIN, " +
    "no self-modification, only SUPER_ADMIN may touch a SUPER_ADMIN — H1) and " +
    "PATCH /api/admin/users/:id/role (SUPER_ADMIN only).",
  "api/src/lib/tenant/tenant-handler.ts":
    "Tenant creation bumps the CALLER's own global role END_USER -> B2B_PARTNER only " +
    "(`where: { role: \"END_USER\" }`); cannot reach INTERNAL/SUPER_ADMIN.",
  "api/src/lib/identity/provision-confirmed-user.ts":
    "First-contact provisioning creates the row as END_USER (B2B_PARTNER for a federated " +
    "sign-up); never an elevated role, and (H5) never merges into an existing row by email.",
  "api/src/lib/entity-handler.ts":
    "Fallback provisioning upsert creates a NEW row with a CONSTANT END_USER (create branch " +
    "only; the update branch never writes a role). Never seeded from a session value.",
};

/**
 * `DataRouter.createUser(userData, ...)` spreads `userData` into the create, so a
 * caller that passes a `role` writes it indirectly — invisible to the scan above.
 * Only the SUPER_ADMIN-gated, environment-gated test-user route may do so.
 */
const ALLOWED_CREATE_USER_ROLE_CALLERS: Readonly<Record<string, string>> = {
  "api/src/lib/routes/admin.ts":
    "POST /api/admin/test/users: SUPER_ADMIN session + testRoutesEnabled() gate (X2).",
};

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) yield p;
  }
}

/** Text of the balanced `( ... )` argument list starting at `open`. */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

const WRITE_CALL = /\.user\.(update|updateMany|upsert|create|createMany)\s*\(/g;
// `role:` / `role,` shorthand as a KEY of the data object, not `where: { role }`
// reads or `select: { role: true }`.
const ROLE_KEY_IN_DATA = /\b(data|create|update)\s*:\s*\{[^}]*\brole\s*(:|,|\})/s;

function findRoleWriters(): Map<string, number> {
  const found = new Map<string, number>();
  const appsRoot = join(here, "../../../..");
  for (const root of SRC_ROOTS) {
    for (const file of walk(root)) {
      const src = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      WRITE_CALL.lastIndex = 0;
      while ((m = WRITE_CALL.exec(src))) {
        const call = balanced(src, m.index + m[0].length - 1);
        if (ROLE_KEY_IN_DATA.test(call)) {
          const key = relative(appsRoot, file).split(sep).join("/");
          found.set(key, (found.get(key) ?? 0) + 1);
        }
      }
    }
  }
  return found;
}

describe("User.role writers (role matrix guard)", () => {
  const found = findRoleWriters();

  it("sees at least one writer (guards against the scan silently matching nothing)", () => {
    expect(found.size).toBeGreaterThan(0);
  });

  it("every file that writes User.role is on the reviewed allow-list", () => {
    const unknown = [...found.keys()].filter((f) => !(f in ALLOWED_ROLE_WRITERS));
    expect(
      unknown,
      `New writer(s) of User.role: ${unknown.join(", ")}. Confirm nothing below SUPER_ADMIN can reach them, then add to ALLOWED_ROLE_WRITERS with the reason.`,
    ).toEqual([]);
  });

  it("the allow-list has no stale entries (a removed writer must be removed here too)", () => {
    const stale = Object.keys(ALLOWED_ROLE_WRITERS).filter((f) => !found.has(f));
    expect(stale).toEqual([]);
  });

  it("only allow-listed callers pass a `role` through DataRouter.createUser (spread write)", () => {
    const appsRoot = join(here, "../../../..");
    const callers = new Set<string>();
    for (const root of SRC_ROOTS) {
      for (const file of walk(root)) {
        const src = readFileSync(file, "utf8");
        const re = /DataRouter\.createUser\s*\(/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) {
          const call = balanced(src, m.index + m[0].length - 1);
          // Only the FIRST argument (userData) can carry the role.
          if (/\brole\b/.test(call.split("region")[0] ?? call)) {
            callers.add(relative(appsRoot, file).split(sep).join("/"));
          }
        }
      }
    }
    const unknown = [...callers].filter((f) => !(f in ALLOWED_CREATE_USER_ROLE_CALLERS));
    expect(
      unknown,
      `DataRouter.createUser called with a role from: ${unknown.join(", ")}`,
    ).toEqual([]);
    // And the known caller really is still there (the test would be vacuous otherwise).
    expect([...callers]).toContain("api/src/lib/routes/admin.ts");
  });

  it("the scan itself works: it flags a synthetic writer", () => {
    // Guards the regexes against rotting into 'matches nothing'.
    const sample = "await db.user.update({ where: { id }, data: { role: 'SUPER_ADMIN' } });";
    WRITE_CALL.lastIndex = 0;
    const m = WRITE_CALL.exec(sample)!;
    expect(ROLE_KEY_IN_DATA.test(balanced(sample, m.index + m[0].length - 1))).toBe(true);
    const read = "await db.user.findUnique({ where: { id }, select: { role: true } });";
    WRITE_CALL.lastIndex = 0;
    expect(WRITE_CALL.exec(read)).toBeNull();
  });
});
