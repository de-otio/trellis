/**
 * Unit Tests: Internal Documentation Navigation
 *
 * Tests for navigation data processing and validation.
 */

import { describe, expect, it } from "vitest";
import {
  buildAllowedFilesFromNavigation,
  validateNavigation,
  type NavigationData,
} from "../../src/lib/internal-docs-navigation.js";

describe("buildAllowedFilesFromNavigation", () => {
  it("should build allowedFiles from simple navigation", () => {
    const navigation: NavigationData = {
      sections: [
        {
          title: "Overview",
          items: [
            { title: "Overview", path: "internal/OVERVIEW.md" },
            { title: "Getting Started", path: "internal/GETTING_STARTED.md" },
          ],
        },
      ],
    };

    const result = buildAllowedFilesFromNavigation(navigation);

    expect(result).toEqual({
      "OVERVIEW.md": "internal/OVERVIEW.md",
      "GETTING_STARTED.md": "internal/GETTING_STARTED.md",
    });
  });

  it("should handle subdirectories correctly", () => {
    const navigation: NavigationData = {
      sections: [
        {
          title: "Compliance",
          items: [
            {
              title: "Bavaria Compliance",
              path: "internal/bavaria-compliance/README.md",
            },
            {
              title: "GDPR",
              path: "internal/compliance/gdpr.md",
            },
          ],
        },
      ],
    };

    const result = buildAllowedFilesFromNavigation(navigation);

    expect(result).toEqual({
      "bavaria-compliance/README.md": "internal/bavaria-compliance/README.md",
      "compliance/gdpr.md": "internal/compliance/gdpr.md",
    });
  });

  it("should handle multiple sections", () => {
    const navigation: NavigationData = {
      sections: [
        {
          title: "Section 1",
          items: [{ title: "Doc 1", path: "internal/doc1.md" }],
        },
        {
          title: "Section 2",
          items: [{ title: "Doc 2", path: "internal/doc2.md" }],
        },
      ],
    };

    const result = buildAllowedFilesFromNavigation(navigation);

    expect(result).toEqual({
      "doc1.md": "internal/doc1.md",
      "doc2.md": "internal/doc2.md",
    });
  });

  it("should handle empty navigation", () => {
    const navigation: NavigationData = {
      sections: [],
    };

    const result = buildAllowedFilesFromNavigation(navigation);

    expect(result).toEqual({});
  });

  it("should handle section with no items", () => {
    const navigation: NavigationData = {
      sections: [
        {
          title: "Empty Section",
          items: [],
        },
      ],
    };

    const result = buildAllowedFilesFromNavigation(navigation);

    expect(result).toEqual({});
  });

  it("should handle nested subdirectories", () => {
    const navigation: NavigationData = {
      sections: [
        {
          title: "Deep",
          items: [
            {
              title: "Deep Doc",
              path: "internal/level1/level2/level3/doc.md",
            },
          ],
        },
      ],
    };

    const result = buildAllowedFilesFromNavigation(navigation);

    expect(result).toEqual({
      "level1/level2/level3/doc.md": "internal/level1/level2/level3/doc.md",
    });
  });
});

describe("validateNavigation", () => {
  it("should validate correct navigation", () => {
    const navigation: NavigationData = {
      sections: [
        {
          title: "Valid",
          items: [
            { title: "Doc", path: "internal/valid.md" },
            { title: "Sub", path: "internal/sub/doc.md" },
          ],
        },
      ],
    };

    const result = validateNavigation(navigation);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("should reject paths not starting with internal/", () => {
    const navigation: NavigationData = {
      sections: [
        {
          title: "Invalid",
          items: [
            { title: "Invalid Path", path: "external/doc.md" },
            { title: "Valid Path", path: "internal/valid.md" },
          ],
        },
      ],
    };

    const result = validateNavigation(navigation);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'Navigation item "Invalid Path" has invalid path: "external/doc.md" (must start with "internal/")',
    );
    expect(result.errors.length).toBe(1);
  });

  it("should reject paths not ending with .md", () => {
    const navigation: NavigationData = {
      sections: [
        {
          title: "Invalid",
          items: [
            { title: "No Extension", path: "internal/doc" },
            { title: "Wrong Extension", path: "internal/doc.txt" },
          ],
        },
      ],
    };

    const result = validateNavigation(navigation);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(2);
    expect(result.errors[0]).toContain('must end with ".md"');
    expect(result.errors[1]).toContain('must end with ".md"');
  });

  it("should reject path traversal attempts", () => {
    const navigation: NavigationData = {
      sections: [
        {
          title: "Invalid",
          items: [
            { title: "Path Traversal", path: "internal/../secret.md" },
            { title: "Double Dot", path: "internal/../../etc/passwd.md" },
          ],
        },
      ],
    };

    const result = validateNavigation(navigation);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(2);
    expect(result.errors[0]).toContain("path traversal not allowed");
    expect(result.errors[1]).toContain("path traversal not allowed");
  });

  it("should reject absolute paths", () => {
    const navigation: NavigationData = {
      sections: [
        {
          title: "Invalid",
          items: [
            { title: "Absolute", path: "/internal/doc.md" },
            { title: "Root", path: "/doc.md" },
          ],
        },
      ],
    };

    const result = validateNavigation(navigation);

    expect(result.valid).toBe(false);
    // Absolute paths fail both "must start with internal/" and "absolute paths not allowed" checks
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    expect(
      result.errors.some((e) => e.includes("absolute paths not allowed")),
    ).toBe(true);
  });

  it("should collect all errors", () => {
    const navigation: NavigationData = {
      sections: [
        {
          title: "Multiple Errors",
          items: [
            { title: "Error 1", path: "external/doc.md" }, // Wrong prefix
            { title: "Error 2", path: "internal/doc" }, // No .md
            { title: "Error 3", path: "internal/../secret.md" }, // Path traversal
            { title: "Error 4", path: "/internal/doc.md" }, // Absolute (may trigger multiple checks)
          ],
        },
      ],
    };

    const result = validateNavigation(navigation);

    expect(result.valid).toBe(false);
    // Each item should have at least one error, absolute paths may have multiple
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
    expect(
      result.errors.some((e) => e.includes('must start with "internal/"')),
    ).toBe(true);
    expect(result.errors.some((e) => e.includes('must end with ".md"'))).toBe(
      true,
    );
    expect(
      result.errors.some((e) => e.includes("path traversal not allowed")),
    ).toBe(true);
    expect(
      result.errors.some((e) => e.includes("absolute paths not allowed")),
    ).toBe(true);
  });

  it("should handle empty navigation", () => {
    const navigation: NavigationData = {
      sections: [],
    };

    const result = validateNavigation(navigation);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("should handle section with no items", () => {
    const navigation: NavigationData = {
      sections: [
        {
          title: "Empty",
          items: [],
        },
      ],
    };

    const result = validateNavigation(navigation);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("should validate complex valid navigation", () => {
    const navigation: NavigationData = {
      sections: [
        {
          title: "Section 1",
          items: [
            { title: "Doc 1", path: "internal/doc1.md" },
            { title: "Doc 2", path: "internal/sub/doc2.md" },
          ],
        },
        {
          title: "Section 2",
          items: [{ title: "Doc 3", path: "internal/another/sub/doc3.md" }],
        },
      ],
    };

    const result = validateNavigation(navigation);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
