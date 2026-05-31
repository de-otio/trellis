import { describe, expect, it } from "vitest";
import {
  GraphConnectionError,
  GraphQueryError,
  GraphNotFoundError,
  GraphConflictError,
  GraphAuthorizationError,
  GraphTimeoutError,
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
