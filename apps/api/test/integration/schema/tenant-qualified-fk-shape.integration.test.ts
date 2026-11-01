/**
 * Schema-shape tests for the tenant-qualified foreign keys.
 *
 * A child row that carries its own `tenant_id` references its parent by
 * `(tenant_id, <col>) -> parent(tenant_id, id)`, so the database itself proves
 * the parent belongs to the child's tenant. That holds for every client
 * (extended or not, raw SQL included) and whether or not row security is
 * armed: Postgres runs FK checks without row security, so a single-column FK
 * would accept a parent from any tenant.
 *
 * 1. Coverage, from the catalog: every FK between two tables that both hold
 *    `tenant_id` (parent other than `tenants`) leads with `tenant_id` on both
 *    sides and is ON UPDATE NO ACTION. A new FK that skips the tenant fails
 *    here, and so does a SET NULL FK that would null tenant_id too.
 * 2. Behaviour, on one relation (event_shifts -> events): cross-tenant inserts
 *    are refused through Prisma and through raw SQL, same-tenant inserts work,
 *    and a parent's tenant_id cannot change while it has children.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEntityCreateData } from "../../../src/lib/entity-create-data.js";
import { TEST_DB_URL } from "./_schema-helpers.js";

/**
 * The tenant-qualified FKs that are ON DELETE SET NULL, keyed `child.column`.
 * Each must null only its pointer column: `SET NULL ("<col>")`. A plain
 * composite SET NULL would null tenant_id as well, so deleting the parent
 * would fail on NOT NULL. Prisma cannot express the column list and its diff
 * ignores it, so this list is what notices a regenerated FK.
 */
const SET_NULL_COLUMN: ReadonlySet<string> = new Set([
  "connection_codes.entity_id",
  "events.announce_post_id",
  "events.group_id",
  "posts.group_id",
  "posts.primary_entity_id",
  "taxonomy_taxons.parent_taxon_id",
]);

interface FkRow {
  conname: string;
  child: string;
  parent: string;
  child_cols: string[];
  parent_cols: string[];
  upd: string;
  child_tenant_not_null: boolean;
}

const RUN = `tqfk-${Date.now()}`;
const TENANT_A = `${RUN}-a`;
const TENANT_B = `${RUN}-b`;
const USER_TENANT = `${RUN}-pt`;
const USER = `${RUN}-user`;

let prisma: PrismaClient;

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DB_URL }),
  });
  await prisma.$connect();
  for (const id of [TENANT_A, TENANT_B]) {
    await prisma.tenant.create({
      data: { id, slug: id, displayName: id, type: "ORGANIZATION" },
    });
  }
  await prisma.tenant.create({
    data: { id: USER_TENANT, slug: USER_TENANT, displayName: USER_TENANT, type: "PERSONAL" },
  });
  await prisma.user.create({
    data: {
      id: USER,
      email: `${USER}@test.example.com`,
      handle: `h-${RUN.slice(-10)}`,
      personalTenantId: USER_TENANT,
      dataRegion: "US",
    },
  });
});

afterAll(async () => {
  // Deleting the tenants cascades to their events, shifts, entities and
  // ownerships; the user goes after its ownership rows.
  await prisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.tenant.deleteMany({ where: { id: USER_TENANT } });
  await prisma.$disconnect();
});

async function tenantHoldingFks(): Promise<FkRow[]> {
  // confupdtype is Postgres's internal "char" type, which the pg driver
  // adapter cannot deserialize: cast to text.
  return prisma.$queryRawUnsafe<FkRow[]>(
    `SELECT c.conname,
            ch.relname AS child,
            pa.relname AS parent,
            ARRAY(SELECT a.attname::text
                    FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                   ORDER BY k.ord) AS child_cols,
            ARRAY(SELECT a.attname::text
                    FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
                   ORDER BY k.ord) AS parent_cols,
            c.confupdtype::text AS upd,
            (SELECT attnotnull FROM pg_attribute
              WHERE attrelid = c.conrelid AND attname = 'tenant_id') AS child_tenant_not_null
       FROM pg_constraint c
       JOIN pg_class ch ON ch.oid = c.conrelid
       JOIN pg_class pa ON pa.oid = c.confrelid
       JOIN pg_namespace n ON n.oid = ch.relnamespace
      WHERE c.contype = 'f'
        AND n.nspname = 'public'
        AND pa.relname <> 'tenants'
        AND EXISTS (SELECT 1 FROM pg_attribute
                     WHERE attrelid = c.conrelid AND attname = 'tenant_id' AND NOT attisdropped)
        AND EXISTS (SELECT 1 FROM pg_attribute
                     WHERE attrelid = c.confrelid AND attname = 'tenant_id' AND NOT attisdropped)`,
  );
}

const isQualified = (fk: FkRow) =>
  fk.child_cols[0] === "tenant_id" && fk.parent_cols[0] === "tenant_id" && fk.upd === "a";

/** The child column the FK is about: the one that is not tenant_id. */
const keyOf = (fk: FkRow) =>
  `${fk.child}.${fk.child_cols.find((c) => c !== "tenant_id") ?? fk.child_cols[0]}`;

describe("tenant-qualified foreign keys: coverage", () => {
  it("finds the relations it is meant to check", async () => {
    // Guards the query itself: an empty result would make the next test pass
    // vacuously.
    const fks = await tenantHoldingFks();
    expect(fks.filter(isQualified).length).toBeGreaterThanOrEqual(25);
  });

  it("every FK between tenant-holding tables leads with tenant_id and is ON UPDATE NO ACTION", async () => {
    const unqualified = (await tenantHoldingFks())
      .filter((fk) => !isQualified(fk))
      .map(keyOf)
      .sort();
    expect(unqualified).toEqual([]);
  });

  it("every ON DELETE SET NULL FK nulls only its pointer column, never tenant_id", async () => {
    // confdeltype/confdelsetcols: see tenantHoldingFks on the "char" cast.
    const rows = await prisma.$queryRawUnsafe<{ key: string; set_cols: string[] }[]>(
      `SELECT ch.relname || '.' || a.attname AS key,
              ARRAY(SELECT s.attname::text
                      FROM unnest(c.confdelsetcols) k(attnum)
                      JOIN pg_attribute s ON s.attrelid = c.conrelid AND s.attnum = k.attnum) AS set_cols
         FROM pg_constraint c
         JOIN pg_class ch ON ch.oid = c.conrelid
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[2]
        WHERE c.contype = 'f'
          AND c.confdeltype::text = 'n'
          AND array_length(c.conkey, 1) = 2
          AND c.conkey[1] = (SELECT attnum FROM pg_attribute
                              WHERE attrelid = c.conrelid AND attname = 'tenant_id')`,
    );
    expect(rows.map((r) => r.key).sort()).toEqual([...SET_NULL_COLUMN].sort());
    for (const r of rows) {
      expect(r.set_cols, r.key).toEqual([r.key.split(".")[1]]);
    }
  });

  it("every tenant-qualified FK pairs tenant_id with tenant_id", async () => {
    const fks = (await tenantHoldingFks()).filter(isQualified);
    for (const fk of fks) {
      expect(fk.child_cols, fk.conname).toHaveLength(2);
      expect(fk.parent_cols, fk.conname).toEqual(["tenant_id", "id"]);
      // Under MATCH SIMPLE a NULL tenant_id would skip the check entirely.
      expect(fk.child_tenant_not_null, fk.conname).toBe(true);
    }
  });
});

describe("tenant-qualified foreign keys: behaviour (event_shifts -> events)", () => {
  const eventIn = (tenantId: string, n: number) =>
    prisma.event.create({
      data: {
        id: `${RUN}-ev-${n}`,
        tenantId,
        creatorId: `${RUN}-creator`,
        title: "fixture",
        startsAt: new Date("2030-01-01T10:00:00Z"),
      },
    });

  it("accepts a child in its parent's tenant", async () => {
    const event = await eventIn(TENANT_A, 1);
    const shift = await prisma.eventShift.create({
      data: { id: `${RUN}-sh-1`, tenantId: TENANT_A, eventId: event.id, title: "s", capacity: 1 },
    });
    expect(shift.tenantId).toBe(TENANT_A);
  });

  it("refuses, through Prisma, a child whose parent is in another tenant", async () => {
    const event = await eventIn(TENANT_A, 2);
    await expect(
      prisma.eventShift.create({
        data: { id: `${RUN}-sh-2`, tenantId: TENANT_B, eventId: event.id, title: "s", capacity: 1 },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    expect(await prisma.eventShift.count({ where: { id: `${RUN}-sh-2` } })).toBe(0);
  });

  it("refuses, through raw SQL, a child whose parent is in another tenant", async () => {
    const event = await eventIn(TENANT_A, 3);
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO event_shifts (id, tenant_id, event_id, title, capacity, updated_at)
         VALUES ($1, $2, $3, 's', 1, now())`,
        `${RUN}-sh-3`,
        TENANT_B,
        event.id,
      ),
    ).rejects.toThrow(/event_shifts_tenant_id_event_id_fkey/);
  });

  it("refuses moving a child to another tenant", async () => {
    const event = await eventIn(TENANT_A, 4);
    await prisma.eventShift.create({
      data: { id: `${RUN}-sh-4`, tenantId: TENANT_A, eventId: event.id, title: "s", capacity: 1 },
    });
    await expect(
      prisma.eventShift.update({ where: { id: `${RUN}-sh-4` }, data: { tenantId: TENANT_B } }),
    ).rejects.toThrow(/tenant_id of a row in event_shifts cannot change/);
  });

  it("refuses changing a parent's tenant_id while it has children", async () => {
    // The tenant_id trigger refuses before the FK runs; the FK's own ON UPDATE
    // NO ACTION is pinned by the catalog test above.
    const event = await eventIn(TENANT_A, 5);
    await prisma.eventShift.create({
      data: { id: `${RUN}-sh-5`, tenantId: TENANT_A, eventId: event.id, title: "s", capacity: 1 },
    });
    await expect(
      prisma.event.update({ where: { id: event.id }, data: { tenantId: TENANT_B } }),
    ).rejects.toThrow(/tenant_id of a row in events cannot change/);
    const shift = await prisma.eventShift.findUniqueOrThrow({ where: { id: `${RUN}-sh-5` } });
    expect(shift.tenantId).toBe(TENANT_A);
  });

  it("still cascades a parent delete to its children", async () => {
    const event = await eventIn(TENANT_A, 6);
    await prisma.eventShift.create({
      data: { id: `${RUN}-sh-6`, tenantId: TENANT_A, eventId: event.id, title: "s", capacity: 1 },
    });
    await prisma.event.delete({ where: { id: event.id } });
    expect(await prisma.eventShift.count({ where: { id: `${RUN}-sh-6` } })).toBe(0);
  });
});

describe("tenant-qualified foreign keys: nested child creates", () => {
  // The nested create's parent supplies the tenant. Runs the payload
  // EntityHandler.createEntityProfile sends, so a nested `tenantId` (which
  // Prisma now rejects at runtime) fails here and not only in production.
  it("creates an entity with its owner row, in the entity's tenant", async () => {
    const entity = await prisma.entity.create({
      data: buildEntityCreateData({
        name: " Rex ",
        entityType: "dog",
        tenantId: TENANT_A,
        metadata: {},
        creatorUserId: USER,
        lifeStage: { value: "life-stage:adult", manualOverride: false },
      }),
      include: { owners: true },
    });
    expect(entity.name).toBe("Rex");
    expect(entity.owners).toHaveLength(1);
    expect(entity.owners[0]).toMatchObject({
      tenantId: TENANT_A,
      userId: USER,
      role: "PRIMARY_OWNER",
    });
  });
});

describe("tenant-qualified foreign keys: ON DELETE SET NULL (events.group_id -> groups)", () => {
  const groupIn = (tenantId: string, n: number) =>
    prisma.group.create({
      data: {
        id: `${RUN}-gr-${n}`,
        tenantId,
        name: "fixture",
        actorUri: `https://example.com/groups/${RUN}-${n}`,
        inboxUrl: "https://example.com/inbox",
        outboxUrl: "https://example.com/outbox",
        followersUrl: "https://example.com/followers",
        publicKey: "fixture",
        privateKey: "fixture",
        privacy: "PUBLIC",
      },
    });
  const eventFor = (tenantId: string, groupId: string, n: number) =>
    prisma.event.create({
      data: {
        id: `${RUN}-gev-${n}`,
        tenantId,
        groupId,
        creatorId: `${RUN}-creator`,
        title: "fixture",
        startsAt: new Date("2030-01-01T10:00:00Z"),
      },
    });

  it("refuses an event that points at another tenant's group", async () => {
    const group = await groupIn(TENANT_A, 1);
    await expect(eventFor(TENANT_B, group.id, 1)).rejects.toMatchObject({ code: "P2003" });
  });

  it("deleting the group nulls only group_id; the event keeps its tenant", async () => {
    const group = await groupIn(TENANT_A, 2);
    const event = await eventFor(TENANT_A, group.id, 2);
    await prisma.group.delete({ where: { id: group.id } });
    const after = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
    expect(after.groupId).toBeNull();
    expect(after.tenantId).toBe(TENANT_A);
  });
});
