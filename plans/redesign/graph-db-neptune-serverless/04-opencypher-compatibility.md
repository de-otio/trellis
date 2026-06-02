# 04 — openCypher compatibility with Neo4j Cypher

Neptune implements the **openCypher specification** (Cypher Query Language
Reference Version 9). Neo4j's Cypher is a *superset* of that spec — it adds
proprietary extensions, APOC procedures, and the Graph Data Science library.
This file enumerates the gaps that matter for a new codebase.

## The important framing

The self-hosted analysis already calls out three Cypher guardrails to follow
for the Neptune exit (no APOC, no list-type node properties, no `FOREACH` in
writes).
Those guardrails remain correct. This doc adds the full gap table so the
impact on a new codebase is concrete, not assumed.

For a **new codebase that has not yet written a single query**, most of these
gaps are non-issues: you just don't use the unsupported features. The cost
is a bounded one-time design constraint, not an ongoing migration burden.

## Supported (works as expected)

The common CRUD and traversal vocabulary works:

```cypher
MATCH (n:Person {name: $name})-[:KNOWS]->(m)
RETURN m.name, m.age
ORDER BY m.age DESC
LIMIT 10
```

Supported clauses: `MATCH`, `OPTIONAL MATCH`, `RETURN`, `WITH`, `UNWIND`,
`WHERE`, `ORDER BY`, `SKIP` (static values), `LIMIT` (static values),
`CREATE`, `DELETE`, `DETACH DELETE`, `SET`, `REMOVE`, `MERGE`, `UNION`,
`UNION ALL` (read queries).

Supported operators: all arithmetic except `^`, all comparison, `AND/OR/XOR/NOT`,
string `STARTS WITH / ENDS WITH / CONTAINS`, list `IN`.

Supported functions: `collect()`, `count()`, `avg()`, `min()`, `max()`,
`sum()`, `exists()`, `coalesce()`, `id()`, `type()`, `labels()`,
`keys()`, `properties()`, `nodes()`, `relationships()`, `length()`,
`size()`, `head()`, `last()`, `tail()`, `reverse()`, `range()`,
`split()`, `substring()`, `toLower()`, `toUpper()`, `trim()`, `replace()`,
`toInteger()`, `toFloat()`, `toBoolean()`, `toString()`, `randomUUID()`,
`timestamp()`, `datetime()`, `abs()`, `ceil()`, `floor()`, `round()`,
`sqrt()`, `rand()` and all standard trig functions.

## Gaps that need attention

### 1. `shortestPath()` / `allShortestPaths()` — **NOT supported in MATCH**

```cypher
-- Does NOT work in Neptune:
MATCH p = shortestPath((a:Person)-[*]-(b:Person {name: $name}))
RETURN p
```

**Impact:** If the graph data model relies on shortest-path queries
(common in social graphs, routing, recommendations), this is a genuine
capability gap. Neptune supports variable-length path traversals (`[*1..5]`)
which can approximate shortest path, but not with the same conciseness or
performance guarantees.

**Workaround:** Implement shortest-path logic in application code using
BFS/DFS over `MATCH (a)-[*1..N]-(b)` results, or use Neptune Analytics
(a separate in-memory engine for graph algorithms including shortest path)
for offline or batch analytics.

**Pre-assessment for new codebases:** Does the data model require real-time
shortest-path queries for user-facing features? If yes, this is a significant
constraint. If shortest-path is analytics-only (batch), Neptune Analytics
handles it.

### 2. `CALL [YIELD ...]` — **NOT supported**

```cypher
-- Does NOT work:
CALL db.schema.visualization()
CALL apoc.util.sleep(100)
```

**Impact:** APOC procedures and any `CALL` to built-in procedures are
unavailable. In practice, APOC is commonly used for:
- Mass updates via `apoc.periodic.iterate` → rewrite with `UNWIND` + batching
- Data imports (`apoc.load.json`, `apoc.load.csv`) → use Neptune bulk loader
  or application-side loading instead
- Graph algorithms → use Neptune Analytics or application-side BFS/DFS

For a new codebase that hasn't yet accumulated APOC dependencies, the
constraint is: **don't design any query that requires a procedure call**.

### 3. No APOC, no Graph Data Science library

No APOC community or core. No GDS algorithms (`gds.pageRank`,
`gds.louvain`, etc.). Graph analytics must go through Neptune Analytics
(separate cluster, separate cost) or application-side implementations.

**Impact for OLTP graph:** Low. APOC/GDS are primarily analytics tools.
Standard OLTP queries (traversals, lookups, aggregations) do not need them.

### 4. No multi-valued properties

Neo4j allows a property to hold a list value:
```cypher
CREATE (n:Person {tags: ['engineer', 'manager']})
```

Neptune does not support multi-valued properties on nodes or relationships.
**This is a data-model constraint**, not just a query constraint.

**Workaround:** Model multi-valued attributes as relationships to separate
nodes (the idiomatic graph approach), or as a delimited string + `SPLIT()`
at query time. For a new codebase: design the data model without list-typed
properties from the start.

### 5. No schema constraints (beyond ID uniqueness)

Neo4j supports `CREATE CONSTRAINT ON (n:Person) ASSERT n.email IS UNIQUE`.
Neptune's only uniqueness constraint is on the internal node/relationship ID.
Property-level uniqueness and existence constraints do not exist.

**Workaround:** Enforce constraints at the application layer or use the node
ID as the unique identifier (Neptune lets you set custom string IDs).

### 6. Node IDs are strings

`id(n)` returns a **String** in Neptune, an Integer in Neo4j.
Neptune lets you set custom IDs:
```cypher
CREATE (n:Person {~id: 'person-42', name: 'Alice'})
```

**Impact:** If application code compares `id(n)` values or stores them in
other tables as integers, these need to be treated as strings.

### 7. Non-static `SKIP`/`LIMIT` not supported

```cypher
-- Does NOT work:
RETURN n LIMIT toInteger(rand())
```

In practice almost no production query uses a dynamic LIMIT. Low impact.

### 8. `^` exponentiation operator not supported

Use `sqrt()`, `exp()`, `log()` etc. instead. Low impact for graph queries.

### 9. Variable-length path property filters must be constant

```cypher
-- Does NOT work:
MATCH (x)-[:route*1..2 {dist: x.name}]->(y) RETURN x,y
```

Only constant values in VLP property predicates. Affects complex routing
queries with dynamic predicates. Generally a niche pattern.

## Summary gap table

| Feature | Neptune | Impact for new codebase |
|---|---|---|
| `shortestPath()` in MATCH | Not supported | Medium — avoid if user-facing; use Neptune Analytics for batch |
| `CALL [YIELD...]` / APOC | Not supported | Low — don't design APOC dependencies |
| Graph Data Science | Not supported | Low — use Neptune Analytics for algorithms |
| Multi-valued properties | Not supported | Medium — design model without list properties |
| Schema constraints | Not supported (ID only) | Low — enforce at app layer |
| `MANDATORY MATCH` | Not supported | Negligible |
| `UNION` for mutations | Not supported | Negligible |
| `^` exponent operator | Not supported | Negligible |
| Dynamic SKIP/LIMIT | Not supported | Negligible |
| `id()` returns String | Yes (not Integer) | Low — treat IDs as strings |

## Net verdict

For a new graph codebase with no accumulated Cypher debt, the gap is
**narrow and designable-around**. The two constraints that require
*design-time* decisions (not just query rewrites) are:

1. **No multi-valued list properties** — design the data model as pure graph
   (nodes and edges) rather than a hybrid document-graph.
2. **No `shortestPath()` in MATCH** — if real-time shortest-path queries are
   user-facing, evaluate Neptune Analytics or application-side BFS as an
   alternative before committing to Neptune.

Everything else is either a procedure-call pattern you wouldn't use in a new
codebase, or syntax-level differences with straightforward substitutions.
