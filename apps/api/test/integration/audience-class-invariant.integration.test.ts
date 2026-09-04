/**
 * Integration: `posts.audience_class` is a faithful function of
 * `posts.audience_scopes`, enforced by the database.
 *
 * This is the invariant the audience model's safety rests on. `audience_class`
 * is a denormalised summary that the feed's index selects on, so a stale value
 * is a DISCLOSURE, not a slow query — a post whose scopes say CONNECTIONS but
 * whose class says PUBLIC is returned to strangers by an index scan.
 *
 * It is enforced by a trigger rather than by application code, and these tests
 * are written against the database for the same reason the trigger exists: the
 * write path cannot be trusted to maintain it. `DataRouter.createPost` builds
 * its payload as `Record<string, any>` and casts it `as any`, so TypeScript
 * cannot force a scope change to update the class, and raw SQL, migrations and
 * manual repair bypass application invariants entirely. Only the DB sees them
 * all.
 *
 * The transitional half is tested too: during the migration window a writer
 * that supplies no scopes must still get a correct audience derived from
 * `radius`, because every writer in the codebase omits the column today and the
 * column is NOT NULL. Without that, this "additive" migration breaks post
 * creation outright — which is how it was found.
 *
 * Runs in the setup-free integration-ci lane (real DATABASE_URL, no
 * test/setup.ts).
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENV_DB_URL = process.env.DATABASE_URL;
const TEST_DB_URL =
  ENV_DB_URL !== undefined && !ENV_DB_URL.includes("hyperdrive")
    ? ENV_DB_URL
    : "postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev";

const RUN = `aud-class-${Date.now()}`;
const TENANT = `${RUN}-tenant`;
const AUTHOR = `41111111-2222-4333-8444-${Date.now().toString().slice(-12)}`;

let prisma: PrismaClient;

/** Insert a post with an explicit scope set, bypassing the ORM's typing. */
async function insertWithScopes(id: string, scopes: string, radius = "NORMAL") {
  await prisma.$executeRawUnsafe(
    `INSERT INTO posts (id, tenant_id, author_id, text, radius, audience_scopes, content_warnings, created_at, updated_at)
     VALUES ($1, $2, $3, 'x', $4::"PostRadius", $5::jsonb, '{}', now(), now())`,
    `${RUN}-${id}`,
    TENANT,
    AUTHOR,
    radius,
    scopes,
  );
  return `${RUN}-${id}`;
}

/** Insert exactly the column list the current write path uses — no audience columns. */
async function insertOmittingAudience(id: string, radius: string) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO posts (id, tenant_id, author_id, text, radius, content_warnings, created_at, updated_at)
     VALUES ($1, $2, $3, 'x', $4::"PostRadius", '{}', now(), now())`,
    `${RUN}-${id}`,
    TENANT,
    AUTHOR,
    radius,
  );
  return `${RUN}-${id}`;
}

async function read(id: string) {
  const rows = await prisma.$queryRawUnsafe<
    Array<{ audience_class: string; audience_scopes: unknown }>
  >(`SELECT audience_class, audience_scopes FROM posts WHERE id = $1`, id);
  return rows[0];
}

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DB_URL }),
  });
  await prisma.$connect();
  await prisma.tenant.create({
    data: {
      id: TENANT,
      slug: TENANT,
      displayName: TENANT,
      type: "ORGANIZATION",
    },
  });
  await prisma.user.create({
    data: {
      id: AUTHOR,
      email: `${AUTHOR}@test.example.com`,
      handle: `h-${RUN.slice(-10)}`,
      personalTenantId: `${RUN}-personal`,
      dataRegion: "US",
    },
  });
});

afterAll(async () => {
  await prisma.post.deleteMany({ where: { id: { startsWith: RUN } } });
  await prisma.user.deleteMany({ where: { id: AUTHOR } });
  await prisma.tenant.deleteMany({ where: { id: TENANT } });
  await prisma.$disconnect();
});

describe("audience_class is derived, never authored", () => {
  it("derives the class from the scopes on insert", async () => {
    const cases: Array<[string, string, string]> = [
      ["pub", '[{"k":"PUBLIC"}]', "PUBLIC"],
      ["conn", '[{"k":"CONNECTIONS"}]', "CONNECTIONS"],
      ["self", '[{"k":"SELF"}]', "SELF"],
    ];

    for (const [id, scopes, expected] of cases) {
      const pid = await insertWithScopes(id, scopes);
      expect((await read(pid)).audience_class).toBe(expected);
    }
  });

  it("OVERWRITES a hand-set class that disagrees with the scopes", async () => {
    // The disclosure this invariant prevents: scopes admit only mutual
    // connections, but the class the feed's index reads says PUBLIC.
    await prisma.$executeRawUnsafe(
      `INSERT INTO posts (id, tenant_id, author_id, text, radius, audience_scopes, audience_class, content_warnings, created_at, updated_at)
       VALUES ($1, $2, $3, 'x', 'WHISPER', '[{"k":"CONNECTIONS"}]'::jsonb, 'PUBLIC'::"AudienceClass", '{}', now(), now())`,
      `${RUN}-lie`,
      TENANT,
      AUTHOR,
    );

    expect((await read(`${RUN}-lie`)).audience_class).toBe("CONNECTIONS");
  });

  it("recomputes the class when the scopes change", async () => {
    const pid = await insertWithScopes("mut", '[{"k":"SELF"}]');

    await prisma.$executeRawUnsafe(
      `UPDATE posts SET audience_scopes = '[{"k":"PUBLIC"}]'::jsonb WHERE id = $1`,
      pid,
    );
    expect((await read(pid)).audience_class).toBe("PUBLIC");

    // Narrowing must be honoured too, not just widening.
    await prisma.$executeRawUnsafe(
      `UPDATE posts SET audience_scopes = '[{"k":"SELF"}]'::jsonb WHERE id = $1`,
      pid,
    );
    expect((await read(pid)).audience_class).toBe("SELF");
  });

  it("re-derives the class when only the class is updated", async () => {
    const pid = await insertWithScopes("classonly", '[{"k":"PUBLIC"}]');

    await prisma.$executeRawUnsafe(
      `UPDATE posts SET audience_class = 'SELF'::"AudienceClass" WHERE id = $1`,
      pid,
    );

    // Writing the cache directly cannot desynchronise it from its source.
    expect((await read(pid)).audience_class).toBe("PUBLIC");
  });

  it("fails CLOSED for scope sets it does not recognise", async () => {
    // Includes the scope kinds this build deliberately does not support
    // (CONTAINER, TENANT). They must not resolve to anything permissive, so
    // that a future half-wiring cannot silently widen historical rows.
    // NB: `[]` is deliberately NOT in this list. It is the omission sentinel —
    // the Prisma default when a writer leaves the field out — so it means "not
    // specified" and is handled by the transitional branch below. Everything
    // here is a value that is PRESENT and malformed, which is a bug rather than
    // an omission and must never be reinterpreted from the radius.
    const closed: Array<[string, string]> = [
      ["container", '[{"k":"CONTAINER","id":"g1"}]'],
      ["tenantscope", '[{"k":"TENANT"}]'],
      ["garbage", '[{"nope":1}]'],
      ["object", '{"k":"PUBLIC"}'],
      ["string", '"PUBLIC"'],
    ];

    for (const [id, scopes] of closed) {
      const pid = await insertWithScopes(id, scopes, "SHOUT");
      expect((await read(pid)).audience_class).toBe("SELF");
    }
  });

  it("matches a known scope kind even with extra keys present", async () => {
    // Scopes gain parameters later (a list id); containment must not become
    // brittle when they do.
    const pid = await insertWithScopes("extra", '[{"k":"PUBLIC","note":"x"}]');
    expect((await read(pid)).audience_class).toBe("PUBLIC");
  });

  it("takes the WIDEST scope when several are present, since scopes are OR'd", async () => {
    const pid = await insertWithScopes(
      "widest",
      '[{"k":"SELF"},{"k":"PUBLIC"}]',
    );
    expect((await read(pid)).audience_class).toBe("PUBLIC");
  });
});

describe("transitional: a writer that supplies no scopes still gets an audience", () => {
  // Every writer in the codebase omits these columns today, and the column is
  // NOT NULL — so without this the migration breaks post creation rather than
  // being additive.
  it.each([
    ["SHOUT", "PUBLIC"],
    ["LOUD", "CONNECTIONS"],
    ["NORMAL", "CONNECTIONS"],
    ["WHISPER", "SELF"],
  ])("radius %s derives class %s", async (radius, expected) => {
    const pid = await insertOmittingAudience(`omit-${radius}`, radius);
    expect((await read(pid)).audience_class).toBe(expected);
  });

  it("maps LOUD to CONNECTIONS, never PUBLIC", async () => {
    // The one mapping worth pinning explicitly. ActivityPub addressing used to
    // treat LOUD as fully public via a fail-open default, while no local read
    // path ever admitted a LOUD post to anyone but its author. The migration
    // takes the narrower reading, because a backfill that widens historical
    // content is a disclosure no later fix can recall.
    const pid = await insertOmittingAudience("loud-check", "LOUD");
    const row = await read(pid);

    expect(row.audience_class).toBe("CONNECTIONS");
    expect(JSON.stringify(row.audience_scopes)).not.toContain("PUBLIC");
  });

  it("does not let an explicit audience be overridden by the radius", async () => {
    const pid = await insertWithScopes("explicit", '[{"k":"SELF"}]', "SHOUT");
    expect((await read(pid)).audience_class).toBe("SELF");
  });

  it("treats an empty scope array as omission, not as a malformed value", async () => {
    // `[]` is what Prisma sends when a caller omits the field, so it is the
    // omission sentinel and derives from the radius. This is the pair to the
    // fail-closed cases above: present-but-malformed narrows to SELF, absent
    // translates faithfully. Both branches disappear when the write path always
    // supplies scopes, at which point `[]` should fail closed like the rest.
    const pid = await insertWithScopes("emptyarr", "[]", "SHOUT");
    expect((await read(pid)).audience_class).toBe("PUBLIC");
  });
});
