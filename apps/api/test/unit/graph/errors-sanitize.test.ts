import { describe, expect, it } from "vitest";
import {
  GraphConnectionError,
  GraphQueryError,
  GraphNotFoundError,
  GraphConflictError,
  GraphAuthorizationError,
  GraphTimeoutError,
  sanitizeGraphErrorMessage,
} from "../../../src/lib/graph/errors.js";

describe("GraphError sanitize()", () => {
  describe("Bolt URI redaction", () => {
    it("redacts bolt+s:// URIs and leaves no trace of the host", () => {
      const err = new GraphConnectionError(
        "Connection refused: bolt+s://abc123.databases.neo4j.io:7687",
      );
      expect(err.message).toContain("[bolt-uri-redacted]");
      expect(err.message).not.toContain("abc123");
      expect(err.message).not.toContain("bolt+s://");
    });

    it("redacts plain bolt:// URIs", () => {
      const err = new GraphQueryError(
        "Failed to connect: bolt://somehost.databases.neo4j.io",
        undefined,
      );
      expect(err.message).toContain("[bolt-uri-redacted]");
      expect(err.message).not.toContain("bolt://");
    });

    it("redacts neo4j+s:// URIs", () => {
      const err = new GraphConnectionError(
        "Unreachable: neo4j+s://xyz789.databases.neo4j.io:7687/db",
      );
      expect(err.message).toContain("[bolt-uri-redacted]");
      expect(err.message).not.toContain("xyz789");
    });
  });

  describe("Aura host redaction", () => {
    it("redacts bare neo4j.io host mentions", () => {
      const err = new GraphConnectionError(
        "Failed to reach abc123.databases.neo4j.io",
      );
      expect(err.message).toContain("[aura-host-redacted]");
      expect(err.message).not.toContain("abc123");
    });

    it("redacts neo4j.io host with port", () => {
      const err = new GraphConnectionError(
        "Timeout connecting to mydb.databases.neo4j.io:7687",
      );
      expect(err.message).toContain("[aura-host-redacted]");
      expect(err.message).not.toContain("mydb");
    });
  });

  describe("Neptune host redaction", () => {
    it("redacts a bare Neptune cluster endpoint (writer)", () => {
      const err = new GraphConnectionError(
        "Failed to reach mycluster.cluster-abc123.eu-central-1.neptune.amazonaws.com",
      );
      expect(err.message).toContain("[neptune-host-redacted]");
      expect(err.message).not.toContain("mycluster");
      expect(err.message).not.toContain("eu-central-1");
    });

    it("redacts a Neptune reader endpoint with port", () => {
      const err = new GraphConnectionError(
        "Timeout connecting to mycluster.cluster-ro-abc123.eu-central-1.neptune.amazonaws.com:8182",
      );
      expect(err.message).toContain("[neptune-host-redacted]");
      expect(err.message).not.toContain("cluster-ro");
    });

    it("redacts a bolt+s:// Neptune URI via the URI rule", () => {
      const err = new GraphConnectionError(
        "Connection refused: bolt+s://mycluster.cluster-abc.eu-central-1.neptune.amazonaws.com:8182",
      );
      expect(err.message).toContain("[bolt-uri-redacted]");
      expect(err.message).not.toContain("mycluster");
      expect(err.message).not.toContain("neptune.amazonaws.com");
    });
  });

  describe("Password/token redaction", () => {
    it("preserves the password= key but redacts the value", () => {
      const err = new GraphAuthorizationError(
        "auth failed (user=neo4j password=secret123)",
      );
      expect(err.message).toContain("password=[redacted]");
      expect(err.message).not.toContain("secret123");
    });

    it("redacts passwd= tokens", () => {
      const err = new GraphAuthorizationError("connect error: passwd=hunter2");
      expect(err.message).toContain("passwd=[redacted]");
      expect(err.message).not.toContain("hunter2");
    });

    it("redacts pwd: tokens", () => {
      const err = new GraphAuthorizationError("login error: pwd:mypassword");
      expect(err.message).toContain("pwd=[redacted]");
      expect(err.message).not.toContain("mypassword");
    });
  });

  describe("Postgres/Prisma redaction (the live backend)", () => {
    it("redacts a postgresql:// DSN with inline credentials", () => {
      const err = new GraphConnectionError(
        "connect ECONNREFUSED postgresql://app_user:s3cretpw@db.internal.example:5432/trellis",
      );
      expect(err.message).toContain("[pg-uri-redacted]");
      expect(err.message).not.toContain("s3cretpw");
      expect(err.message).not.toContain("app_user");
      expect(err.message).not.toContain("db.internal.example");
    });

    it("redacts a postgres:// (short-scheme) DSN", () => {
      const err = new GraphConnectionError(
        "could not connect: postgres://u:pw@10.0.0.5/db",
      );
      expect(err.message).toContain("[pg-uri-redacted]");
      expect(err.message).not.toContain("10.0.0.5");
      expect(err.message).not.toContain("pw@");
    });

    it("redacts Prisma's backtick-quoted host (P1001 shape)", () => {
      const err = new GraphConnectionError(
        "Can't reach database server at `db.internal.example`:`5432`",
      );
      expect(err.message).toContain("[db-host-redacted]");
      expect(err.message).not.toContain("db.internal.example");
      expect(err.message).not.toContain("5432");
    });

    it("redacts Prisma's single-backtick host:port variant", () => {
      const err = new GraphConnectionError(
        "Can't reach database server at `db.internal.example:5432`",
      );
      expect(err.message).toContain("[db-host-redacted]");
      expect(err.message).not.toContain("db.internal.example");
    });

    it("redacts libpq's quoted host + ip + port shape", () => {
      const err = new GraphConnectionError(
        'connection to server at "db.internal.example" (10.0.0.5), port 5432 failed: timeout',
      );
      expect(err.message).toContain("[db-host-redacted]");
      expect(err.message).not.toContain("db.internal.example");
      expect(err.message).not.toContain("10.0.0.5");
    });

    it("sanitizeGraphErrorMessage covers the non-GraphError path (healthCheck)", () => {
      const out = sanitizeGraphErrorMessage(
        "probe failed: postgresql://u:leakedpw@host.example/db (password=leakedpw)",
      );
      expect(out).not.toContain("leakedpw");
      expect(out).not.toContain("host.example");
    });
  });

  describe("Pass-through: safe messages are unchanged", () => {
    it("does not alter a safe error message", () => {
      const safeMessage = "Query failed: syntax error at line 5";
      const err = new GraphQueryError(safeMessage, "MATCH (n) RETURN n");
      expect(err.message).toBe(safeMessage);
    });

    it("does not alter a plain not-found message", () => {
      const safeMessage = "Node not found";
      const err = new GraphNotFoundError(safeMessage, "User", "user-123");
      expect(err.message).toBe(safeMessage);
    });
  });

  describe("GraphConnectionError with Bolt URI in message", () => {
    it("has sanitized .message and correct .code", () => {
      const err = new GraphConnectionError(
        "Connection refused: bolt+s://abc123.databases.neo4j.io:7687",
      );
      expect(err.message).toContain("[bolt-uri-redacted]");
      expect(err.message).not.toContain("abc123");
      expect(err.code).toBe("GRAPH_CONNECTION_ERROR");
    });
  });

  describe("Other subclasses sanitize at construction", () => {
    it("GraphQueryError sanitizes message", () => {
      const err = new GraphQueryError(
        "Driver error: bolt://leak.databases.neo4j.io",
        "MATCH (n) RETURN n",
      );
      expect(err.message).not.toContain("leak");
      expect(err.code).toBe("GRAPH_QUERY_ERROR");
    });

    it("GraphConflictError sanitizes message", () => {
      const err = new GraphConflictError(
        "Conflict: neo4j+s://leak.databases.neo4j.io/path",
      );
      expect(err.message).not.toContain("leak");
      expect(err.code).toBe("GRAPH_CONFLICT");
    });

    it("GraphTimeoutError sanitizes message", () => {
      const err = new GraphTimeoutError(
        "Timeout on bolt://leak.databases.neo4j.io",
        5000,
      );
      expect(err.message).not.toContain("leak");
      expect(err.code).toBe("GRAPH_TIMEOUT");
    });
  });
});
