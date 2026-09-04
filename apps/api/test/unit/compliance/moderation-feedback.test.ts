/**
 * Unit Tests: submit-for-analysis + the CSAM/illegal CARVE-OUT (spec 07 §4.2/§9,
 * plan 08 §5). THE critical correctness surface.
 *
 * Asserts, for an illegal-suspected item:
 *   - the analysis sink is NEVER written,
 *   - preserve + a PENDING AuthorityReport ARE created (channel NEVER auto-submits),
 *   - the response is a NEUTRAL 202 indistinguishable from a lawful accept.
 * And for the lawful path: consent:false→400; consent:true→exactly one sink call;
 * content stays blocked. Plus the anti-oracle (non-owner → neutral, no sink) and
 * server-side re-derivation for text (client-supplied class is never trusted).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";

vi.mock("../../../src/lib/audit-composer.js", () => ({
  TrellisAuditLogger: class {
    async logSystemAction() {}
  },
}));

const mockDb = {
  mediaFile: { findUnique: vi.fn(), update: vi.fn(async () => ({ id: "m1" })) },
  post: { findUnique: vi.fn() },
  postComment: { findUnique: vi.fn() },
  authorityReport: { create: vi.fn(async () => ({ id: "ar1", status: "pending" })) },
};
vi.mock("../../../src/lib/data-router.js", () => ({
  DataRouter: { getDatabaseForRegion: vi.fn(() => mockDb) },
}));

// Valid CAS inputs so the evidence copy-source resolves to a real
// `processing/{tenantId}/{hash}` key (cas-keys.ts validators are strict).
const VALID_TENANT = "c" + "a".repeat(24); // matches /^c[a-z0-9]{24}$/
const VALID_HASH = "a".repeat(64); // matches /^[0-9a-f]{64}$/

import { ModerationFeedbackHandler } from "../../../src/lib/compliance/moderation-feedback.js";
import {
  setModerationFeedbackSink,
  setEvidencePreservationStore,
  setAuthorityReportChannel,
  __resetComplianceSeamsForTests,
} from "../../../src/lib/media/compliance-seams.js";
import {
  setTextModerationProvider,
  __resetTextModerationProviderForTests,
} from "../../../src/lib/media/request-text-moderation.js";
import { MockTextModerationProvider } from "../../../src/lib/media/text-moderation.js";
import { ILLEGAL_SUSPECTED_LABEL } from "../../../src/lib/compliance/block-class.js";

const env = {
  DEFAULT_REGION: "EU",
  // The real media bucket — the evidence copy-source (V2 Finding G). Never the
  // literal placeholder "processing".
  MEDIA_BUCKET_NAME: "dev-skybber-media",
} as unknown as Env;
const requestContext = { region: "EU" } as any;
const OWNER = "owner-1";
const session = { userId: OWNER, email: "o@example.com" } as any;

function req(body: unknown): Request {
  return new Request("https://api.example.com/api/moderation/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A sink + store + channel triple with spies. */
function wireSeams() {
  const store = vi.fn(async () => {});
  const preserve = vi.fn(async () => ({ evidenceId: "ev1" }));
  const channelSubmit = vi.fn(async () => ({ mode: "manual" as const, instructionsKey: "k" }));
  setModerationFeedbackSink({ store });
  setEvidencePreservationStore({ preserve, releaseHold: vi.fn(async () => {}) });
  setAuthorityReportChannel({ submit: channelSubmit });
  return { store, preserve, channelSubmit };
}

describe("ModerationFeedbackHandler — the illegal carve-out", () => {
  let handler: ModerationFeedbackHandler;
  beforeEach(() => {
    vi.clearAllMocks();
    __resetComplianceSeamsForTests();
    __resetTextModerationProviderForTests();
    handler = new ModerationFeedbackHandler();
  });
  afterEach(() => {
    __resetComplianceSeamsForTests();
    __resetTextModerationProviderForTests();
  });

  it("illegal media item: NEVER writes the sink; DOES preserve + create a pending AuthorityReport; NEUTRAL 202", async () => {
    const { store, preserve, channelSubmit } = wireSeams();
    mockDb.mediaFile.findUnique.mockResolvedValue({
      uploadedBy: OWNER,
      blockClass: "illegal-suspected",
      tenantId: VALID_TENANT,
      contentHash: VALID_HASH,
    });

    const res = await handler.handleSubmit(
      req({ resourceType: "media", resourceId: "m1", includeContent: true, consent: true }),
      session,
      env,
      requestContext,
    );

    // THE load-bearing assertions.
    expect(store).not.toHaveBeenCalled(); // sink never touched
    expect(preserve).toHaveBeenCalledTimes(1); // preserved in place
    // The evidence copy-source is the REAL media bucket + canonical processing
    // key — NEVER the placeholder "processing" (V2 Finding G).
    const bundle = preserve.mock.calls[0][0];
    expect(bundle.bytesLocation.bucket).toBe("dev-skybber-media");
    expect(bundle.bytesLocation.key).toBe(`processing/${VALID_TENANT}/${VALID_HASH}`);
    expect(mockDb.authorityReport.create).toHaveBeenCalledTimes(1);
    expect(mockDb.authorityReport.create.mock.calls[0][0].data.status).toBe("pending");
    expect(channelSubmit).not.toHaveBeenCalled(); // NEVER auto-submits
    // Evidence hold set on the original media.
    const holdUpdate = mockDb.mediaFile.update.mock.calls.find(
      (c) => c[0].data.evidenceHold === true,
    );
    expect(holdUpdate).toBeTruthy();

    // Neutral response.
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ received: true });
  });

  it("the illegal-route response is byte-identical to a lawful accept (no oracle)", async () => {
    wireSeams();
    // Illegal.
    mockDb.mediaFile.findUnique.mockResolvedValue({
      uploadedBy: OWNER,
      blockClass: "illegal-suspected",
      tenantId: VALID_TENANT,
      contentHash: VALID_HASH,
    });
    const illegal = await handler.handleSubmit(
      req({ resourceType: "media", resourceId: "m1", includeContent: true, consent: true }),
      session,
      env,
      requestContext,
    );
    // Lawful.
    mockDb.mediaFile.findUnique.mockResolvedValue({
      uploadedBy: OWNER,
      blockClass: "lawful-flagged",
      tenantId: "t1",
      contentHash: "h2",
    });
    const lawful = await handler.handleSubmit(
      req({ resourceType: "media", resourceId: "m2", includeContent: true, consent: true }),
      session,
      env,
      requestContext,
    );
    expect(illegal.status).toBe(lawful.status);
    expect(await illegal.json()).toEqual(await lawful.json());
  });

  it("re-derives illegal class SERVER-SIDE for text over the STORED resource (client class is never trusted)", async () => {
    const { store, preserve } = wireSeams();
    // Stored post owned by the caller, with illegal text.
    mockDb.post.findUnique.mockResolvedValue({
      authorId: OWNER,
      text: "stored illegal text",
    });
    const provider = new MockTextModerationProvider({
      decision: "quarantine",
      labels: [{ category: ILLEGAL_SUSPECTED_LABEL, confidence: 0.99 }],
      provider: "mock",
    });
    setTextModerationProvider(provider);

    const res = await handler.handleSubmit(
      req({
        resourceType: "post",
        resourceId: "p1",
        includeContent: true,
        consent: true,
        content: "some submitted text",
      }),
      session,
      env,
      requestContext,
    );

    // Classified the STORED text, NOT the client-supplied content.
    expect(provider.calls).toContain("stored illegal text");
    expect(provider.calls).not.toContain("some submitted text");
    expect(store).not.toHaveBeenCalled(); // illegal → not the sink
    expect(preserve).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(202);
  });

  it("HOLE #2 CLOSURE: benign client content for an illegal STORED post is NOT labelled lawful (no relabel)", async () => {
    const { store, preserve } = wireSeams();
    // Stored post is illegal; the attacker submits benign `content` for its id.
    mockDb.post.findUnique.mockResolvedValue({
      authorId: OWNER,
      text: "ILLEGAL stored text the attacker wants relabelled",
    });
    // Content-aware provider: illegal iff the text contains the ILLEGAL marker.
    const calls: string[] = [];
    setTextModerationProvider({
      async moderateText(text: string) {
        calls.push(text);
        const flagged = text.includes("ILLEGAL");
        return {
          decision: flagged ? ("quarantine" as const) : ("approved" as const),
          labels: flagged
            ? [{ category: ILLEGAL_SUSPECTED_LABEL, confidence: 0.99 }]
            : [],
          provider: "mock",
        };
      },
    });

    const res = await handler.handleSubmit(
      req({
        resourceType: "post",
        resourceId: "p1",
        includeContent: true,
        consent: true,
        content: "cute puppy", // benign decoy
      }),
      session,
      env,
      requestContext,
    );

    // The STORED (illegal) text was classified — not the benign decoy — so the
    // record is routed to the carve-out, NOT written to the sink as lawful.
    expect(calls).toContain("ILLEGAL stored text the attacker wants relabelled");
    expect(calls).not.toContain("cute puppy");
    expect(store).not.toHaveBeenCalled(); // never labelled lawful → never sunk
    expect(preserve).toHaveBeenCalledTimes(1); // routed to preserve instead
    expect(res.status).toBe(202);
  });

  it("ANTI-ORACLE: feedback for a post owned by SOMEONE ELSE → neutral 202, no sink, no preserve", async () => {
    const { store, preserve } = wireSeams();
    mockDb.post.findUnique.mockResolvedValue({
      authorId: "someone-else",
      text: "not your post",
    });
    const res = await handler.handleSubmit(
      req({ resourceType: "post", resourceId: "p1", includeContent: true, consent: true, content: "x" }),
      session,
      env,
      requestContext,
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ received: true });
    expect(store).not.toHaveBeenCalled();
    expect(preserve).not.toHaveBeenCalled();
  });

  it("FINDING G FAIL-LOUD: illegal media with a placeholder/unset source bucket THROWS (500) — never preserves manifest-only", async () => {
    const { store, preserve } = wireSeams();
    mockDb.mediaFile.findUnique.mockResolvedValue({
      uploadedBy: OWNER,
      blockClass: "illegal-suspected",
      tenantId: VALID_TENANT,
      contentHash: VALID_HASH,
    });
    // Env with NO real media bucket configured.
    const envNoBucket = { DEFAULT_REGION: "EU" } as unknown as Env;

    const res = await handler.handleSubmit(
      req({ resourceType: "media", resourceId: "m1", includeContent: true, consent: true }),
      session,
      envNoBucket,
      requestContext,
    );

    // Fail-loud: generic 500, and NOTHING preserved (no half-preserve).
    expect(res.status).toBe(500);
    expect(preserve).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });
});

describe("ModerationFeedbackHandler — the lawful path", () => {
  let handler: ModerationFeedbackHandler;
  beforeEach(() => {
    vi.clearAllMocks();
    __resetComplianceSeamsForTests();
    __resetTextModerationProviderForTests();
    handler = new ModerationFeedbackHandler();
  });
  afterEach(() => {
    __resetComplianceSeamsForTests();
    __resetTextModerationProviderForTests();
  });

  it("consent:false → 400 (consent must be literally true)", async () => {
    wireSeams();
    const res = await handler.handleSubmit(
      req({ resourceType: "media", resourceId: "m1", includeContent: true, consent: false }),
      session,
      env,
      requestContext,
    );
    expect(res.status).toBe(400);
  });

  it("consent missing → 400", async () => {
    wireSeams();
    const res = await handler.handleSubmit(
      req({ resourceType: "media", resourceId: "m1", includeContent: true }),
      session,
      env,
      requestContext,
    );
    expect(res.status).toBe(400);
  });

  it("lawful media + consent:true → exactly ONE sink call; content stays blocked", async () => {
    const { store, preserve } = wireSeams();
    mockDb.mediaFile.findUnique.mockResolvedValue({
      uploadedBy: OWNER,
      blockClass: "lawful-flagged",
      tenantId: "t1",
      contentHash: "h1",
    });
    const res = await handler.handleSubmit(
      req({ resourceType: "media", resourceId: "m1", includeContent: true, consent: true, description: "please review" }),
      session,
      env,
      requestContext,
    );
    expect(store).toHaveBeenCalledTimes(1);
    const record = store.mock.calls[0][0];
    expect(record.blockClass).toBe("lawful-flagged");
    expect(record.dedupKey).toBe(`${OWNER}:media:m1`);
    // Content stays blocked: nothing preserved, nothing un-hidden.
    expect(preserve).not.toHaveBeenCalled();
    expect(mockDb.mediaFile.update).not.toHaveBeenCalled();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ received: true });
  });

  it("stable dedupKey across identical submits (idempotency identity)", async () => {
    const { store } = wireSeams();
    mockDb.mediaFile.findUnique.mockResolvedValue({
      uploadedBy: OWNER,
      blockClass: "lawful-flagged",
      tenantId: "t1",
      contentHash: "h1",
    });
    const body = { resourceType: "media", resourceId: "m1", includeContent: true, consent: true };
    await handler.handleSubmit(req(body), session, env, requestContext);
    await handler.handleSubmit(req(body), session, env, requestContext);
    expect(store.mock.calls[0][0].dedupKey).toBe(store.mock.calls[1][0].dedupKey);
  });

  it("ANTI-ORACLE: non-owner media → neutral 202, sink NEVER written", async () => {
    const { store, preserve } = wireSeams();
    mockDb.mediaFile.findUnique.mockResolvedValue({
      uploadedBy: "someone-else",
      blockClass: "illegal-suspected",
      tenantId: "t1",
      contentHash: "h1",
    });
    const res = await handler.handleSubmit(
      req({ resourceType: "media", resourceId: "m1", includeContent: true, consent: true }),
      session,
      env,
      requestContext,
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ received: true });
    expect(store).not.toHaveBeenCalled();
    expect(preserve).not.toHaveBeenCalled();
  });
});
