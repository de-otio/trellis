/**
 * Plan 015 WS-5 — provider-neutral DeletionEmailPort for the worker container.
 *
 * Proves makeEmailPortFromEnv():
 *  - fail-closed to undefined (no provider / half-configured / no From), so the
 *    nightly core skips the confirmation send rather than throwing mid-batch;
 *  - when configured (scaleway-tem here), adapts sendAccountDeleted → the
 *    provider's sendEmail with a DMARC-aligned From `${brand} <${FROM_EMAIL}>`
 *    and the completion subject/text/html mapped through.
 *
 * TEM transport is stubbed at global.fetch (same style as
 * email-provider-scaleway.test.ts) — no live API.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeEmailPortFromEnv } from "../../../src/lib/workers/deletion-email-port.js";

const TEM_ENV = {
  EMAIL_SERVICE: "scaleway-tem",
  TEM_PROJECT_ID: "11111111-2222-3333-4444-555555555555",
  TEM_SECRET_KEY: "scw-secret",
  TEM_REGION: "fr-par",
  FROM_EMAIL: "noreply@mail.example.test",
  EMAIL_BRAND_NAME: "Skybber",
} as const;

describe("makeEmailPortFromEnv — fail-closed selection", () => {
  it("returns undefined when EMAIL_SERVICE is unset", () => {
    expect(makeEmailPortFromEnv({})).toBeUndefined();
    expect(makeEmailPortFromEnv({ FROM_EMAIL: "x@example.test" })).toBeUndefined();
  });

  it("returns undefined when the selected provider's required env is missing", () => {
    // scaleway-tem without TEM_PROJECT_ID ⇒ validateEmailEnv fails ⇒ no port.
    expect(
      makeEmailPortFromEnv({
        EMAIL_SERVICE: "scaleway-tem",
        TEM_SECRET_KEY: "scw-secret",
        FROM_EMAIL: "noreply@mail.example.test",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when no From address is resolvable", () => {
    // aws-ses requires FROM_EMAIL (validateEmailEnv); absent ⇒ no port.
    expect(makeEmailPortFromEnv({ EMAIL_SERVICE: "aws-ses" })).toBeUndefined();
  });

  it("builds a port when the provider is fully configured", () => {
    expect(makeEmailPortFromEnv({ ...TEM_ENV })).toBeDefined();
  });
});

describe("makeEmailPortFromEnv — send adaptation (scaleway-tem)", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ emails: [{ message_id: "mid-1" }] }),
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("adapts sendAccountDeleted → sendEmail with a DMARC-aligned From and mapped bodies", async () => {
    const port = makeEmailPortFromEnv({ ...TEM_ENV })!;
    await port.sendAccountDeleted({
      to: "user@example.test",
      subject: "Your account has been deleted",
      textBody: "plain body",
      htmlBody: "<p>rich body</p>",
    });

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(
      "https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails",
    );
    const body = JSON.parse(init.body);
    // From aligned to `${EMAIL_BRAND_NAME} <${FROM_EMAIL}>`.
    expect(body.from).toEqual({ email: "noreply@mail.example.test", name: "Skybber" });
    expect(body.to).toEqual([{ email: "user@example.test" }]);
    expect(body.subject).toBe("Your account has been deleted");
    expect(body.text).toBe("plain body");
    expect(body.html).toBe("<p>rich body</p>");
    expect(body.project_id).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("defaults the brand name to 'Trellis' when EMAIL_BRAND_NAME is unset", async () => {
    const { EMAIL_BRAND_NAME: _omit, ...noBrand } = TEM_ENV;
    const port = makeEmailPortFromEnv({ ...noBrand })!;
    await port.sendAccountDeleted({
      to: "user@example.test",
      subject: "s",
      textBody: "t",
      htmlBody: "<p>h</p>",
    });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body).from).toEqual({
      email: "noreply@mail.example.test",
      name: "Trellis",
    });
  });
});
