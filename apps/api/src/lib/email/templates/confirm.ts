/**
 * Email template for confirming follow-by-email subscriptions.
 *
 * This template is tracker-free: no tracking pixels, external resources,
 * or click-tracking redirects. URLs are used verbatim, and HTML is minimal
 * and self-contained.
 */

function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface ConfirmEmailInput {
  confirmUrl: string;
  targetLabel: string;
  locale?: string;
  unsubscribeUrl?: string;
}

interface EmailOutput {
  subject: string;
  html: string;
  text: string;
}

// Locale-specific content
type Locale = "en" | "de";

const content: Record<
  Locale,
  {
    subject: string;
    greeting: string;
    bodyLine1: string;
    bodyLine2: string;
    buttonText: string;
    footerIgnore: string;
    unsubscribeText: string;
  }
> = {
  en: {
    subject: "Confirm your subscription",
    greeting: "Hello,",
    bodyLine1: "Someone (possibly you) requested to follow {targetLabel} by email.",
    bodyLine2:
      "Click the link below to confirm your subscription. If you didn't request this, you can safely ignore this email.",
    buttonText: "Confirm Subscription",
    footerIgnore: "If the button doesn't work, copy and paste this link into your browser:",
    unsubscribeText: "You can unsubscribe anytime.",
  },
  de: {
    subject: "Bestätige dein Abonnement",
    greeting: "Hallo,",
    bodyLine1: "Jemand (möglicherweise du) hat angefordert, {targetLabel} per E-Mail zu folgen.",
    bodyLine2:
      "Klicke auf den Link unten, um dein Abonnement zu bestätigen. Wenn du dies nicht angefordert hast, kannst du diese E-Mail ignorieren.",
    buttonText: "Abonnement bestätigen",
    footerIgnore: "Falls der Button nicht funktioniert, kopiere diesen Link in deinen Browser:",
    unsubscribeText: "Du kannst dich jederzeit abmelden.",
  },
};

export function renderConfirmEmail(input: ConfirmEmailInput): EmailOutput {
  const locale: Locale = (input.locale === "de" ? "de" : "en") as Locale;
  const t = content[locale];
  const targetLabelEscaped = htmlEscape(input.targetLabel);
  const confirmUrlEscaped = htmlEscape(input.confirmUrl);
  const unsubscribeUrlEscaped = input.unsubscribeUrl ? htmlEscape(input.unsubscribeUrl) : null;

  // Plain text version
  const textBody = `${t.greeting}

${t.bodyLine1.replace("{targetLabel}", input.targetLabel)}
${t.bodyLine2}

${t.footerIgnore}
${input.confirmUrl}

${unsubscribeUrlEscaped ? `${t.unsubscribeText}\n${input.unsubscribeUrl}` : t.unsubscribeText}`;

  // HTML version (minimal, tracker-free)
  const htmlBody = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; line-height: 1.5; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { margin-bottom: 24px; }
    .content { margin-bottom: 24px; }
    .button-wrapper { margin: 24px 0; }
    .button { display: inline-block; padding: 12px 24px; background-color: #0066cc; color: white; text-decoration: none; border-radius: 4px; font-weight: 500; }
    .button:hover { background-color: #0052a3; }
    .fallback { margin-top: 16px; padding: 12px; background-color: #f5f5f5; border-left: 3px solid #ccc; }
    .fallback-label { font-size: 12px; color: #666; margin-bottom: 4px; }
    .fallback-url { font-size: 12px; word-break: break-all; color: #0066cc; }
    .footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid #e0e0e0; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <p>${htmlEscape(t.greeting)}</p>
    </div>
    <div class="content">
      <p>${t.bodyLine1.replace("{targetLabel}", `<strong>${targetLabelEscaped}</strong>`)}</p>
      <p>${htmlEscape(t.bodyLine2)}</p>
    </div>
    <div class="button-wrapper">
      <a href="${confirmUrlEscaped}" class="button">${htmlEscape(t.buttonText)}</a>
    </div>
    <div class="fallback">
      <div class="fallback-label">${htmlEscape(t.footerIgnore)}</div>
      <div class="fallback-url">${confirmUrlEscaped}</div>
    </div>
    <div class="footer">
      ${unsubscribeUrlEscaped ? `<p><a href="${unsubscribeUrlEscaped}" style="color: #0066cc; text-decoration: none;">${htmlEscape(t.unsubscribeText)}</a></p>` : `<p>${htmlEscape(t.unsubscribeText)}</p>`}
    </div>
  </div>
</body>
</html>`;

  return {
    subject: t.subject,
    html: htmlBody,
    text: textBody,
  };
}
