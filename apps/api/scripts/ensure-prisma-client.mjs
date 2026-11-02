#!/usr/bin/env node
// `prelint` guard: make sure the generated Prisma client exists (and is not
// older than the schema) before `tsc --build` runs.
//
// Why: `tsc --build` does not generate the client. In a fresh checkout or
// worktree `@prisma/client` has no `PrismaClient` export yet, so lint prints
// TS2305 on src/db.ts plus dozens of follow-on TS7006 implicit-any errors that
// hide real findings. CI always runs `npm run prisma:generate` first; this makes
// the local `npm run lint` do the same, but only when needed.
//
// Cheap path: two stat() calls, no child process. Regenerates through the same
// script CI uses (`npm run prisma:generate`), so the generator, config and
// binary targets cannot drift from CI.
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = resolve(here, "..");
const schema = resolve(apiDir, "../../prisma/schema.prisma");

const require = createRequire(join(apiDir, "package.json"));
// <node_modules>/@prisma/client -> <node_modules>/.prisma/client (default output)
const clientPkg = require.resolve("@prisma/client/package.json");
const generated = join(dirname(clientPkg), "..", "..", ".prisma", "client", "index.d.ts");

const missing = !existsSync(generated);
const stale = !missing && statSync(generated).mtimeMs < statSync(schema).mtimeMs;

if (!missing && !stale) process.exit(0);

console.error(
  `prelint: Prisma client is ${missing ? "missing" : "older than prisma/schema.prisma"}; running npm run prisma:generate`,
);
const result = spawnSync("npm", ["run", "prisma:generate"], { cwd: apiDir, stdio: "inherit" });
process.exit(result.status ?? 1);
