/**
 * Plan 015 follow-up — the one-shot migrate entrypoint (apps/worker/src/migrate.ts).
 *
 * Proves the wiring WITHOUT a real DB or child process:
 *  - the DB URL comes from the runtime's own resolveDbConnectionString (no
 *    duplicated URL logic), resolved with fresh=false;
 *  - `prisma migrate deploy` is invoked with cwd=/repo/apps/api (where the
 *    committed prisma.config.ts lives) and DATABASE_URL/DIRECT_DATABASE_URL set
 *    to the resolved URL (DIRECT == main ⇒ the config skips the shadow DB);
 *  - the prisma CLI exit code is propagated (fail-closed).
 */

import { describe, expect, it, vi } from "vitest";
import { runMigrate } from "../../../../worker/src/migrate.js";

function fakeSpawn(status: number | null) {
  return vi.fn().mockReturnValue({ status });
}

describe("runMigrate", () => {
  it("resolves the URL the runtime way and invokes `prisma migrate deploy`", async () => {
    const spawn = fakeSpawn(0);
    const resolveUrl = vi.fn().mockResolvedValue("postgresql://u:p@h:5432/db");

    const code = await runMigrate({ spawn, resolveUrl });

    expect(code).toBe(0);
    // Resolved via the SAME resolver the app boots with, fresh=false.
    expect(resolveUrl).toHaveBeenCalledWith(false);

    expect(spawn).toHaveBeenCalledTimes(1);
    const [, args, options] = spawn.mock.calls[0];
    expect(args).toEqual([
      "/repo/node_modules/prisma/build/index.js",
      "migrate",
      "deploy",
    ]);
    // cwd is where the committed prisma.config.ts lives (paths resolve to /repo/prisma).
    expect(options.cwd).toBe("/repo/apps/api");
    // Both point at the resolved URL (DIRECT == main ⇒ no shadow DB).
    expect(options.env.DATABASE_URL).toBe("postgresql://u:p@h:5432/db");
    expect(options.env.DIRECT_DATABASE_URL).toBe("postgresql://u:p@h:5432/db");
    // Inherits the pod env (e.g. DB_SECRET_* still present for the config).
    expect(options.stdio).toBe("inherit");
  });

  it("propagates a non-zero prisma exit code (fail-closed)", async () => {
    const code = await runMigrate({
      spawn: fakeSpawn(1),
      resolveUrl: vi.fn().mockResolvedValue("postgresql://x"),
    });
    expect(code).toBe(1);
  });

  it("treats a null spawn status (killed/failed to run) as failure", async () => {
    const code = await runMigrate({
      spawn: fakeSpawn(null),
      resolveUrl: vi.fn().mockResolvedValue("postgresql://x"),
    });
    expect(code).toBe(1);
  });
});
