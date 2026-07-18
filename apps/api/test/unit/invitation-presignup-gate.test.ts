/**
 * Outcome-equivalence regression test for the invitation-only signup gate
 * writer/deleter/marker, on the `@de-otio/saas-foundation` `KvStore` port.
 *
 * The three functions (`writePreSignUpInvitationRecord`,
 * `markPreSignUpInvitationRecordUsed`, `deletePreSignUpInvitationRecord`) are
 * exercised against an injected in-memory `KvStore`, and every assertion reads
 * the store BACK to prove the OUTCOME the Cognito PreSignUp trigger depends on:
 *   - after write: the code's record exists with `used === false` and a TTL,
 *   - after mark-used: `used === true` and `usedBy` recorded (reuse blocked),
 *   - after delete: the record is gone (PreSignUp then fails closed),
 *   - the key is canonicalized upper-case, so a lower-case code and its
 *     upper-case form address the same record (the load-bearing casing note),
 *   - an email restriction is carried onto the value for a future match check.
 *
 * This replaces the earlier command-shape assertions (raw marshalled DynamoDB
 * items) with behavior the port guarantees on every backend (Dynamo/Postgres/
 * Memory); the DynamoKvStore layout keeps the AWS raw item byte-compatible.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryKvStore } from "@de-otio/saas-foundation/kv";
import {
  __setInvitationStoreForTest,
  deletePreSignUpInvitationRecord,
  markPreSignUpInvitationRecordUsed,
  preSignUpInvitationPk,
  writePreSignUpInvitationRecord,
} from "../../src/lib/invitation-presignup-record.js";

interface PreSignUpValue {
  used: boolean;
  usedBy?: string;
  email?: string;
}

describe("invitation-only signup gate (KvStore writer/marker/deleter)", () => {
  let store: MemoryKvStore;

  beforeEach(() => {
    store = new MemoryKvStore();
    __setInvitationStoreForTest(store);
  });

  afterEach(() => {
    __setInvitationStoreForTest(null);
  });

  it("write → record exists unused with TTL → mark used → record used → delete → gone", async () => {
    const code = "ABC12345DE"; // as generated/stored (upper-case)
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    // 1. Create-invitation writer stores the fail-closed record.
    await writePreSignUpInvitationRecord({ code, expiresAt, email: null });

    const written = await store.get<PreSignUpValue>(code.toUpperCase());
    expect(written).not.toBeNull();
    expect(written!.value.used).toBe(false);
    // Expiry is set from `expiresAt` in epoch seconds (what PreSignUp checks).
    expect(written!.expiresAt).toBe(Math.floor(expiresAt.getTime() / 1000));
    // No email restriction → no email carried on the value.
    expect(written!.value.email).toBeUndefined();
    expect(written!.value.usedBy).toBeUndefined();

    // 2. PostConfirmation burns the code (reuse prevented).
    await markPreSignUpInvitationRecordUsed({ code, usedBy: "user-123" });

    const used = await store.get<PreSignUpValue>(code.toUpperCase());
    expect(used!.value.used).toBe(true);
    expect(used!.value.usedBy).toBe("user-123");

    // 3. Invitation-delete cleanup removes the record → PreSignUp fails closed.
    await deletePreSignUpInvitationRecord({ code });
    expect(await store.get<PreSignUpValue>(code.toUpperCase())).toBeNull();
  });

  it("mark-used without an explicit expiry writes a bounded future TTL", async () => {
    const code = "NOEXPIRY01";
    const before = Math.floor(Date.now() / 1000);
    await markPreSignUpInvitationRecordUsed({ code, usedBy: "user-9" });
    const rec = await store.get<PreSignUpValue>(code.toUpperCase());
    expect(rec!.value.used).toBe(true);
    // Default bound is ~24h out; assert it is comfortably in the future.
    expect(rec!.expiresAt).toBeGreaterThan(before + 23 * 60 * 60);
  });

  it("carries the email restriction onto the record for a future email-match check", async () => {
    const code = "EMAILONLY1";
    await writePreSignUpInvitationRecord({
      code,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      email: "friend@example.com",
    });
    const rec = await store.get<PreSignUpValue>(code.toUpperCase());
    expect(rec!.value.email).toBe("friend@example.com");
    expect(rec!.value.used).toBe(false);
  });

  it("canonicalizes casing: a lower-case code writes to the upper-case key", async () => {
    // Invitation codes are stored/presented upper-case; the writer must key the
    // record to the same value regardless of the casing it is handed, so the
    // pk it writes equals the pk the user presents at signup.
    await writePreSignUpInvitationRecord({
      code: "lowercode1",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      email: null,
    });
    // Readable via the canonical upper-case key…
    expect(await store.get<PreSignUpValue>("LOWERCODE1")).not.toBeNull();
    // …and NOT under the raw lower-case key.
    expect(await store.get<PreSignUpValue>("lowercode1")).toBeNull();
  });

  it("delete canonicalizes casing: a lower-case code removes the upper-case record", async () => {
    await writePreSignUpInvitationRecord({
      code: "DELETEME01",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      email: null,
    });
    expect(await store.get<PreSignUpValue>("DELETEME01")).not.toBeNull();

    await deletePreSignUpInvitationRecord({ code: "deleteme01" });
    expect(await store.get<PreSignUpValue>("DELETEME01")).toBeNull();
  });

  it("pk is canonicalized upper-case so it matches the code the user presents", () => {
    expect(preSignUpInvitationPk("abc12345de")).toBe("invitations:ABC12345DE");
    expect(preSignUpInvitationPk("ABC12345DE")).toBe("invitations:ABC12345DE");
  });
});
