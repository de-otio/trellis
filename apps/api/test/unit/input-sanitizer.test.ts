/**
 * Unit Tests: Input Sanitizer
 *
 * Tests for input sanitization to prevent XSS attacks.
 */

import { describe, it, expect } from "vitest";
import { InputSanitizer } from "../../src/lib/input-sanitizer.js";

describe("InputSanitizer", () => {
  describe("sanitizeText", () => {
    it("should remove all HTML tags from plain text", () => {
      const input = '<script>alert("XSS")</script>Hello World';
      const result = InputSanitizer.sanitizeText(input);
      expect(result).toBe("Hello World");
    });

    it("should remove script tags", () => {
      const input = 'Hello<script>alert("XSS")</script>World';
      const result = InputSanitizer.sanitizeText(input);
      expect(result).toBe("HelloWorld");
    });

    it("should remove img tags with onerror", () => {
      const input = '<img src="x" onerror="alert(1)">';
      const result = InputSanitizer.sanitizeText(input);
      expect(result).toBe("");
    });

    it("should remove iframe tags", () => {
      const input = '<iframe src="evil.com"></iframe>Safe text';
      const result = InputSanitizer.sanitizeText(input);
      expect(result).toBe("Safe text");
    });

    it("should remove event handlers", () => {
      const input = '<div onclick="alert(1)">Click me</div>';
      const result = InputSanitizer.sanitizeText(input);
      expect(result).toBe("Click me");
    });

    it("should not leave a script tag after nested-tag collapse", () => {
      // A single pass would collapse "<scr<script>ipt>" to "<script>".
      // The fixed-point strip must remove it entirely.
      const input = "<scr<script>ipt>alert(1)</scr</script>ipt>Hello";
      const result = InputSanitizer.sanitizeText(input);
      expect(result).not.toContain("<script");
      expect(result).toContain("Hello");
    });

    it("should remove script end tags with internal whitespace", () => {
      const input = '<script>alert("XSS")</script >After';
      const result = InputSanitizer.sanitizeText(input);
      expect(result).not.toContain("<script");
      expect(result).toBe("After");
    });

    it("should remove style end tags with internal whitespace", () => {
      const input = "<style>body{}</style >Visible";
      const result = InputSanitizer.sanitizeText(input);
      expect(result).not.toContain("<style");
      expect(result).toBe("Visible");
    });

    it("should preserve plain text", () => {
      const input = "This is plain text with no HTML";
      const result = InputSanitizer.sanitizeText(input);
      expect(result).toBe(input);
    });

    it("should handle empty strings", () => {
      const result = InputSanitizer.sanitizeText("");
      expect(result).toBe("");
    });

    it("should handle non-string inputs", () => {
      expect(InputSanitizer.sanitizeText(123 as any)).toBe("123");
      expect(InputSanitizer.sanitizeText(null as any)).toBe("null");
      expect(InputSanitizer.sanitizeText(undefined as any)).toBe("undefined");
    });

    it("should remove nested HTML tags", () => {
      const input = "<div><p><span>Nested</span></p></div>";
      const result = InputSanitizer.sanitizeText(input);
      expect(result).toBe("Nested");
    });

    it("should handle XSS payloads", () => {
      const xssPayloads = [
        '<script>alert("XSS")</script>',
        "<img src=x onerror=alert(1)>",
        "<svg onload=alert(1)>",
        "<body onload=alert(1)>",
        '<iframe src="javascript:alert(1)"></iframe>',
        "<input onfocus=alert(1) autofocus>",
      ];

      xssPayloads.forEach((payload) => {
        const result = InputSanitizer.sanitizeText(payload);
        expect(result).not.toContain("<script>");
        expect(result).not.toContain("onerror");
        expect(result).not.toContain("onload");
        expect(result).not.toContain("onfocus");
        expect(result).not.toContain("javascript:");
      });
    });
  });

  describe("sanitizeHTML", () => {
    it("should allow safe HTML tags", () => {
      const input = "<p>Paragraph</p><br><strong>Bold</strong><em>Italic</em>";
      const result = InputSanitizer.sanitizeHTML(input);
      expect(result).toContain("<p>");
      expect(result).toContain("<br>");
      expect(result).toContain("<strong>");
      expect(result).toContain("<em>");
    });

    it("should remove unsafe HTML tags", () => {
      const input = '<script>alert("XSS")</script><p>Safe</p>';
      const result = InputSanitizer.sanitizeHTML(input);
      expect(result).not.toContain("<script>");
      expect(result).toContain("<p>");
    });

    it("should remove all attributes", () => {
      const input = '<p class="test" id="myId">Text</p>';
      const result = InputSanitizer.sanitizeHTML(input);
      expect(result).toContain("<p>");
      expect(result).not.toContain("class=");
      expect(result).not.toContain("id=");
    });

    it("should remove event handlers even in allowed tags", () => {
      const input = '<p onclick="alert(1)">Click</p>';
      const result = InputSanitizer.sanitizeHTML(input);
      expect(result).not.toContain("onclick");
    });

    it("should handle empty strings", () => {
      const result = InputSanitizer.sanitizeHTML("");
      expect(result).toBe("");
    });

    it("should handle non-string inputs", () => {
      expect(InputSanitizer.sanitizeHTML(123 as any)).toBe("123");
    });
  });

  describe("sanitizeJSON", () => {
    it("should sanitize string values", () => {
      const input = { text: '<script>alert("XSS")</script>Hello' };
      const result = InputSanitizer.sanitizeJSON(input);
      expect(result.text).toBe("Hello");
      expect(result.text).not.toContain("<script>");
    });

    it("should sanitize nested objects", () => {
      const input = {
        user: {
          name: "<script>alert(1)</script>John",
          bio: "<img src=x onerror=alert(1)>",
        },
      };
      const result = InputSanitizer.sanitizeJSON(input);
      expect(result.user.name).toBe("John");
      expect(result.user.bio).toBe("");
    });

    it("should sanitize arrays", () => {
      const input = {
        tags: ["<script>alert(1)</script>", "safe", "<img src=x>"],
      };
      const result = InputSanitizer.sanitizeJSON(input);
      expect(result.tags[0]).toBe("");
      expect(result.tags[1]).toBe("safe");
      expect(result.tags[2]).toBe("");
    });

    it("should sanitize nested arrays", () => {
      const input = {
        comments: [
          { text: "<script>alert(1)</script>Comment 1" },
          { text: "Safe comment" },
        ],
      };
      const result = InputSanitizer.sanitizeJSON(input);
      expect(result.comments[0].text).toBe("Comment 1");
      expect(result.comments[1].text).toBe("Safe comment");
    });

    it("should sanitize object keys", () => {
      const input = {
        "<script>key</script>": "value",
        safeKey: "value",
      };
      const result = InputSanitizer.sanitizeJSON(input);
      // After sanitization, '<script>key</script>' becomes empty string (all HTML removed)
      // So the key becomes '' (empty string)
      expect(result[""]).toBe("value");
      expect(result["safeKey"]).toBe("value");
      // The original key should not exist
      expect(result["<script>key</script>"]).toBeUndefined();
    });

    it("should preserve non-string primitives", () => {
      const input = {
        number: 123,
        boolean: true,
        nullValue: null,
      };
      const result = InputSanitizer.sanitizeJSON(input);
      expect(result.number).toBe(123);
      expect(result.boolean).toBe(true);
      expect(result.nullValue).toBe(null);
    });

    it("should handle empty objects", () => {
      const result = InputSanitizer.sanitizeJSON({});
      expect(result).toEqual({});
    });

    it("should handle empty arrays", () => {
      const result = InputSanitizer.sanitizeJSON([]);
      expect(result).toEqual([]);
    });

    it("should handle null and undefined", () => {
      expect(InputSanitizer.sanitizeJSON(null)).toBe(null);
      expect(InputSanitizer.sanitizeJSON(undefined)).toBe(undefined);
    });

    it("should handle complex nested structures", () => {
      const input = {
        post: {
          title: "<script>alert(1)</script>Title",
          content: "<p>Safe content</p>",
          tags: ["<img src=x>", "safe"],
          author: {
            name: "<script>alert(1)</script>Author",
            bio: "Safe bio",
          },
        },
      };
      const result = InputSanitizer.sanitizeJSON(input);
      expect(result.post.title).toBe("Title");
      expect(result.post.content).toBe("Safe content");
      expect(result.post.tags[0]).toBe("");
      expect(result.post.tags[1]).toBe("safe");
      expect(result.post.author.name).toBe("Author");
      expect(result.post.author.bio).toBe("Safe bio");
    });
  });

  describe("sanitizeField", () => {
    it("should sanitize a specific field", () => {
      const body = {
        text: "<script>alert(1)</script>Hello",
        other: "<p>Unchanged</p>",
      };
      const result = InputSanitizer.sanitizeField(body, "text");
      expect(result.text).toBe("Hello");
      expect(result.other).toBe("<p>Unchanged</p>");
    });

    it("should sanitize field as plain text by default", () => {
      const body = { text: "<p>HTML</p>" };
      const result = InputSanitizer.sanitizeField(body, "text");
      expect(result.text).toBe("HTML");
    });

    it("should allow HTML when allowHTML is true", () => {
      const body = { text: "<p>HTML</p><script>alert(1)</script>" };
      const result = InputSanitizer.sanitizeField(body, "text", true);
      expect(result.text).toContain("<p>");
      expect(result.text).not.toContain("<script>");
    });

    it("should handle missing field", () => {
      const body = { other: "value" };
      const result = InputSanitizer.sanitizeField(body, "text");
      expect(result).toEqual(body);
    });

    it("should handle non-string field values", () => {
      const body = { text: 123 };
      const result = InputSanitizer.sanitizeField(body, "text");
      expect(result.text).toBe(123);
    });
  });

  describe("sanitizeFields", () => {
    it("should sanitize multiple fields", () => {
      const body = {
        name: "<script>alert(1)</script>John",
        bio: "<img src=x onerror=alert(1)>",
        other: "<p>Unchanged</p>",
      };
      const result = InputSanitizer.sanitizeFields(body, ["name", "bio"]);
      expect(result.name).toBe("John");
      expect(result.bio).toBe("");
      expect(result.other).toBe("<p>Unchanged</p>");
    });

    it("should sanitize fields as plain text by default", () => {
      const body = {
        text: "<p>HTML</p>",
        content: "<div>More HTML</div>",
      };
      const result = InputSanitizer.sanitizeFields(body, ["text", "content"]);
      expect(result.text).toBe("HTML");
      expect(result.content).toBe("More HTML");
    });

    it("should allow HTML when allowHTML is true", () => {
      const body = {
        text: "<p>HTML</p><script>alert(1)</script>",
        content: "<strong>Bold</strong>",
      };
      const result = InputSanitizer.sanitizeFields(
        body,
        ["text", "content"],
        true,
      );
      expect(result.text).toContain("<p>");
      expect(result.text).not.toContain("<script>");
      expect(result.content).toContain("<strong>");
    });

    it("should handle missing fields", () => {
      const body = { other: "value" };
      const result = InputSanitizer.sanitizeFields(body, ["name", "bio"]);
      expect(result).toEqual(body);
    });
  });

  describe("real-world XSS scenarios", () => {
    it("should prevent stored XSS in post content", () => {
      const postContent = `
        Check out this cool site!
        <script>
          fetch('/api/user/delete-account', {method: 'DELETE'});
        </script>
      `;
      const result = InputSanitizer.sanitizeText(postContent);
      expect(result).not.toContain("<script>");
      expect(result).not.toContain("fetch");
    });

    it("should prevent XSS in comments", () => {
      const comment =
        '<img src="x" onerror="document.cookie=\'session=stolen\'">';
      const result = InputSanitizer.sanitizeText(comment);
      expect(result).not.toContain("onerror");
      expect(result).not.toContain("document.cookie");
    });

    it("should prevent XSS in user profiles", () => {
      const bio = '<svg onload="alert(document.cookie)">';
      const result = InputSanitizer.sanitizeText(bio);
      expect(result).not.toContain("<svg>");
      expect(result).not.toContain("onload");
    });
  });

  describe("Cloudflare Workers compatibility", () => {
    it("should work without window object (simulating Workers environment)", () => {
      // Simulate Cloudflare Workers environment where window is not defined
      const originalWindow = (globalThis as any).window;
      delete (globalThis as any).window;

      try {
        // These should not throw "window is not defined" errors
        const input1 = '<script>alert("XSS")</script>Hello World';
        const result1 = InputSanitizer.sanitizeText(input1);
        expect(result1).toBe("Hello World");
        expect(() => InputSanitizer.sanitizeText(input1)).not.toThrow();

        const input2 = "<p>Safe HTML</p><script>alert(1)</script>";
        const result2 = InputSanitizer.sanitizeHTML(input2);
        expect(result2).toContain("<p>");
        expect(result2).not.toContain("<script>");
        expect(() => InputSanitizer.sanitizeHTML(input2)).not.toThrow();

        // Test with HTML entities
        const input3 = "Text with &lt;script&gt; and &amp; entities";
        const result3 = InputSanitizer.sanitizeText(input3);
        expect(result3).not.toContain("&lt;");
        expect(result3).not.toContain("&amp;");
        expect(() => InputSanitizer.sanitizeText(input3)).not.toThrow();
      } finally {
        // Restore window if it existed
        if (originalWindow !== undefined) {
          (globalThis as any).window = originalWindow;
        }
      }
    });

    it("should handle HTML entities without window object", () => {
      const originalWindow = (globalThis as any).window;
      delete (globalThis as any).window;

      try {
        const testCases = [
          {
            input: "Text &lt;script&gt;alert(1)&lt;/script&gt;",
            expected: "Text ",
          },
          { input: "AT&amp;T company", expected: "AT" },
          { input: "Quote &quot;test&quot;", expected: "Quote " },
          { input: "Apostrophe &#39;test&#39;", expected: "Apostrophe " },
          { input: "Space&nbsp;here", expected: "Space" },
          { input: "Numeric &#65;&#66;&#67;", expected: "Numeric " },
          { input: "Named &amp;lt;script&amp;gt;", expected: "Named " },
        ];

        testCases.forEach(({ input, expected }) => {
          const result = InputSanitizer.sanitizeText(input);
          expect(() => InputSanitizer.sanitizeText(input)).not.toThrow();
          // Result should not contain HTML entities
          expect(result).not.toMatch(/&[#\w]+;/);
          // Result should contain the expected text (without entities)
          expect(result).toContain(expected.trim() || "");
        });
      } finally {
        if (originalWindow !== undefined) {
          (globalThis as any).window = originalWindow;
        }
      }
    });

    it("should sanitize complex HTML without window object", () => {
      const originalWindow = (globalThis as any).window;
      delete (globalThis as any).window;

      try {
        const complexInput = `
          <div class="container">
            <p onclick="alert(1)">Click me</p>
            <img src="x" onerror="alert(1)">
            <script>document.cookie = 'stolen'</script>
            <iframe src="javascript:alert(1)"></iframe>
            Safe text here
          </div>
        `;

        const result = InputSanitizer.sanitizeText(complexInput);
        expect(() => InputSanitizer.sanitizeText(complexInput)).not.toThrow();
        expect(result).toContain("Safe text here");
        expect(result).not.toContain("<script>");
        expect(result).not.toContain("onclick");
        expect(result).not.toContain("onerror");
        expect(result).not.toContain("javascript:");
      } finally {
        if (originalWindow !== undefined) {
          (globalThis as any).window = originalWindow;
        }
      }
    });

    it("should work in post creation scenario without window", () => {
      const originalWindow = (globalThis as any).window;
      delete (globalThis as any).window;

      try {
        // Simulate a post creation request body
        const postBody = {
          text: '<script>alert("XSS")</script>This is my post content &lt;script&gt;',
          visibility: "public",
        };

        const sanitizedText = InputSanitizer.sanitizeText(postBody.text);
        expect(() => InputSanitizer.sanitizeText(postBody.text)).not.toThrow();
        // Script tags and their content are removed
        expect(sanitizedText).not.toContain("<script>");
        expect(sanitizedText).not.toContain('alert("XSS")');
        // HTML entities are removed (leaving plain text "script" which is harmless)
        expect(sanitizedText).not.toContain("&lt;");
        expect(sanitizedText).not.toContain("&gt;");
        // The word "script" in plain text is not a security issue
        expect(sanitizedText).toContain("This is my post content");
        // Verify no executable code remains
        expect(sanitizedText).not.toMatch(/<[^>]*>/); // No HTML tags
      } finally {
        if (originalWindow !== undefined) {
          (globalThis as any).window = originalWindow;
        }
      }
    });

    it("should handle Symbol values without throwing errors", () => {
      const testSymbol = Symbol("test");

      // Should not throw when sanitizing a Symbol
      expect(() =>
        InputSanitizer.sanitizeText(testSymbol as any),
      ).not.toThrow();
      const result = InputSanitizer.sanitizeText(testSymbol as any);
      expect(result).toBe("");

      // Should handle Symbols in objects
      const objWithSymbol = {
        text: "Hello",
        symbolValue: testSymbol,
      };

      expect(() => InputSanitizer.sanitizeJSON(objWithSymbol)).not.toThrow();
      const sanitized = InputSanitizer.sanitizeJSON(objWithSymbol);
      expect(sanitized.text).toBe("Hello");
      expect(sanitized.symbolValue).toBe("");

      // Should handle Symbols in arrays
      const arrayWithSymbol = ["Hello", testSymbol, "World"];
      expect(() => InputSanitizer.sanitizeJSON(arrayWithSymbol)).not.toThrow();
      const sanitizedArray = InputSanitizer.sanitizeJSON(arrayWithSymbol);
      expect(sanitizedArray[0]).toBe("Hello");
      expect(sanitizedArray[1]).toBe("");
      expect(sanitizedArray[2]).toBe("World");
    });
  });
});
