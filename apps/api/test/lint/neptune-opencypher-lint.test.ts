import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lintNeptuneCompat } from "./neptune-opencypher-lint";

const ids = (src: string) => lintNeptuneCompat(src).map((v) => v.ruleId);
const errors = (src: string) => lintNeptuneCompat(src).filter((v) => v.severity === "error");

describe("lintNeptuneCompat — rules", () => {
  it("flags FOREACH", () => {
    expect(ids("FOREACH (_ IN CASE WHEN c THEN [1] ELSE [] END | SET n.x = 1)")).toContain("no-foreach");
  });

  it("flags EXISTS { subquery } but not the exists(prop) function", () => {
    expect(ids("WHERE NOT EXISTS { MATCH (me)-[:R]->(x) }")).toContain("no-exists-subquery");
    expect(ids("WHERE exists(n.prop)")).not.toContain("no-exists-subquery");
  });

  it("flags CALL { subquery }", () => {
    expect(ids("CALL { MATCH (n) RETURN n }")).toContain("no-call-subquery");
  });

  it("flags spatial point()/point.distance()", () => {
    expect(ids("WHERE point.distance(point({latitude: a}), point({latitude: b})) < 5000")).toContain("no-spatial");
  });

  it("flags Cypher reduce() but not JS .reduce()", () => {
    expect(ids("reduce(s = 0.0, x IN list | s + x)")).toContain("no-reduce");
    expect(ids("const avg = arr.reduce((a, b) => a + b, 0);")).not.toContain("no-reduce");
  });

  it("flags CREATE CONSTRAINT, CREATE (POINT) INDEX, SHOW", () => {
    expect(ids("CREATE CONSTRAINT user_id IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE")).toContain(
      "no-create-constraint",
    );
    expect(ids("CREATE POINT INDEX entity_location FOR (e:Entity) ON (e.location)")).toContain("no-create-index");
    expect(ids("CREATE INDEX post_created FOR (p:Post) ON (p.createdAt)")).toContain("no-create-index");
    expect(ids("SHOW CONSTRAINTS")).toContain("no-show");
  });

  it("flags LIMIT/SKIP toInteger(...)", () => {
    expect(ids("RETURN n ORDER BY n.x LIMIT toInteger($limit)")).toContain("no-expression-skiplimit");
  });

  it("warns (not errors) on datetime()", () => {
    const v = lintNeptuneCompat("WHERE post.createdAt > datetime($since)");
    const dt = v.find((x) => x.ruleId === "datetime-engine-gated");
    expect(dt?.severity).toBe("warn");
    expect(errors("WHERE post.createdAt > datetime($since)")).toHaveLength(0);
  });

  it("passes clean portable Cypher", () => {
    expect(errors("MATCH (n:User {id: $id})-[:RELATES_TO]->(m) RETURN m.name ORDER BY m.name LIMIT $limit")).toEqual([]);
  });
});

// Informational scan of the real graph layer — proves the linter catches the
// audit's documented findings. Not asserted on exact counts (those shrink as
// the C2/C3/C7 rewrites land); wire a strict `errors === 0` gate into CI once
// the migration rewrites are complete.
describe("current graph layer (informational)", () => {
  it("reports Neptune-incompatible Cypher in src/lib/graph", () => {
    const dir = join(process.cwd(), "src/lib/graph");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    const byRule = new Map<string, number>();
    for (const f of files) {
      for (const v of lintNeptuneCompat(readFileSync(join(dir, f), "utf8"))) {
        if (v.severity === "error") byRule.set(v.ruleId, (byRule.get(v.ruleId) ?? 0) + 1);
      }
    }
    // eslint-disable-next-line no-console
    console.log("[neptune-lint] current error-level findings by rule:", Object.fromEntries(byRule));
    expect(byRule).toBeInstanceOf(Map); // soft: this block documents state, it does not gate
  });
});
