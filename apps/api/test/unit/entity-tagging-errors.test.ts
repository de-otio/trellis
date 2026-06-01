/**
 * Unit tests for entity-tagging error classes.
 *
 * Handlers map the `code` and `statusCode` fields from these errors onto HTTP
 * responses — a drift in either field would silently change API error
 * semantics visible to clients.
 */

import { describe, expect, it } from "vitest";
import {
  EntityLimitExceededError,
  EntityTaggingError,
  EntityTaggingPermissionError,
  InvalidEntitiesError,
} from "../../src/lib/entity-tagging-errors.js";

// ---------------------------------------------------------------------------
// EntityTaggingError (base)
// ---------------------------------------------------------------------------

describe("EntityTaggingError (base)", () => {
  it("stores the message passed to the constructor", () => {
    const err = new EntityTaggingError("something went wrong", "SOME_CODE");
    expect(err.message).toBe("something went wrong");
  });

  it("stores the code passed to the constructor", () => {
    const err = new EntityTaggingError("msg", "MY_CODE");
    expect(err.code).toBe("MY_CODE");
  });

  it("defaults statusCode to 400", () => {
    const err = new EntityTaggingError("msg", "MY_CODE");
    expect(err.statusCode).toBe(400);
  });

  it("honors a custom statusCode", () => {
    const err = new EntityTaggingError("msg", "MY_CODE", 422);
    expect(err.statusCode).toBe(422);
  });

  it('sets name to "EntityTaggingError"', () => {
    const err = new EntityTaggingError("msg", "MY_CODE");
    expect(err.name).toBe("EntityTaggingError");
  });

  it("is an instance of Error", () => {
    const err = new EntityTaggingError("msg", "MY_CODE");
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// InvalidEntitiesError
// ---------------------------------------------------------------------------

describe("InvalidEntitiesError", () => {
  it('has code "INVALID_ENTITIES"', () => {
    expect(new InvalidEntitiesError().code).toBe("INVALID_ENTITIES");
  });

  it("has statusCode 400", () => {
    expect(new InvalidEntitiesError().statusCode).toBe(400);
  });

  it('sets name to "InvalidEntitiesError"', () => {
    expect(new InvalidEntitiesError().name).toBe("InvalidEntitiesError");
  });

  it("has a non-empty default message", () => {
    const msg = new InvalidEntitiesError().message;
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(0);
  });

  it("honors a custom message", () => {
    expect(new InvalidEntitiesError("bad ids").message).toBe("bad ids");
  });

  it("is an instanceof EntityTaggingError", () => {
    expect(new InvalidEntitiesError()).toBeInstanceOf(EntityTaggingError);
  });

  it("is an instanceof Error", () => {
    expect(new InvalidEntitiesError()).toBeInstanceOf(Error);
  });

  it("is throwable and catchable as EntityTaggingError with correct code+status", () => {
    expect.assertions(2);
    try {
      throw new InvalidEntitiesError();
    } catch (err) {
      expect(err).toBeInstanceOf(EntityTaggingError);
      const e = err as EntityTaggingError;
      expect({ code: e.code, statusCode: e.statusCode }).toEqual({
        code: "INVALID_ENTITIES",
        statusCode: 400,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// EntityTaggingPermissionError
// ---------------------------------------------------------------------------

describe("EntityTaggingPermissionError", () => {
  it('has code "PERMISSION_DENIED"', () => {
    expect(new EntityTaggingPermissionError().code).toBe("PERMISSION_DENIED");
  });

  it("has statusCode 403", () => {
    expect(new EntityTaggingPermissionError().statusCode).toBe(403);
  });

  it('sets name to "EntityTaggingPermissionError"', () => {
    expect(new EntityTaggingPermissionError().name).toBe(
      "EntityTaggingPermissionError",
    );
  });

  it("has a non-empty default message", () => {
    const msg = new EntityTaggingPermissionError().message;
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(0);
  });

  it("honors a custom message", () => {
    expect(new EntityTaggingPermissionError("not allowed").message).toBe(
      "not allowed",
    );
  });

  it("is an instanceof EntityTaggingError", () => {
    expect(new EntityTaggingPermissionError()).toBeInstanceOf(
      EntityTaggingError,
    );
  });

  it("is an instanceof Error", () => {
    expect(new EntityTaggingPermissionError()).toBeInstanceOf(Error);
  });

  it("is throwable and catchable as EntityTaggingError with correct code+status", () => {
    expect.assertions(2);
    try {
      throw new EntityTaggingPermissionError();
    } catch (err) {
      expect(err).toBeInstanceOf(EntityTaggingError);
      const e = err as EntityTaggingError;
      expect({ code: e.code, statusCode: e.statusCode }).toEqual({
        code: "PERMISSION_DENIED",
        statusCode: 403,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// EntityLimitExceededError
// ---------------------------------------------------------------------------

describe("EntityLimitExceededError", () => {
  it('has code "ENTITY_LIMIT_EXCEEDED"', () => {
    expect(new EntityLimitExceededError(10).code).toBe("ENTITY_LIMIT_EXCEEDED");
  });

  it("has statusCode 400", () => {
    expect(new EntityLimitExceededError(10).statusCode).toBe(400);
  });

  it('sets name to "EntityLimitExceededError"', () => {
    expect(new EntityLimitExceededError(10).name).toBe(
      "EntityLimitExceededError",
    );
  });

  it("interpolates maxEntities into the message", () => {
    expect(new EntityLimitExceededError(5).message).toContain("5");
    expect(new EntityLimitExceededError(25).message).toContain("25");
  });

  it("is an instanceof EntityTaggingError", () => {
    expect(new EntityLimitExceededError(10)).toBeInstanceOf(EntityTaggingError);
  });

  it("is an instanceof Error", () => {
    expect(new EntityLimitExceededError(10)).toBeInstanceOf(Error);
  });

  it("is throwable and catchable as EntityTaggingError with correct code+status", () => {
    expect.assertions(2);
    try {
      throw new EntityLimitExceededError(3);
    } catch (err) {
      expect(err).toBeInstanceOf(EntityTaggingError);
      const e = err as EntityTaggingError;
      expect({ code: e.code, statusCode: e.statusCode }).toEqual({
        code: "ENTITY_LIMIT_EXCEEDED",
        statusCode: 400,
      });
    }
  });
});
