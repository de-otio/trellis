/**
 * PURE unit tests for the raw-SQL sidecar (Q7 lossiness repairs) and the CLI
 * arg/registry-render helpers. These cover the pure seams carved out of the
 * imperative baseline shell — the process-spawn + fs parts are exercised by the
 * Docker-gated integration test, not here.
 */

import { describe, expect, it } from "vitest";
import {
  applyRawSqlSidecar,
  CORE_EXTENSION_PREAMBLE,
  CORE_RAW_SQL_REPAIRS,
} from "../../src/lib/extension-schema-baseline.js";
import {
  parseArgs,
  renderRegistryModule,
} from "../../src/lib/extension-schema-composer-cli.js";

// A synthetic replay body carrying exactly the tokens the DMMF serialiser
// mangles (mirrors what `migrate diff --script` emits for the real schema).
const LOSSY_BODY = `-- CreateTable
CREATE TABLE "public"."entity_location" (
    "location" geography() NOT NULL
);

CREATE INDEX "entity_location_location_idx" ON "public"."entity_location" USING GIST ("location" gist_geography_ops ASC);
CREATE INDEX "tenant_display_name_trgm_idx" ON "public"."tenants" USING GIN ("display_name" gin_trgm_ops ASC);
`;

describe("applyRawSqlSidecar", () => {
  it("prepends CREATE EXTENSION and repairs every lossy token", () => {
    const out = applyRawSqlSidecar(LOSSY_BODY);
    expect(out.startsWith(CORE_EXTENSION_PREAMBLE)).toBe(true);
    expect(out).toContain("CREATE EXTENSION IF NOT EXISTS postgis;");
    expect(out).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
    // geography() → geography(Point,4326)
    expect(out).toContain('"location" geography(Point,4326) NOT NULL');
    expect(out).not.toContain("geography() NOT NULL");
    // GiST: invalid opclass+ASC stripped back to the plain column.
    expect(out).toContain('USING GIST ("location")');
    expect(out).not.toContain("gist_geography_ops ASC");
    // GIN: invalid ASC stripped, opclass preserved.
    expect(out).toContain('USING GIN ("display_name" gin_trgm_ops)');
    expect(out).not.toContain("gin_trgm_ops ASC");
  });

  it("throws when a required repair does not apply (upstream diff drifted)", () => {
    // A body missing the geography() token — the first required repair matches
    // nothing and must fail loudly rather than silently ship bad DDL.
    const clean = `CREATE TABLE x ();`;
    expect(() => applyRawSqlSidecar(clean)).toThrow(/repair did not apply/);
  });

  it("does not throw when only the optional repair is unmatched", () => {
    // Body has geography(), GiST location, GIN trgm — but not the optional
    // gist expression-index token. Should still succeed.
    const out = applyRawSqlSidecar(LOSSY_BODY, CORE_RAW_SQL_REPAIRS);
    expect(out).toContain("CREATE EXTENSION IF NOT EXISTS postgis;");
  });

  it("is idempotent-safe: a custom single-repair set applies once", () => {
    const out = applyRawSqlSidecar(
      "geography() NOT NULL",
      [
        {
          reason: "test",
          find: /geography\(\) NOT NULL/g,
          replace: "geography(Point,4326) NOT NULL",
        },
      ],
      "",
    );
    expect(out).toBe("geography(Point,4326) NOT NULL");
  });
});

describe("parseArgs", () => {
  it("parses core/out/fragment/allow/baseline", () => {
    const args = parseArgs([
      "--core",
      "schema.prisma",
      "--out",
      "/tmp/out",
      "--fragment",
      "widget=frag.prisma",
      "--allow",
      "User,Entity,Tenant,Connection",
      "--baseline",
      "--migrations",
      "/m",
      "--db",
      "postgres://a",
      "--direct",
      "postgres://b",
    ]);
    expect(args.core).toBe("schema.prisma");
    expect(args.out).toBe("/tmp/out");
    expect(args.fragments).toEqual([{ extId: "widget", file: "frag.prisma" }]);
    expect(args.allow).toEqual(["User", "Entity", "Tenant", "Connection"]);
    expect(args.baseline).toBe(true);
    expect(args.migrations).toBe("/m");
  });

  it("defaults the allowlist to the three core erasure targets", () => {
    const args = parseArgs(["--core", "s", "--out", "o"]);
    expect(args.allow).toEqual(["User", "Entity", "Tenant"]);
    expect(args.baseline).toBe(false);
  });

  it("throws on a malformed --fragment", () => {
    expect(() =>
      parseArgs(["--core", "s", "--out", "o", "--fragment", "noequals"]),
    ).toThrow(/expects <extId>=<file>/);
  });

  it("throws on a missing --core / --out", () => {
    expect(() => parseArgs(["--out", "o"])).toThrow(/--core/);
    expect(() => parseArgs(["--core", "s"])).toThrow(/--out/);
  });

  it("throws on an unknown flag and a missing value", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--core"])).toThrow(/missing value/);
  });
});

describe("renderRegistryModule", () => {
  it("renders a compiling TS module with the registry entries", () => {
    const src = renderRegistryModule([
      { model: "ext_widget__records", tenantField: "tenantId", erasureSubjectField: "createdBy" },
      { model: "ext_widget__reminders", tenantField: "tenantId", erasureSubjectField: null },
    ]);
    expect(src).toContain("GENERATED by trellis-schema compose");
    expect(src).toContain(
      'import type { ExtensionModelRegistryEntry } from "./extension-model-registry.js";',
    );
    expect(src).toContain('"model": "ext_widget__records"');
    expect(src).toContain('"erasureSubjectField": null');
    expect(src.trimEnd().endsWith(";")).toBe(true);
  });

  it("renders an empty array when the registry is empty", () => {
    expect(renderRegistryModule([])).toContain(
      "EXTENSION_MODEL_REGISTRY: readonly ExtensionModelRegistryEntry[] = [];",
    );
  });
});
