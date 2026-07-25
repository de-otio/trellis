/**
 * The S-8 magic-link sign-in email — single source of truth (WS-3.3).
 *
 * Extracted VERBATIM from the Cognito create-auth-challenge trigger so the
 * app-owned email is identical no matter which provider issued the link
 * (G2 S-8: the application, not the IdP, owns this email; C-6 asserts its
 * subject/body/From).
 */

export interface MagicLinkEmailContent {
  subject: string;
  html: string;
  text: string;
}

/**
 * Escape a string for safe interpolation into a **double-quoted HTML
 * attribute** value ([F1]). Escapes the five attribute-significant characters
 * (`&`, `<`, `>`, `"`, `'`) — `&` first so already-escaped entities are not
 * double-encoded incorrectly. A URL that carries `" onmouseover=…` can no
 * longer break out of the `href` and inject an attacker-controlled attribute.
 *
 * The Cognito path builds the magic-link URL locally (safe), but this shared
 * S-8 template must be safe regardless of who constructs the link — a
 * provider-returned link (Keycloak) is untrusted input here.
 */
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildMagicLinkEmail(magicLink: string): MagicLinkEmailContent {
  // [F1] The URL is interpolated into an HTML `href` attribute — escape it.
  // The text/plain part below stays raw (no markup, nothing to inject).
  const hrefLink = escapeHtmlAttribute(magicLink);
  return {
    subject: "Sign in to Trellis",
    html: `
              <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
                <h2 style="color: #1a1a1a; margin-bottom: 24px;">Sign in to Trellis</h2>
                <p style="color: #4a4a4a; font-size: 16px; line-height: 1.5;">Click the button below to sign in. This link expires in 5 minutes.</p>
                <a href="${hrefLink}" style="display: inline-block; background: #2563eb; color: #fff; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px; margin: 24px 0;">Sign in to Trellis</a>
                <p style="color: #9a9a9a; font-size: 13px; margin-top: 32px;">If you didn't request this, you can safely ignore this email.</p>
              </div>`,
    text: `Sign in to Trellis\n\nClick this link to sign in (expires in 5 minutes):\n${magicLink}\n\nIf you didn't request this, ignore this email.`,
  };
}
