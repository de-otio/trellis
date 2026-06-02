/**
 * Static lint for Neptune openCypher compatibility (audit Track D1).
 *
 * Neo4j (local Docker / AuraDB) accepts a superset of Neptune's openCypher, so
 * the integration tests against Docker Neo4j will NOT catch Neptune-incompatible
 * Cypher. This linter is the pre-cluster guard: it scans source for the
 * incompatible patterns enumerated in the audit
 * (plans/redesign/graph-db-neptune-serverless/10-opencypher-audit.md) so a
 * regression is caught at lint time, not on deploy.
 *
 * It is a line-based heuristic over raw source (Cypher lives in template
 * literals); the distinctive keywords make false positives rare. `error` =
 * hard Neptune incompatibility; `warn` = engine-version-gated / verify.
 */
export type Severity = "error" | "warn";

export interface NeptuneRule {
  id: string;
  severity: Severity;
  pattern: RegExp;
  message: string;
}

export interface Violation {
  ruleId: string;
  severity: Severity;
  line: number;
  text: string;
  message: string;
}

export const NEPTUNE_RULES: readonly NeptuneRule[] = [
  {
    id: "no-spatial",
    severity: "error",
    pattern: /\bpoint\s*\(|\bpoint\.distance\s*\(/i,
    message: "No spatial type/functions in Neptune (point/point.distance) — serve geo from Postgres/PostGIS (F1)",
  },
  {
    id: "no-reduce",
    severity: "error",
    pattern: /(?<!\.)\breduce\s*\(/,
    message: "Neptune openCypher does not support reduce() (F9)",
  },
  {
    id: "no-foreach",
    severity: "error",
    pattern: /\bFOREACH\b/,
    message: "Neptune does not support FOREACH — restructure conditional writes (F5)",
  },
  {
    id: "no-exists-subquery",
    severity: "error",
    // EXISTS { ... } subquery — distinct from the supported exists(prop) function.
    pattern: /\bEXISTS\s*\{/i,
    message: "Neptune does not support EXISTS { subquery } — use OPTIONAL MATCH … WHERE x IS NULL (F3)",
  },
  {
    id: "no-call-subquery",
    severity: "error",
    pattern: /\bCALL\s*\{/i,
    message: "Neptune does not support CALL { subquery } — merge app-side (F4)",
  },
  {
    id: "no-create-constraint",
    severity: "error",
    pattern: /\bCREATE\s+CONSTRAINT\b/i,
    message: "Neptune does not support CREATE CONSTRAINT — uniqueness via ~id / app layer (F6)",
  },
  {
    id: "no-create-index",
    severity: "error",
    pattern: /\bCREATE\s+(?:[A-Z]+\s+)?INDEX\b/i,
    message: "Neptune auto-indexes — CREATE INDEX unsupported (F7)",
  },
  {
    id: "no-show",
    severity: "error",
    pattern: /\bSHOW\s+(?:CONSTRAINTS|INDEXES)\b/i,
    message: "Neptune does not support SHOW CONSTRAINTS/INDEXES (F8)",
  },
  {
    id: "no-expression-skiplimit",
    severity: "error",
    pattern: /\b(?:LIMIT|SKIP)\s+toInteger\s*\(/i,
    message: "Neptune requires static SKIP/LIMIT — pass an integer param (neo4j.int), drop toInteger() (F10)",
  },
  {
    id: "datetime-engine-gated",
    severity: "warn",
    pattern: /\bdatetime\s*\(/i,
    message: "datetime() needs Neptune engine ≥ 1.3.2.0 (over properties/params) — verify (F2)",
  },
];

/** Lint a single source string. Returns one violation per (line, rule) hit. */
export function lintNeptuneCompat(source: string): Violation[] {
  const out: Violation[] = [];
  const lines = source.split("\n");
  lines.forEach((text, i) => {
    // Skip comment-only lines — Cypher lives in template literals, never in a
    // `//` / `*` comment, so a keyword there (e.g. "no FOREACH needed") is noise.
    const trimmed = text.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    for (const rule of NEPTUNE_RULES) {
      if (rule.pattern.test(text)) {
        out.push({ ruleId: rule.id, severity: rule.severity, line: i + 1, text: text.trim(), message: rule.message });
      }
    }
  });
  return out;
}
