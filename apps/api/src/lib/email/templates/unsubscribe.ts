/**
 * Email template for confirming unsubscription from follow-by-email.
 *
 * This template is tracker-free: no tracking pixels, external resources,
 * or click-tracking redirects. HTML is minimal and self-contained.
 */

function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface UnsubscribeEmailInput {
  targetLabel: string;
  locale?: string;
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
    bodyLine: string;
  }
> = {
  en: {
    subject: "You've been unsubscribed",
    greeting: "Hello,",
    bodyLine:
      "You have been successfully unsubscribed from email notifications for {targetLabel}. You won't receive any further emails about this.",
  },
  de: {
    subject: "Du wurdest abgemeldet",
    greeting: "Hallo,",
    bodyLine:
      "Du wurdest erfolgreich von E-Mail-Benachrichtigungen für {targetLabel} abgemeldet. Du wirst keine weiteren E-Mails darüber erhalten.",
  },
};

export function renderUnsubscribeConfirmationEmail(input: UnsubscribeEmailInput): EmailOutput {
  const locale: Locale = (input.locale === "de" ? "de" : "en") as Locale;
  const t = content[locale];
  const targetLabelEscaped = htmlEscape(input.targetLabel);

  // Plain text version
  const textBody = `${t.greeting}

${t.bodyLine.replace("{targetLabel}", input.targetLabel)}`;

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
    .footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid #e0e0e0; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <p>${htmlEscape(t.greeting)}</p>
    </div>
    <div class="content">
      <p>${t.bodyLine.replace("{targetLabel}", `<strong>${targetLabelEscaped}</strong>`)}</p>
    </div>
    <div class="footer">
      <p style="color: #999; font-size: 11px;">This is an automated message. Please do not reply to this email.</p>
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
