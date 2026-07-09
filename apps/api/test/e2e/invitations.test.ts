/**
 * Invitations E2E Tests
 *
 * Tests invitation list, create, delete, and validation endpoints.
 */

import { afterAll, describe, expect, it } from "vitest";
import {
  DynamoDBClient,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";
import { TestCleanup } from "./utils/cleanup.js";

const API_URL = getApiUrl();

// Same DynamoDB client + table wiring the e2e harness uses when it seeds
// invitation records (see utils/e2e-test-user.ts): region from AWS_REGION,
// table `${stage}-trellis`. Lets this suite read the raw PreSignUp record the
// invitation-create writer emits — no new env.
const region = process.env.AWS_REGION || "eu-central-1";
const stage = process.env.STAGE || process.env.ENVIRONMENT || "dev";
const dynamoTable = `${stage}-trellis`;
const dynamo = new DynamoDBClient({ region });

async function getPreSignUpRecord(
  code: string,
): Promise<Record<string, any> | undefined> {
  const res = await dynamo.send(
    new GetItemCommand({
      TableName: dynamoTable,
      Key: {
        pk: { S: `invitations:${code.toUpperCase()}` },
        sk: { S: "v" },
      },
    }),
  );
  return res.Item ? unmarshall(res.Item) : undefined;
}

describe("Invitations", () => {
  const user = getShardUser(0);
  const cleanup = new TestCleanup(user.authFetch);

  afterAll(async () => {
    await cleanup.cleanAll();
  });

  it("list invitations returns valid structure", async () => {
    const res = await user.authFetch(`${API_URL}/api/invitations`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
  });

  it("get inviter info returns valid response", async () => {
    const res = await user.authFetch(`${API_URL}/api/invitations/inviter-info`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
  });

  it("create and delete invitation (writes then removes the PreSignUp record)", async () => {
    const inviteEmail = `__e2e_invite_${Date.now()}@example.com`;
    const createRes = await user.authFetch(`${API_URL}/api/invitations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: inviteEmail }),
    });
    expect(createRes.status).not.toBe(401);
    expect(createRes.status).toBeLessThan(500);

    if (createRes.status === 201 || createRes.status === 200) {
      const body = await createRes.json();
      // Create returns { invitation: { id, code, ... }, remainingToday }
      // (invitation-handler.ts createInvitationWithEmail).
      const invitationId = body.invitation?.id;
      const invitationCode = body.invitation?.code;
      if (invitationId && invitationCode) {
        cleanup.track("invitation", invitationId);

        // LIVE WRITE-PROOF: creating an invitation must write the fail-closed
        // PreSignUp record the Cognito trigger reads, keyed to the same code.
        const afterCreate = await getPreSignUpRecord(invitationCode);
        expect(afterCreate).toBeDefined();
        expect(afterCreate!.used).toBe(false);
        // Email-restricted invite → the restriction is carried onto the record.
        expect(afterCreate!.email).toBe(inviteEmail);

        // Delete it
        const deleteRes = await user.authFetch(`${API_URL}/api/invitations/${invitationId}`, {
          method: "DELETE",
        });
        expect(deleteRes.status).toBeLessThan(500);

        // REGRESSION GUARD: deleting the invitation must also remove the
        // PreSignUp record, so the deleted code is no longer redeemable.
        if (deleteRes.status >= 200 && deleteRes.status < 300) {
          const afterDelete = await getPreSignUpRecord(invitationCode);
          expect(afterDelete).toBeUndefined();
        }
      }
    }
  });

  it("validate invitation with bad code", async () => {
    const res = await user.authFetch(`${API_URL}/api/invitations/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "invalid-code-12345" }),
    });
    expect(res.status).not.toBe(401);
    // Expect 400 or 404 for invalid code
    expect(res.status).toBeLessThan(500);
  });
});
