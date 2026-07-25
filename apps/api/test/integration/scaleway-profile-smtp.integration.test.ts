/**
 * Scaleway-profile SMTP smoke (WS-5) — SmtpEmailProvider against a REAL
 * Mailpit from docker-compose.scaleway.yml.
 *
 * Env-gated (the documented conditional-describe pattern — invisible to
 * the AR14 skip checker): runs only when SCALEWAY_PROFILE_SMTP_HOST is
 * set (the scheduled scaleway-profile-e2e workflow sets it; local:
 *   docker compose -f docker-compose.scaleway.yml up -d --wait
 *   SCALEWAY_PROFILE_SMTP_HOST=127.0.0.1 npm run test:integration -- \
 *     test/integration/scaleway-profile-smtp.integration.test.ts
 * ).
 *
 * Asserts delivery through Mailpit's REST API (the same read path the
 * G2 harness used): https://mailpit.axllent.org/docs/api-v1/
 */

import { describe, expect, it } from "vitest";

import { SmtpEmailProvider } from "../../src/lib/email-provider.js";

const SMTP_HOST = process.env.SCALEWAY_PROFILE_SMTP_HOST;
const SMTP_PORT = Number(process.env.SCALEWAY_PROFILE_SMTP_PORT || 1025);
const MAILPIT_API =
  process.env.SCALEWAY_PROFILE_MAILPIT_API || "http://127.0.0.1:8025";

const describeIfProfile = SMTP_HOST ? describe : describe.skip;

describeIfProfile("Scaleway profile — Mailpit SMTP smoke", () => {
  it("delivers a multipart message to Mailpit and finds it via the REST API", async () => {
    const provider = new SmtpEmailProvider({
      host: SMTP_HOST as string,
      port: SMTP_PORT,
    });

    const marker = `ws5-smoke-${Date.now().toString(36)}`;
    const result = await provider.sendEmail({
      from: "Trellis CI <ci@example.test>",
      to: "recipient@example.test",
      subject: `Scaleway profile smoke ${marker}`,
      text: `plain ${marker}`,
      html: `<p>html ${marker}</p>`,
    });
    expect(result.provider).toBe("smtp");

    // Mailpit search API: GET /api/v1/search?query=...
    const search = await fetch(
      `${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(marker)}`,
    );
    expect(search.ok).toBe(true);
    const found = (await search.json()) as {
      messages?: Array<{ ID: string; Subject: string }>;
    };
    expect(found.messages?.length).toBe(1);
    const message = found.messages![0];
    expect(message.Subject).toBe(`Scaleway profile smoke ${marker}`);

    // Fetch the full message and verify both MIME alternatives survived.
    const detail = await fetch(`${MAILPIT_API}/api/v1/message/${message.ID}`);
    expect(detail.ok).toBe(true);
    const body = (await detail.json()) as { Text?: string; HTML?: string };
    expect(body.Text).toContain(`plain ${marker}`);
    expect(body.HTML).toContain(`html ${marker}`);
  }, 30_000);
});
