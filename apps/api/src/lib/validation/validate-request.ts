/**
 * Request Validation Middleware
 *
 * Helper functions for validating API requests using Zod schemas.
 * Provides consistent error handling and response formatting.
 */

import { z, ZodError, ZodSchema } from "zod";

/**
 * Validation error response format
 */
export interface ValidationErrorResponse {
  error: {
    code: "VALIDATION_ERROR";
    message: string;
    details: Array<{
      field: string;
      message: string;
    }>;
  };
}

/**
 * Validate request body against a Zod schema
 *
 * @param schema - Zod schema to validate against
 * @param data - Data to validate
 * @returns Validated data or throws ValidationError
 * @throws {ValidationError} If validation fails
 */
export function validateBody<T extends ZodSchema>(
  schema: T,
  data: unknown,
): z.infer<T> {
  // Ensure data is defined before validation
  if (data === undefined || data === null) {
    throw new ValidationError("Validation failed", [
      {
        code: "invalid_type",
        expected: "object",
        path: [],
        message: "Request body is required",
      },
    ]);
  }

  try {
    // Wrap in try-catch to handle any unexpected errors during parsing
    const result = schema.parse(data);
    return result;
  } catch (error) {
    // If error is about accessing 'length' on undefined, provide a clearer error
    if (
      error instanceof Error &&
      error.message.includes(
        "Cannot read properties of undefined (reading 'length')",
      )
    ) {
      throw new ValidationError("Validation failed: Invalid data type", [
        {
          code: "invalid_type",
          expected: "object",
          path: [],
          message: "Request body contains invalid data types",
        },
      ]);
    }

    if (error instanceof ZodError) {
      const validationError = new ValidationError(
        "Validation failed",
        error.issues,
      );
      throw validationError;
    }
    throw error;
  }
}

/**
 * Validate query parameters against a Zod schema
 *
 * @param schema - Zod schema to validate against
 * @param params - Query parameters to validate
 * @returns Validated data or throws ValidationError
 * @throws {ValidationError} If validation fails
 */
export function validateQuery<T extends ZodSchema>(
  schema: T,
  params: Record<string, string | undefined>,
): z.infer<T> {
  try {
    // Convert query params to object, handling optional values
    const queryObj: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        queryObj[key] = value;
      }
    }
    return schema.parse(queryObj);
  } catch (error) {
    if (error instanceof ZodError) {
      const validationError = new ValidationError(
        "Query parameter validation failed",
        error.issues,
      );
      throw validationError;
    }
    throw error;
  }
}

/**
 * Validate path parameters
 *
 * @param schema - Zod schema to validate against
 * @param value - Path parameter value to validate
 * @returns Validated data or throws ValidationError
 * @throws {ValidationError} If validation fails
 */
export function validatePathParam<T extends ZodSchema>(
  schema: T,
  value: string,
): z.infer<T> {
  // Ensure value is a string before validation
  if (value === undefined || value === null || typeof value !== "string") {
    throw new ValidationError("Path parameter validation failed", [
      {
        code: "invalid_type",
        expected: "string",
        path: [],
        message: `Path parameter must be a string, received ${value === null ? "null" : typeof value}`,
      },
    ]);
  }

  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      const validationError = new ValidationError(
        "Path parameter validation failed",
        error.issues,
      );
      throw validationError;
    }
    throw error;
  }
}

/**
 * Custom validation error class
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly zodErrors: z.ZodIssue[],
  ) {
    super(message);
    this.name = "ValidationError";
  }

  /**
   * Convert validation error to API response format
   */
  toResponse(): ValidationErrorResponse {
    return {
      error: {
        code: "VALIDATION_ERROR",
        message: this.message,
        details: this.zodErrors.map((err) => ({
          field: err.path.join("."),
          message: err.message,
        })),
      },
    };
  }

  /**
   * Get HTTP status code for validation error
   */
  getStatusCode(): number {
    return 400; // Bad Request
  }
}

/**
 * Safe validation wrapper that catches errors and returns formatted response
 *
 * @param schema - Zod schema to validate against
 * @param data - Data to validate
 * @returns Object with success flag and either validated data or error response
 */
export function safeValidate<T extends ZodSchema>(
  schema: T,
  data: unknown,
): {
  success: boolean;
  data?: z.infer<T>;
  error?: ValidationErrorResponse;
} {
  try {
    const validated = validateBody(schema, data);
    return { success: true, data: validated };
  } catch (error) {
    if (error instanceof ValidationError) {
      return { success: false, error: error.toResponse() };
    }
    // Unexpected error
    return {
      success: false,
      error: {
        error: {
          code: "VALIDATION_ERROR",
          message: "An unexpected validation error occurred",
          details: [],
        },
      },
    };
  }
}
