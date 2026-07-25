/**
 * [F1] buildMagicLinkEmail HTML-attribute escaping.
 *
 * The shared S-8 email template interpolates the magic-link URL into an HTML
 * `href` attribute. A link containing `" onmouseover=…` must be neutralized so
 * it cannot break out of the attribute and inject an event handler. The
 * text/plain part carries no markup and stays raw.
 */

import { describe, expect, it } from "vitest";

import { buildMagicLinkEmail } from "../../../src/lib/identity/magic-link-email.js";

describe("buildMagicLinkEmail — HTML-attribute injection (F1)", () => {
  it("neutralizes a link that tries to break out of the href attribute", () => {
    const malicious =
      'https://app.example.test/auth/verify?token=x" onmouseover="alert(1)&email=a@b.test';
    const { html } = buildMagicLinkEmail(malicious);

    // The raw attribute-breaking quote must NOT survive: `x" onmouseover` would
    // close the href and start a new attribute.
    expect(html).not.toContain('x" onmouseover');
    // …it is escaped inside the attribute value instead.
    expect(html).toContain("x&quot; onmouseover");

    // The href value stays fully contained within a single quoted attribute:
    // every `"` inside it is now `&quot;`, so the [^"]* capture reaches the
    // real closing quote with the whole value intact.
    const hrefMatch = html.match(/href="([^"]*)"/);
    expect(hrefMatch).not.toBeNull();
    expect(hrefMatch![1]).toContain("&quot;");
    expect(hrefMatch![1]).toContain("&amp;email=a@b.test");
  });

  it("escapes all five attribute-significant characters", () => {
    const { html } = buildMagicLinkEmail(`https://x.test/?a=<b>&c="d'e`);
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&amp;c=&quot;d&#39;e");
  });

  it("leaves the plain-text link unescaped", () => {
    const link = "https://app.example.test/auth/verify?token=abc&email=a@b.test";
    const { text } = buildMagicLinkEmail(link);
    expect(text).toContain(link);
  });

  it("does not corrupt a normal (well-formed) magic link's href", () => {
    const link = "https://app.example.test/auth/verify?token=abc123&email=user%40b.test";
    const { html } = buildMagicLinkEmail(link);
    // Only the `&` between query params is escaped for HTML; nothing else changes.
    expect(html).toContain(
      'href="https://app.example.test/auth/verify?token=abc123&amp;email=user%40b.test"',
    );
  });
});
