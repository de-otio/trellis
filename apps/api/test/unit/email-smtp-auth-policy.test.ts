/**
 * L11 — SMTP AUTH must never cross a plaintext connection.
 * Socket-free: the decision is a pure function, and the provider refuses
 * before it opens a connection.
 */

import { describe, expect, it } from "vitest";
import { decideSmtpAuth, SmtpEmailProvider } from "../../src/lib/email-provider.js";

describe("decideSmtpAuth", () => {
  it("no credentials → skip, with or without TLS (Mailpit-style dev sink keeps working)", () => {
    expect(decideSmtpAuth({ hasCredentials: false, tlsActive: false })).toBe("skip");
    expect(decideSmtpAuth({ hasCredentials: false, tlsActive: true })).toBe("skip");
  });

  it("credentials + TLS → send", () => {
    expect(decideSmtpAuth({ hasCredentials: true, tlsActive: true })).toBe("send");
  });

  it("credentials + plaintext → refuse", () => {
    expect(decideSmtpAuth({ hasCredentials: true, tlsActive: false })).toBe("refuse");
  });
});

describe("SmtpEmailProvider — credentials over plaintext", () => {
  const send = (provider: SmtpEmailProvider) =>
    provider
      .sendEmail({ from: "s@example.test", to: "r@example.test", subject: "s", text: "t" })
      .then(
        () => undefined,
        (e: Error) => e,
      );

  it("refuses before opening any socket, with a fix-it message that leaks no secret", async () => {
    // Port 1 would yield ECONNREFUSED if the provider tried to connect; getting
    // the refusal instead proves the decision precedes the connection.
    const err = await send(
      new SmtpEmailProvider({
        host: "127.0.0.1",
        port: 1,
        username: "project-id",
        password: "secret-key",
      }),
    );
    expect(err?.message).toMatch(/AUTH refused/);
    expect(err?.message).toMatch(/SMTP_SECURE/);
    expect(err?.message).toMatch(/SMTP_STARTTLS/);
    expect(err?.message).not.toContain("secret-key");
    expect(err?.message).not.toContain("project-id");
  });

  it("no credentials: the refusal is not triggered (it proceeds to connect and fails on the socket instead)", async () => {
    const err = await send(new SmtpEmailProvider({ host: "127.0.0.1", port: 1, timeoutMs: 500 }));
    expect(err).toBeDefined();
    expect(err?.message).not.toMatch(/AUTH refused/);
  });
});
