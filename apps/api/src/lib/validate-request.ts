/**
 * Request Validation Helpers
 *
 * Efficient validation utilities for request bodies and query parameters.
 * Optimized for performance with early returns and minimal overhead.
 */

import { z, ZodError, ZodSchema } from "zod";

/**
 * Validation result type
 */
export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: globalThis.Response };

/**
 * Validate request body against a Zod schema
 *
 * @param request - Request object
 * @param schema - Zod schema to validate against
 * @returns Validation result with parsed data or error response
 */
export async function validateRequest<T>(
  request: Request,
  schema: ZodSchema<T>,
): Promise<ValidationResult<T>> {
  try {
    // Parse JSON once
    const body = await request.json();

    // Validate against schema (Zod handles type coercion and validation)
    const data = schema.parse(body);

    return { success: true, data };
  } catch (error) {
    // Handle Zod validation errors
    if (error instanceof ZodError) {
      return {
        success: false,
        error: new Response(
          JSON.stringify({
            error: "Validation failed",
            details: error.issues.map((e) => ({
              path: e.path.join("."),
              message: e.message,
            })),
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        ),
      };
    }

    // Handle JSON parsing errors
    if (error instanceof SyntaxError) {
      return {
        success: false,
        error: new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      };
    }

    // Handle other errors
    return {
      success: false,
      error: new Response(JSON.stringify({ error: "Invalid request body" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    };
  }
}

/**
 * Validate query parameters against a Zod schema
 *
 * Optimized: Converts URLSearchParams to object once, then validates.
 * Uses z.coerce for automatic type conversion (string -> number, etc.)
 *
 * @param url - URL object with searchParams
 * @param schema - Zod schema to validate against
 * @returns Validation result with parsed data or error response
 */
export function validateQueryParams<T>(
  url: URL,
  schema: ZodSchema<T>,
): ValidationResult<T> {
  try {
    // Convert URLSearchParams to plain object (efficient)
    const params: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      params[key] = value;
    });

    // Validate against schema (Zod handles coercion)
    const data = schema.parse(params);

    return { success: true, data };
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        success: false,
        error: new Response(
          JSON.stringify({
            error: "Invalid query parameters",
            details: error.issues.map((e) => ({
              path: e.path.join("."),
              message: e.message,
            })),
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        ),
      };
    }

    return {
      success: false,
      error: new Response(
        JSON.stringify({ error: "Invalid query parameters" }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      ),
    };
  }
}

/**
 * Safe JSON parse with validation
 *
 * Wrapper for request.json() that handles errors gracefully
 *
 * @param request - Request object
 * @returns Parsed JSON or null if invalid
 */
export async function safeJsonParse<T = unknown>(
  request: Request,
): Promise<T | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
