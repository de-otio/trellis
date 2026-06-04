/**
 * Shared helpers for the Postgres GraphService adapter.
 *
 * Graph-DB revisit (2026-06): the graph serving path runs in Postgres
 * (joins + recursive CTEs), no separate graph DB. See
 * plans/redesign/graph-backend-contract.md.
 *
 * Phase 0 lands the scaffold (this dir) behind the `GRAPH_BACKEND=postgres`
 * factory flag; the default backend stays Neo4j, so nothing changes until
 * Phase 1 fills in each group module and the flag is flipped.
 */

/** Thrown by not-yet-ported adapter methods so a premature flip fails loudly. */
export class GraphNotImplementedError extends Error {
  constructor(group: string, method: string) {
    super(
      `PostgresGraphService.${method} not yet implemented (Phase 1 — ${group}). ` +
        `See plans/redesign/graph-db/graph-db-postgres-migration-plan.md`,
    );
    this.name = "GraphNotImplementedError";
  }
}

/** Stub marker for unported methods. Returns `never` (always throws). */
export function ni(group: string, method: string): never {
  throw new GraphNotImplementedError(group, method);
}
