/**
 * Idempotency Store
 *
 * DynamoDB-backed persistence layer for idempotency records.
 * Separated from the middleware so unit tests can inject a mock store.
 *
 * Table key layout:
 *   pk  = "idem#<key>"   (String, primary key)
 *
 * TTL attribute: expiresAt (Unix epoch seconds)
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  ConditionalCheckFailedException,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

/** Status of an in-flight request being processed by another worker. */
export const IN_FLIGHT_SENTINEL = "__IN_FLIGHT__" as const;

export interface IdempotencyRecord {
  /** Composite pk stored in DynamoDB */
  pk: string;
  /** SHA-256 hex of method + path + body */
  requestHash: string;
  /** HTTP status code of the original response */
  responseStatus: number;
  /** Serialised response body text */
  responseBody: string;
  /** Response headers that should be replayed */
  responseHeaders: Record<string, string>;
  /** Unix epoch seconds — DynamoDB TTL attribute */
  expiresAt: number;
}

/** Sentinel record written before the handler runs to claim the key. */
export interface InFlightRecord {
  pk: string;
  requestHash: string;
  /** Sentinel value indicating an in-progress request */
  responseStatus: 0;
  responseBody: typeof IN_FLIGHT_SENTINEL;
  responseHeaders: Record<string, string>;
  expiresAt: number;
}

export type StoredRecord = IdempotencyRecord | InFlightRecord;

export function isInFlight(r: StoredRecord): r is InFlightRecord {
  return r.responseBody === IN_FLIGHT_SENTINEL;
}

/** Abstract store interface — makes the middleware unit-testable. */
export interface IdempotencyStoreInterface {
  get(pk: string): Promise<StoredRecord | null>;
  /**
   * Conditionally insert the record only when the pk does not yet exist.
   * Returns true on success, false when the condition fails (key already exists).
   */
  putIfAbsent(record: StoredRecord): Promise<boolean>;
  /** Replace an existing in-flight record with the final response record. */
  resolve(record: IdempotencyRecord): Promise<void>;
  /** Delete a record (used to clean up a failed in-flight claim). */
  delete(pk: string): Promise<void>;
}

/**
 * DynamoDB-backed implementation of IdempotencyStoreInterface.
 */
export class DynamoIdempotencyStore implements IdempotencyStoreInterface {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;

  constructor(tableName: string, region?: string) {
    this.tableName = tableName;
    this.client = new DynamoDBClient({ region: region ?? process.env.AWS_REGION ?? "eu-central-1" });
  }

  async get(pk: string): Promise<StoredRecord | null> {
    const result = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: marshall({ pk }),
        ConsistentRead: true,
      }),
    );

    if (!result.Item) return null;

    const raw = unmarshall(result.Item) as StoredRecord;

    // Respect DynamoDB TTL: if the item is past its expiresAt treat as not found.
    // DynamoDB TTL deletion is eventually consistent, so we enforce it ourselves.
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof raw.expiresAt === "number" && raw.expiresAt < nowSec) {
      return null;
    }

    return raw;
  }

  async putIfAbsent(record: StoredRecord): Promise<boolean> {
    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: marshall(record, { removeUndefinedValues: true }),
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        return false;
      }
      throw err;
    }
  }

  async resolve(record: IdempotencyRecord): Promise<void> {
    await this.client.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: marshall(record, { removeUndefinedValues: true }),
      }),
    );
  }

  async delete(pk: string): Promise<void> {
    await this.client.send(
      new DeleteItemCommand({
        TableName: this.tableName,
        Key: marshall({ pk }),
      }),
    );
  }
}

/**
 * Build the DynamoDB pk for an idempotency key value.
 *
 * Hardening (G4 HIGH-1): the dedup key is composed of the caller-supplied
 * raw key AND a scope value (tenantId or userId). Two callers that
 * happen to choose the same raw `Idempotency-Key` for unrelated
 * federation operations will land on different pks because their
 * scopes differ. Scope is sanitised to a stable shape (`/[^a-zA-Z0-9_-]/`
 * replaced with `_`) so pathological inputs cannot collide with other
 * scopes.
 */
export function buildPk(key: string, scope?: string | null): string {
  // Allow `:` in the scope (it's the prefix separator the deriveScope helper
  // uses, e.g. `t:tenant-id`). `#` is the structural separator in the pk
  // and any literal `#` in the scope is collapsed to `_` so the input
  // can't fake the segment boundary.
  const safeScope = (scope ?? "anon").replace(/[^a-zA-Z0-9_:-]/g, "_");
  return `idem#${safeScope}#${key}`;
}

/** TTL: 24 hours in seconds */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/**
 * In-flight TTL: 60 seconds (G4 MEDIUM-5). The sentinel record we
 * write before invoking the handler must expire on its own if the
 * worker dies between claim and resolve, so subsequent retries are
 * not permanently blocked by an orphan in-flight row.
 */
export const IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS = 60;
