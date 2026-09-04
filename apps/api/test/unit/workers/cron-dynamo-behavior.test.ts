/**
 * T2 behavior test (WS-2 §3.4 "AWS parity"):
 * `DynamoKvStore.putIfAbsent(..., { overwriteExpired: true })` must yield the
 * SAME acquire/skip OUTCOME as the old inline
 * `attribute_not_exists(pk) OR #ttl < :now` conditional PutItem, on the same
 * sequence of (fresh / held / expired) lock states.
 *
 * Per WS-1's best-practice note this asserts OUTCOME equivalence, not literal
 * command-string identity. Both implementations run against the same
 * in-memory fake DynamoDB (conditional-put semantics faithfully implemented),
 * driven through identical state sequences with a shared controllable clock.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  GetItemCommand,
  PutItemCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { DynamoKvStore } from "@de-otio/saas-foundation/kv";
import { makeKvCronLock } from "../../../src/lib/workers/cron-lock.js";

// ---------------------------------------------------------------------------
// Minimal in-memory DynamoDB fake: single table, pk+sk, conditional PutItem.
// ---------------------------------------------------------------------------

class ConditionalCheckFailedException extends Error {
  constructor() {
    super("The conditional request failed");
    this.name = "ConditionalCheckFailedException";
  }
}

class FakeDynamo {
  private readonly items = new Map<string, Record<string, unknown>>();

  private keyOf(item: Record<string, unknown>): string {
    return `${String(item.pk)}|${String(item.sk ?? "")}`;
  }

  private resolveName(raw: string, names?: Record<string, string>): string {
    return raw.startsWith("#") ? (names ?? {})[raw] ?? raw : raw;
  }

  /** Supports exactly the three condition shapes under test. */
  private evaluate(
    expression: string,
    existing: Record<string, unknown> | undefined,
    names: Record<string, string> | undefined,
    values: Record<string, unknown>,
  ): boolean {
    // "attribute_not_exists(pk)" / "attribute_not_exists(#pk)"
    const notExists = expression.match(/^attribute_not_exists\(([^)]+)\)$/);
    if (notExists) {
      return existing === undefined;
    }
    // "attribute_not_exists(pk) OR #ttl < :now"  (the OLD inline lock)
    const orExpired = expression.match(
      /^attribute_not_exists\(([^)]+)\) OR (#?\w+) < (:\w+)$/,
    );
    if (orExpired) {
      if (existing === undefined) return true;
      const attr = this.resolveName(orExpired[2], names);
      const bound = values[orExpired[3]];
      return typeof existing[attr] === "number" && (existing[attr] as number) < Number(bound);
    }
    // "#v = :pv" (the takeover version guard)
    const versionEq = expression.match(/^(#?\w+) = (:\w+)$/);
    if (versionEq) {
      if (existing === undefined) return false;
      const attr = this.resolveName(versionEq[1], names);
      return Number(existing[attr] ?? 0) === Number(values[versionEq[2]]);
    }
    throw new Error(`FakeDynamo: unsupported condition: ${expression}`);
  }

  async send(cmd: unknown): Promise<unknown> {
    if (cmd instanceof PutItemCommand) {
      const input = cmd.input;
      const item = unmarshall(input.Item as never);
      const key = this.keyOf(item);
      const existing = this.items.get(key);
      if (input.ConditionExpression !== undefined) {
        const values =
          input.ExpressionAttributeValues === undefined
            ? {}
            : unmarshall(input.ExpressionAttributeValues as never);
        const ok = this.evaluate(
          input.ConditionExpression,
          existing,
          input.ExpressionAttributeNames,
          values,
        );
        if (!ok) throw new ConditionalCheckFailedException();
      }
      this.items.set(key, item);
      return {};
    }
    if (cmd instanceof GetItemCommand) {
      const input = cmd.input;
      const key = unmarshall(input.Key as never);
      const item = this.items.get(this.keyOf(key));
      return item === undefined ? {} : { Item: marshall(item) };
    }
    throw new Error(`FakeDynamo: unsupported command ${String((cmd as object).constructor.name)}`);
  }
}

// ---------------------------------------------------------------------------
// The OLD inline acquire (verbatim semantics from the pre-WS-2 handlers).
// ---------------------------------------------------------------------------

async function oldInlineAcquire(
  client: { send(cmd: unknown): Promise<unknown> },
  name: string,
  ttlWindowSeconds: number,
  nowSeconds: number,
): Promise<boolean> {
  try {
    await client.send(
      new PutItemCommand({
        TableName: "test-table",
        Item: marshall({
          pk: `cron:${name}`,
          sk: "lock",
          ttl: nowSeconds + ttlWindowSeconds,
          lockedAt: nowSeconds,
        }),
        ConditionExpression: "attribute_not_exists(pk) OR #ttl < :now",
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: marshall({ ":now": nowSeconds }),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

const CRON_LAYOUT = {
  tableName: "test-table",
  pkPrefix: "cron",
  pkSeparator: ":" as const,
  skName: "sk",
  skValue: "lock",
  ttlAttr: "ttl",
  versionAttr: "_v",
};

describe("DynamoKvStore cron-lock outcome equivalence (T2 behavior gate)", () => {
  let now: number; // epoch ms, shared by both implementations

  beforeEach(() => {
    now = 1_700_000_000_000;
  });

  /** Drive both implementations through the same acquire sequence. */
  async function outcomesFor(
    steps: Array<{ advanceMs: number }>,
    ttlSeconds: number,
  ): Promise<{ oldOutcomes: boolean[]; newOutcomes: boolean[] }> {
    // OLD path — its own fake table.
    const oldFake = new FakeDynamo();
    // NEW path — its own fake table, DynamoKvStore + CronLock on the frozen port.
    const newFake = new FakeDynamo();
    const store = new DynamoKvStore(
      newFake as unknown as DynamoDBClient,
      CRON_LAYOUT,
      { now: () => now },
    );

    const oldOutcomes: boolean[] = [];
    const newOutcomes: boolean[] = [];
    for (const step of steps) {
      now += step.advanceMs;
      const nowSec = Math.floor(now / 1000);
      oldOutcomes.push(await oldInlineAcquire(oldFake, "nightly", ttlSeconds, nowSec));
      // Fresh owner per fire = a distinct Lambda invocation, like today.
      const lock = makeKvCronLock(store, { owner: `owner-${nowSec}`, clock: () => now });
      newOutcomes.push(await lock.acquire("nightly", ttlSeconds));
    }
    return { oldOutcomes, newOutcomes };
  }

  it("FRESH state: both acquire", async () => {
    const { oldOutcomes, newOutcomes } = await outcomesFor([{ advanceMs: 0 }], 3600);
    expect(oldOutcomes).toEqual([true]);
    expect(newOutcomes).toEqual(oldOutcomes);
  });

  it("HELD state: both skip a second fire inside the TTL window", async () => {
    const { oldOutcomes, newOutcomes } = await outcomesFor(
      [{ advanceMs: 0 }, { advanceMs: 60_000 }],
      3600,
    );
    expect(oldOutcomes).toEqual([true, false]);
    expect(newOutcomes).toEqual(oldOutcomes);
  });

  it("EXPIRED state: both take over after the TTL elapses", async () => {
    const { oldOutcomes, newOutcomes } = await outcomesFor(
      [{ advanceMs: 0 }, { advanceMs: 3_601_000 }],
      3600,
    );
    expect(oldOutcomes).toEqual([true, true]);
    expect(newOutcomes).toEqual(oldOutcomes);
  });

  it("full lifecycle sequence: fresh → held → expired-takeover → held", async () => {
    const { oldOutcomes, newOutcomes } = await outcomesFor(
      [
        { advanceMs: 0 }, // fresh: acquire
        { advanceMs: 100_000 }, // held: skip
        { advanceMs: 200_000 }, // still held: skip
        { advanceMs: 3_600_000 }, // long past expiry: takeover
        { advanceMs: 1_000 }, // freshly held again: skip
      ],
      3600,
    );
    expect(oldOutcomes).toEqual([true, false, false, true, false]);
    expect(newOutcomes).toEqual(oldOutcomes);
  });

  it("short-TTL cron (cleanup, 300s): every 5-minute fire re-acquires, like today", async () => {
    const { oldOutcomes, newOutcomes } = await outcomesFor(
      [
        { advanceMs: 0 },
        { advanceMs: 301_000 },
        { advanceMs: 301_000 },
      ],
      300,
    );
    expect(oldOutcomes).toEqual([true, true, true]);
    expect(newOutcomes).toEqual(oldOutcomes);
  });
});
