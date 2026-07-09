/**
 * End-to-end regression test for the invitation-only signup gate.
 *
 * This is the test that would have caught the launch-blocking bug: the real
 * invitation-creation writer (`writePreSignUpInvitationRecord`) and the real
 * Cognito PreSignUp trigger (`pre-signup.ts`) are exercised against a single
 * shared in-memory DynamoDB table, with the REAL `marshall`/`unmarshall`. It
 * proves the writer emits exactly the record the reader expects, keyed off the
 * same code value — so an invited user can actually pass the gate — and that
 * PostConfirmation's `markPreSignUpInvitationRecordUsed` closes the code to
 * reuse.
 *
 * Before the fix, no non-test code wrote this record, so every real invited
 * signup was rejected by PreSignUp.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  markPreSignUpInvitationRecordUsed,
  preSignUpInvitationPk,
  writePreSignUpInvitationRecord,
} from "../../src/lib/invitation-presignup-record.js";

// One in-memory DynamoDB table shared by the writer and the PreSignUp reader.
// Items are stored in their raw (marshalled) form, keyed by pk|sk — exactly how
// DynamoDB would.
const { store } = vi.hoisted(() => ({
  store: new Map<string, Record<string, any>>(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => {
  const keyOf = (m: any) => `${m?.pk?.S}|${m?.sk?.S}`;
  class DynamoDBClient {
    async send(cmd: any) {
      if (cmd.__kind === "put") {
        store.set(keyOf(cmd.input.Item), cmd.input.Item);
        return {};
      }
      if (cmd.__kind === "get") {
        const item = store.get(keyOf(cmd.input.Key));
        return item ? { Item: item } : {};
      }
      throw new Error(`unexpected DynamoDB command: ${cmd?.__kind}`);
    }
  }
  class PutItemCommand {
    input: any;
    __kind = "put";
    constructor(input: any) {
      this.input = input;
    }
  }
  class GetItemCommand {
    input: any;
    __kind = "get";
    constructor(input: any) {
      this.input = input;
    }
  }
  return { DynamoDBClient, PutItemCommand, GetItemCommand };
});

// PreSignUp reads DYNAMODB_TABLE at module load; set it before the dynamic
// import below.
process.env.AWS_REGION = "us-east-1";
process.env.DYNAMODB_TABLE = "test-trellis";

async function loadPreSignUp() {
  const mod = await import("../../src/lambda/pre-signup.js");
  return mod.handler;
}

function preSignUpEvent(invitationCode: string) {
  return {
    request: {
      userAttributes: { email: "invitee@example.com" },
      clientMetadata: { invitationCode },
    },
    response: {
      autoConfirmUser: false,
      autoVerifyEmail: false,
      autoVerifyPhone: false,
    },
  } as any;
}

describe("invitation-only signup gate (writer + PreSignUp reader)", () => {
  beforeEach(() => {
    store.clear();
  });

  it("write → PreSignUp accepts → PostConfirmation marks used → PreSignUp rejects reuse", async () => {
    const handler = await loadPreSignUp();
    const code = "ABC12345DE"; // as generated/stored (upper-case)
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    // 1. Create-invitation writer emits the PreSignUp record.
    await writePreSignUpInvitationRecord({ code, expiresAt, email: null });

    // The raw item is shaped exactly as pre-signup.ts reads it.
    const raw = store.get(`invitations:${code}|v`);
    expect(raw).toBeDefined();
    expect(raw!.pk).toEqual({ S: "invitations:ABC12345DE" });
    expect(raw!.sk).toEqual({ S: "v" });
    expect(raw!.used).toEqual({ BOOL: false });
    expect(raw!.ttl).toEqual({ N: String(Math.floor(expiresAt.getTime() / 1000)) });
    // No email restriction → no email attribute written.
    expect(raw!.email).toBeUndefined();

    // 2. PreSignUp accepts the invited signup (auto-confirm/verify).
    const accepted = await handler(preSignUpEvent(code), {} as any, () => {});
    expect(accepted!.response.autoConfirmUser).toBe(true);
    expect(accepted!.response.autoVerifyEmail).toBe(true);

    // 3. PostConfirmation burns the code.
    await markPreSignUpInvitationRecordUsed({ code, usedBy: "user-123" });
    const used = store.get(`invitations:${code}|v`);
    expect(used!.used).toEqual({ BOOL: true });
    expect(used!.usedBy).toEqual({ S: "user-123" });

    // 4. A second signup with the same code is rejected (reuse prevented).
    await expect(
      handler(preSignUpEvent(code), {} as any, () => {}),
    ).rejects.toThrow("already been used");
  });

  it("carries the email restriction onto the record for a future email-match check", async () => {
    const code = "EMAILONLY1";
    await writePreSignUpInvitationRecord({
      code,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      email: "friend@example.com",
    });
    const raw = store.get(`invitations:${code}|v`);
    expect(raw!.email).toEqual({ S: "friend@example.com" });
  });

  it("PreSignUp rejects an expired record", async () => {
    const handler = await loadPreSignUp();
    const code = "EXPIRED123";
    // ttl in the past.
    await writePreSignUpInvitationRecord({
      code,
      expiresAt: new Date(Date.now() - 60 * 1000),
      email: null,
    });
    await expect(
      handler(preSignUpEvent(code), {} as any, () => {}),
    ).rejects.toThrow("expired");
  });

  it("pk is canonicalized upper-case so it matches the code the user presents", () => {
    // Invitation codes are stored/presented upper-case; the writer must key the
    // pk to the same value regardless of the casing it is handed.
    expect(preSignUpInvitationPk("abc12345de")).toBe("invitations:ABC12345DE");
    expect(preSignUpInvitationPk("ABC12345DE")).toBe("invitations:ABC12345DE");
  });
});
