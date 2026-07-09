/**
 * PreSignUp invitation record (raw DynamoDB item).
 *
 * The Cognito PreSignUp trigger (`apps/api/src/lambda/pre-signup.ts`) enforces
 * invitation-only signup fail-closed by `GetItem`-ing a raw DynamoDB item keyed
 * `{ pk: "invitations:<CODE>", sk: "v" }` and rejecting when it is missing,
 * `used` is truthy, or `ttl` (epoch seconds) is in the past. That item is the
 * ONLY thing PreSignUp reads — the trigger has no DB/RDS access by design.
 *
 * This module is the single writer of that item, so real invited signup works:
 *   - {@link writePreSignUpInvitationRecord} runs when an invitation is created
 *     (invitation-handler), so the invited user can actually pass the gate.
 *     Before this existed, only tests seeded the row and invited signup was
 *     impossible in any real environment (the create flow wrote only a Prisma
 *     `Invitation` row + an `invitation-session:` KV token, neither of which
 *     PreSignUp reads).
 *   - {@link markPreSignUpInvitationRecordUsed} runs from PostConfirmation after
 *     a successful signup, flipping `used: true` so the code cannot be redeemed
 *     a second time (PreSignUp rejects `used` items).
 *
 * CASING (load-bearing): PreSignUp looks up the code exactly as the user submits
 * it — no case transform. Invitation codes are generated and stored upper-case
 * (`generateInvitationCode`), the Zod validate/redeem schemas upper-case, and
 * `markInvitationAsUsed` / PostConfirmation upper-case before the Prisma lookup.
 * So we canonicalize to upper-case here too: the pk we WRITE must equal the pk
 * the user PRESENTS at signup. A casing mismatch silently reintroduces the bug.
 */

import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";

function defaultClient(): DynamoDBClient {
  return new DynamoDBClient({
    region: process.env.AWS_REGION || "us-east-1",
    ...(process.env.DYNAMODB_ENDPOINT
      ? { endpoint: process.env.DYNAMODB_ENDPOINT }
      : {}),
  });
}

function defaultTable(): string {
  return process.env.DYNAMODB_TABLE || `${process.env.STAGE || "dev"}-trellis`;
}

/** The `pk` the PreSignUp reader looks up for a given invitation code. */
export function preSignUpInvitationPk(code: string): string {
  return `invitations:${code.toUpperCase()}`;
}

export interface WritePreSignUpInvitationRecordInput {
  /** The invitation code (as stored in Prisma / returned to the inviter). */
  code: string;
  /** Invitation expiry — written as the DynamoDB `ttl` in epoch SECONDS. */
  expiresAt: Date;
  /** Email restriction, if the invite is email-scoped. Carried for a future
   *  PreSignUp email-match check; PreSignUp does NOT enforce it today. */
  email?: string | null;
  /** Injectable for tests. */
  client?: DynamoDBClient;
  /** Injectable for tests. */
  tableName?: string;
}

/**
 * Write the fail-closed PreSignUp record for a freshly created invitation.
 * Shape mirrors exactly what `pre-signup.ts` reads.
 */
export async function writePreSignUpInvitationRecord(
  input: WritePreSignUpInvitationRecordInput,
): Promise<void> {
  const client = input.client ?? defaultClient();
  const table = input.tableName ?? defaultTable();
  const item = {
    pk: preSignUpInvitationPk(input.code),
    sk: "v",
    used: false,
    ttl: Math.floor(input.expiresAt.getTime() / 1000),
    ...(input.email ? { email: input.email } : {}),
  };
  await client.send(
    new PutItemCommand({ TableName: table, Item: marshall(item) }),
  );
}

export interface MarkPreSignUpInvitationRecordUsedInput {
  /** The invitation code presented at signup. */
  code: string;
  /** User id (or email) that redeemed the code. */
  usedBy: string;
  /** Preserved email restriction, if known. */
  email?: string | null;
  /** Preserved expiry, if known; otherwise a bounded future ttl is used. */
  expiresAt?: Date;
  /** Injectable for tests. */
  client?: DynamoDBClient;
  /** Injectable for tests. */
  tableName?: string;
}

/**
 * Mark the PreSignUp record `used` so the code cannot be redeemed twice.
 *
 * Uses `PutItem` (not `UpdateItem`) deliberately: the PostConfirmation Lambda
 * role is granted `dynamodb:PutItem` but not `dynamodb:UpdateItem`, so
 * overwriting the item keeps this fix self-contained (no IAM/CDK change). Only
 * `used: true` is load-bearing for the gate — PreSignUp rejects any item whose
 * `used` is truthy (and also rejects a missing item, so this fails closed even
 * if the marker were lost).
 */
export async function markPreSignUpInvitationRecordUsed(
  input: MarkPreSignUpInvitationRecordUsedInput,
): Promise<void> {
  const client = input.client ?? defaultClient();
  const table = input.tableName ?? defaultTable();
  const ttlMs =
    input.expiresAt?.getTime() ?? Date.now() + 24 * 60 * 60 * 1000;
  const item = {
    pk: preSignUpInvitationPk(input.code),
    sk: "v",
    used: true,
    usedBy: input.usedBy,
    ttl: Math.floor(ttlMs / 1000),
    ...(input.email ? { email: input.email } : {}),
  };
  await client.send(
    new PutItemCommand({ TableName: table, Item: marshall(item) }),
  );
}
