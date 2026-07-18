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
import { DynamoKvStore, type KvStore } from "@de-otio/saas-foundation/kv";

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
 * `KvStore`-backed implementation of `IdempotencyStoreInterface` (WS-1 KV port).
 *
 * Wraps the `@de-otio/saas-foundation` `KvStore` port so the middleware is
 * portable across backends (DynamoKvStore on AWS, PostgresKvStore on Scaleway)
 * without a behavior change. On AWS the store is a `DynamoKvStore` over a
 * byte-compat layout (`pkPrefix:"idem"`, `pkSeparator:"#"`, ttl attr
 * `expiresAt`, pk-only) so the at-rest pk stays `idem#<scope>#<key>`.
 *
 * Key derivation: the interface hands us a full composite pk
 * (`idem#<scope>#<key>`, see `buildPk`). The port re-composes the pk from
 * `pkPrefix + pkSeparator + key`, so we strip the leading `idem#` and hand the
 * remaining `<scope>#<key>` as the store key (the layout's
 * `allowSeparatorInKey:true` permits the `#` this composite key legitimately
 * contains).
 *
 * Value discipline: `pk` (partition attr) and `expiresAt` (ttl attr) are
 * reserved by the layout, so they are stripped before the write and
 * reconstructed on read.
 *
 * F1 (plan-sanctioned improvement): the port treats an expired-but-unswept row
 * as absent, so a stale idempotency row no longer wrongly rejects a fresh retry.
 */
export class KvStoreIdempotencyStore implements IdempotencyStoreInterface {
  constructor(private readonly store: KvStore) {}

  /** Strip the structural `idem#` prefix; the port re-composes it via pkPrefix. */
  private keyOf(pk: string): string {
    return pk.startsWith("idem#") ? pk.slice(5) : pk;
  }

  async get(pk: string): Promise<StoredRecord | null> {
    // Strong read is LOAD-BEARING for dedup correctness (matches ConsistentRead).
    const rec = await this.store.get<Omit<StoredRecord, "pk" | "expiresAt">>(this.keyOf(pk), {
      consistent: true,
    });
    if (rec === null) return null;
    return { pk, ...rec.value, expiresAt: rec.expiresAt ?? 0 } as StoredRecord;
  }

  async putIfAbsent(record: StoredRecord): Promise<boolean> {
    const { pk, expiresAt, ...value } = record;
    const res = await this.store.putIfAbsent(this.keyOf(pk), value, { expiresAt });
    return res.applied;
  }

  async resolve(record: IdempotencyRecord): Promise<void> {
    const { pk, expiresAt, ...value } = record;
    // Unconditional overwrite of the in-flight sentinel with the final response.
    await this.store.put(this.keyOf(pk), value, { expiresAt });
  }

  async delete(pk: string): Promise<void> {
    await this.store.delete(this.keyOf(pk));
  }
}

/**
 * Lazy-default factory: build a `KvStoreIdempotencyStore` over a `DynamoKvStore`
 * whose layout is byte-compat with the pre-port single-attr-pk idempotency table
 * (ttl attr `expiresAt`, no sort key). Preserves the exact AWS storage behavior;
 * the middleware constructs this by default so wiring stays zero-behavior-change.
 */
export function createIdempotencyStoreFromEnv(tableName: string): IdempotencyStoreInterface {
  const client = new DynamoDBClient({ region: process.env.AWS_REGION ?? "eu-central-1" });
  return new KvStoreIdempotencyStore(
    new DynamoKvStore(client, {
      tableName,
      pkPrefix: "idem",
      pkSeparator: "#",
      ttlAttr: "expiresAt",
      versionAttr: "_v",
      allowSeparatorInKey: true,
    }),
  );
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
