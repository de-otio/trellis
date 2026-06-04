/**
 * Entity Tagging Error Classes
 *
 * Custom error classes for entity tagging operations with consistent error codes.
 */

/**
 * Base error class for entity tagging errors
 */
export class EntityTaggingError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = "EntityTaggingError";
  }
}

/**
 * Error when entities are not found or invalid
 */
export class InvalidEntitiesError extends EntityTaggingError {
  constructor(message: string = "One or more entities are invalid") {
    super(message, "INVALID_ENTITIES", 400);
    this.name = "InvalidEntitiesError";
  }
}

/**
 * Error when user doesn't have permission to tag entities
 */
export class EntityTaggingPermissionError extends EntityTaggingError {
  constructor(
    message: string = "You do not have permission to tag one or more of the specified entities",
  ) {
    super(message, "PERMISSION_DENIED", 403);
    this.name = "EntityTaggingPermissionError";
  }
}

/**
 * Error when too many entities are tagged
 */
export class EntityLimitExceededError extends EntityTaggingError {
  constructor(maxEntities: number) {
    super(
      `Maximum number of entities per post is ${maxEntities}`,
      "ENTITY_LIMIT_EXCEEDED",
      400,
    );
    this.name = "EntityLimitExceededError";
  }
}
