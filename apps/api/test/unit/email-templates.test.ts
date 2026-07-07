import { describe, expect, it } from "vitest";
import { renderConfirmEmail } from "../../src/lib/email/templates/confirm.js";
import { renderUnsubscribeConfirmationEmail } from "../../src/lib/email/templates/unsubscribe.js";

/** The tracker-free guarantee, asserted on rendered output. */
function assertTrackerFree(html: string) {
  expect(html).not.toMatch(/<img/i); // no tracking pixel
  expect(html).not.toMatch(/https?:\/\/(?!.*\/api\/subscriptions)/i); // no external hosts
  expect(html).not.toMatch(/url\(/i); // no external CSS resource
}

describe("email templates (tracker-free)", () => {
  describe("renderConfirmEmail", () => {
    const out = renderConfirmEmail({
      confirmUrl: "https://app.example.com/api/subscriptions/email/confirm?token=abc",
      targetLabel: "Rex",
      unsubscribeUrl: "https://app.example.com/api/subscriptions/email/unsubscribe?token=xyz",
    });

    it("returns subject, html and text", () => {
      expect(out.subject).toBeTruthy();
      expect(out.html).toBeTruthy();
      expect(out.text).toBeTruthy();
    });
    it("uses the confirmUrl verbatim (no click-tracking wrapper)", () => {
      expect(out.html).toContain(
        "https://app.example.com/api/subscriptions/email/confirm?token=abc",
      );
      expect(out.text).toContain(
        "https://app.example.com/api/subscriptions/email/confirm?token=abc",
      );
    });
    it("is tracker-free", () => assertTrackerFree(out.html));

    it("escapes an HTML-injecting target label", () => {
      const evil = renderConfirmEmail({
        confirmUrl: "https://app.example.com/api/subscriptions/email/confirm?token=abc",
        targetLabel: "<script>alert(1)</script>",
      });
      expect(evil.html).not.toContain("<script>alert(1)</script>");
    });

    it("localizes: de differs from en", () => {
      const en = renderConfirmEmail({
        confirmUrl: "https://x.example/api/subscriptions/y",
        targetLabel: "Rex",
        locale: "en",
      });
      const de = renderConfirmEmail({
        confirmUrl: "https://x.example/api/subscriptions/y",
        targetLabel: "Rex",
        locale: "de",
      });
      expect(de.subject).not.toBe(en.subject);
    });
  });

  describe("renderUnsubscribeConfirmationEmail", () => {
    const out = renderUnsubscribeConfirmationEmail({ targetLabel: "Rex" });
    it("returns content and is tracker-free", () => {
      expect(out.subject).toBeTruthy();
      assertTrackerFree(out.html);
    });
    it("localizes: de differs from en", () => {
      const en = renderUnsubscribeConfirmationEmail({ targetLabel: "Rex", locale: "en" });
      const de = renderUnsubscribeConfirmationEmail({ targetLabel: "Rex", locale: "de" });
      expect(de.subject).not.toBe(en.subject);
      assertTrackerFree(de.html);
    });
  });
});
