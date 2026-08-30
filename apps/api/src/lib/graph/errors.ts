/**
 * Graph Service Errors
 *
 * Custom error types for the GraphService abstraction.
 * These provide structured error information that handlers can use
 * to return appropriate HTTP responses.
 */

// Strip Bolt URIs and anything that looks like a password before the message
// reaches Error.message (and hence logs + optional 5xx body echoes).
// Matches bolt://, bolt+s://, neo4j://, neo4j+s://, and bare host refs for
// both AuraDB (*.databases.neo4j.io) and Neptune (*.neptune.amazonaws.com).
const BOLT_URI = /(bolt\+?s?|neo4j\+?s?):\/\/[^\s"']+/gi;
const NEO4J_HOST = /\b[a-z0-9]+\.databases\.neo4j\.io(?::\d+)?/gi;
// Neptune endpoints: <cluster>.cluster[-ro]-<hash>.<region>.neptune.amazonaws.com
// (and reader/instance variants) — match any subdomain of neptune.amazonaws.com.
const NEPTUNE_HOST = /\b[a-z0-9.-]+\.neptune\.amazonaws\.com(?::\d+)?/gi;
// Password-like tokens in driver error messages (e.g., "authentication failure (user=neo4j password=...)").
const PASSWORD_TOKEN = /\b(password|passwd|pwd)\s*[=:]\s*\S+/gi;
// Postgres is the live backend (Neo4j/Neptune retired); its driver errors leak
// differently: a full DSN with inline credentials (pg's ECONNREFUSED echoes the
// connection string), Prisma's backtick-quoted host in P1000/P1001 messages
// ("Can't reach database server at `host`:`5432`"), and libpq's
// 'connection to server at "host" (ip), port 5432 failed'.
const PG_URI = /postgres(?:ql)?:\/\/[^\s"']+/gi;
const PRISMA_DB_HOST = /\bat\s+`[^`\s]+`(?:\s*:\s*`?\d+`?)?/gi;
const LIBPQ_HOST = /\bat\s+"[^"\s]+"(?:\s*\([0-9a-fA-F:.]+\))?(?:,\s*port\s+\d+)?/gi;

function sanitize(msg: string): string {
  return msg
    .replace(BOLT_URI, "[bolt-uri-redacted]")
    .replace(NEO4J_HOST, "[aura-host-redacted]")
    .replace(NEPTUNE_HOST, "[neptune-host-redacted]")
    .replace(PG_URI, "[pg-uri-redacted]")
    .replace(PRISMA_DB_HOST, "at [db-host-redacted]")
    .replace(LIBPQ_HOST, "at [db-host-redacted]")
    .replace(PASSWORD_TOKEN, "$1=[redacted]");
}

/**
 * Sanitize a raw driver error message WITHOUT wrapping it in a GraphError —
 * for paths that surface `error.message` in a response body directly (the
 * health check is pre-auth reachable, and pg/Prisma errors can embed the DSN).
 */
export function sanitizeGraphErrorMessage(msg: string): string {
  return sanitize(msg);
}

/**
 * Base class for all graph service errors.
 * Extends Error with a `code` field for programmatic error handling.
 */
export abstract class GraphError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(sanitize(message), options);
    this.name = this.constructor.name;
  }
}

/**
 * The graph database is unreachable or the connection failed.
 *
 * This typically indicates a network issue, a misconfigured endpoint,
 * or the database being down. Handlers should return 503 and the caller
 * may retry after a backoff.
 */
export class GraphConnectionError extends GraphError {
  readonly code = "GRAPH_CONNECTION_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * A query against the graph database failed.
 *
 * This covers syntax errors, constraint violations, timeouts,
 * and other query-level failures. The `query` field (if set)
 * contains the Cypher query that failed (sanitized of parameters).
 */
export class GraphQueryError extends GraphError {
  readonly code = "GRAPH_QUERY_ERROR";
  readonly query?: string;

  constructor(message: string, query?: string, options?: ErrorOptions) {
    super(message, options);
    this.query = query;
  }
}

/**
 * The requested node or edge does not exist in the graph.
 *
 * Handlers should return 404 when this is thrown for a primary lookup.
 */
export class GraphNotFoundError extends GraphError {
  readonly code = "GRAPH_NOT_FOUND";
  readonly nodeType?: string;
  readonly nodeId?: string;

  constructor(message: string, nodeType?: string, nodeId?: string, options?: ErrorOptions) {
    super(message, options);
    this.nodeType = nodeType;
    this.nodeId = nodeId;
  }
}

/**
 * A write operation conflicts with existing graph state.
 *
 * Examples: creating a duplicate relationship, creating a relationship
 * to a non-existent node, or confirming an already-confirmed entity
 * relationship.
 *
 * Handlers should return 409.
 */
export class GraphConflictError extends GraphError {
  readonly code = "GRAPH_CONFLICT";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * The operation is not permitted for the given user/entity.
 *
 * Examples: attempting to create an entity relationship when the user
 * does not own the source entity, or trying to modify a relationship
 * that belongs to another user.
 *
 * Handlers should return 403.
 */
export class GraphAuthorizationError extends GraphError {
  readonly code = "GRAPH_AUTHORIZATION_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * A query exceeded the allowed execution time.
 *
 * Neo4j supports query timeouts. This error is thrown
 * when a traversal or aggregation takes too long, typically for
 * deeply connected graphs or expensive discovery queries.
 *
 * Handlers should return 504.
 */
export class GraphTimeoutError extends GraphError {
  readonly code = "GRAPH_TIMEOUT";
  readonly timeoutMs?: number;

  constructor(message: string, timeoutMs?: number, options?: ErrorOptions) {
    super(message, options);
    this.timeoutMs = timeoutMs;
  }
}
