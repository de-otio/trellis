/**
 * Input Sanitization
 *
 * Provides input sanitization utilities to prevent XSS attacks.
 * Uses regex-based sanitization for Cloudflare Workers compatibility.
 */

/**
 * Input Sanitizer utility class
 */
export class InputSanitizer {
  /**
   * Sanitize plain text input - removes all HTML tags
   * Use this for user-generated text that should be plain text only
   *
   * @param input - The input string to sanitize
   * @returns Sanitized string with all HTML removed
   */
  static sanitizeText(input: string): string {
    // Handle non-string types safely
    if (typeof input !== "string") {
      // Symbols cannot be converted to string directly in some contexts
      if (typeof input === "symbol") {
        return "";
      }
      // For other types, try to convert safely
      try {
        return String(input);
      } catch {
        // If conversion fails, return empty string
        return "";
      }
    }

    // First, remove script tags and their content (most dangerous)
    // This regex matches <script>...</script> including all content between tags
    let sanitized = input.replace(
      /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
      "",
    );

    // Remove style tags and their content
    sanitized = sanitized.replace(
      /<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi,
      "",
    );

    // Remove all other HTML tags using regex (safe for Cloudflare Workers)
    // This regex matches any HTML tag including attributes
    sanitized = sanitized.replace(/<[^>]*>/g, "");

    // Remove all HTML entities (numeric and named) for security
    // This prevents XSS attacks via encoded entities
    sanitized = sanitized.replace(/&#\d+;/g, "");
    sanitized = sanitized.replace(/&[a-zA-Z]+;/g, "");

    return sanitized;
  }

  /**
   * Sanitize HTML input - allows safe HTML tags only
   * Use this for user-generated content that may contain formatting
   *
   * @param input - The input string to sanitize
   * @returns Sanitized string with only safe HTML tags
   */
  static sanitizeHTML(input: string): string {
    // Handle non-string types safely
    if (typeof input !== "string") {
      // Symbols cannot be converted to string directly in some contexts
      if (typeof input === "symbol") {
        return "";
      }
      // For other types, try to convert safely
      try {
        return String(input);
      } catch {
        // If conversion fails, return empty string
        return "";
      }
    }

    // For Cloudflare Workers, use a simpler approach
    // Remove all tags except allowed ones, then remove all attributes
    const allowedTags = ["p", "br", "strong", "em", "u", "b", "i"];
    const allowedTagsPattern = allowedTags.join("|");

    // First, remove all tags except allowed ones
    let sanitized = input.replace(
      new RegExp(`<(?!\/?(?:${allowedTagsPattern})(?:\\s|>))[^>]+>`, "gi"),
      "",
    );

    // Remove all attributes from allowed tags (keep only tag names)
    allowedTags.forEach((tag) => {
      sanitized = sanitized.replace(
        new RegExp(`<${tag}\\s+[^>]*>`, "gi"),
        `<${tag}>`,
      );
    });

    return sanitized;
  }

  /**
   * Recursively sanitize JSON data
   * Sanitizes all string values in objects and arrays
   *
   * @param data - The data to sanitize (can be any type)
   * @returns Sanitized data with all strings sanitized
   */
  static sanitizeJSON(data: any): any {
    if (typeof data === "string") {
      return this.sanitizeText(data);
    }

    // Handle Symbols - return empty string or skip
    if (typeof data === "symbol") {
      return "";
    }

    if (Array.isArray(data)) {
      return data.map((item) => this.sanitizeJSON(item));
    }

    if (typeof data === "object" && data !== null) {
      const sanitized: any = {};
      for (const [key, value] of Object.entries(data)) {
        // Skip Symbol keys (Object.entries doesn't include them, but be safe)
        if (typeof key === "symbol") {
          continue;
        }
        // Sanitize both keys and values
        const sanitizedKey =
          typeof key === "string" ? this.sanitizeText(key) : key;
        sanitized[sanitizedKey] = this.sanitizeJSON(value);
      }
      return sanitized;
    }

    // Return primitive values as-is (except Symbols which are handled above)
    return data;
  }

  /**
   * Sanitize a specific field from a request body
   * Useful for sanitizing specific fields while preserving others
   *
   * @param body - The request body object
   * @param field - The field name to sanitize
   * @param allowHTML - Whether to allow safe HTML (default: false, plain text only)
   * @returns The body with the specified field sanitized
   */
  static sanitizeField(
    body: Record<string, any>,
    field: string,
    allowHTML: boolean = false,
  ): Record<string, any> {
    if (!body || typeof body !== "object") {
      return body;
    }

    if (field in body && typeof body[field] === "string") {
      return {
        ...body,
        [field]: allowHTML
          ? this.sanitizeHTML(body[field])
          : this.sanitizeText(body[field]),
      };
    }

    return body;
  }

  /**
   * Sanitize multiple fields from a request body
   *
   * @param body - The request body object
   * @param fields - Array of field names to sanitize
   * @param allowHTML - Whether to allow safe HTML (default: false)
   * @returns The body with specified fields sanitized
   */
  static sanitizeFields(
    body: Record<string, any>,
    fields: string[],
    allowHTML: boolean = false,
  ): Record<string, any> {
    if (!body || typeof body !== "object") {
      return body;
    }

    const sanitized = { ...body };
    for (const field of fields) {
      if (field in sanitized && typeof sanitized[field] === "string") {
        sanitized[field] = allowHTML
          ? this.sanitizeHTML(sanitized[field])
          : this.sanitizeText(sanitized[field]);
      }
    }

    return sanitized;
  }
}
