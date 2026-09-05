import { describe, expect, it } from "vitest";
import { redactConnectionString } from "../../src/lib/redact-connection-string.js";

// Passwords that exercise every character libpq URIs have to percent-encode,
// plus a plain one. Each must be absent from the output — in raw AND encoded
// form, since the preview that motivated this file leaked the encoded form.
const PASSWORDS = [
  "plainpassword",
  ";b]Rq[{A[asJg@x/y:z#w?q=1&r=2",
  "50%off",
  "ünïcödé-pässwörd",
];

function encode(pw: string): string {
  return encodeURIComponent(pw);
}

describe("redactConnectionString", () => {
  for (const pw of PASSWORDS) {
    it(`never emits the password (${JSON.stringify(pw).slice(0, 12)}…), raw or encoded`, () => {
      const raw = `postgresql://app_user:${encode(pw)}@db.internal:5432/app?statement_timeout=5000`;
      const out = redactConnectionString(raw);
      expect(out).toBe("postgresql://app_user:***@db.internal:5432/app");
      expect(out).not.toContain(pw);
      expect(out).not.toContain(encode(pw));
      // The first-50-characters "preview" this replaces would have leaked here.
      expect(raw.substring(0, 50)).toContain(encode(pw).substring(0, 5));
    });
  }

  it("keeps scheme, user, host, port and database — what an operator needs to recognise the target", () => {
    expect(redactConnectionString("postgres://svc:secret@10.0.0.7:6432/tenants")).toBe(
      "postgres://svc:***@10.0.0.7:6432/tenants",
    );
  });

  it("drops the query string entirely (libpq accepts ?password= there too)", () => {
    const out = redactConnectionString(
      "postgresql://u@db.internal/app?password=topsecret&sslmode=require",
    );
    expect(out).toBe("postgresql://u@db.internal/app");
    expect(out).not.toContain("topsecret");
    expect(out).not.toContain("sslmode");
  });

  it("handles a user without a password and no database", () => {
    expect(redactConnectionString("postgresql://u@db.internal:5432")).toBe(
      "postgresql://u@db.internal:5432",
    );
    expect(redactConnectionString("postgresql://db.internal/app")).toBe(
      "postgresql://db.internal/app",
    );
  });

  it("decodes a percent-encoded user name so the output is readable", () => {
    expect(redactConnectionString("postgresql://app%2Duser:pw@h/d")).toBe(
      "postgresql://app-user:***@h/d",
    );
  });

  it("returns a fixed placeholder for anything that is not a URL — never a slice of the input", () => {
    const junk = "definitely-not-a-url-but-maybe-a-secret";
    const out = redactConnectionString(junk);
    expect(out).toBe("<connection string: not a URL, redacted>");
    expect(out).not.toContain("definitely");
    expect(redactConnectionString("postgresql:opaque-no-authority")).toBe(
      "<connection string: not a URL, redacted>",
    );
  });

  it("names an unset value explicitly", () => {
    expect(redactConnectionString(undefined)).toBe("<connection string: unset>");
    expect(redactConnectionString("")).toBe("<connection string: unset>");
  });
});
