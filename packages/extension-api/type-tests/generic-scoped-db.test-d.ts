/**
 * Type-level tests for the generic `ScopedDb` (A.5 remainder).
 *
 * These are checked by `tsc --noEmit -p tsconfig.type-tests.json`, NOT by
 * vitest — a `expectTypeOf` call in a normal test file is a runtime no-op and
 * `apps/api`'s `tsc --build` excludes `test/`, so nothing would actually have
 * compiled these assertions.
 *
 * Every negative case is an `@ts-expect-error`, which is fail-closed in both
 * directions: if the error stops occurring, tsc reports the directive as
 * unused and this file fails to compile. The gate cannot silently pass.
 *
 * Imports go through the PACKAGE NAME rather than `../src/…` so the tests run
 * against the built declarations and the `exports` map — the same path an
 * extension author takes.
 */

import type {
  CoreScopedModels,
  ExtensionContext,
  ExtensionJobContext,
  ScopedDb,
  ScopedDelegate,
  ScopedOf,
  ScopedOperation,
  TenantId,
  TrellisExtension,
} from "@de-otio/trellis-extension-api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compile-time assertion that two types are mutually assignable. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
declare function expectType<T extends true>(): void;

declare const tid: TenantId;

/**
 * A stand-in for a generated Prisma model delegate. The generic `findMany`
 * and the extra non-scoped members (`fields`, `$queryRaw`) are the parts that
 * matter: `ScopedOf` has to preserve the first and drop the second.
 */
interface FakePrismaDelegate {
  findMany<T extends { where?: { breed?: string }; take?: number }>(
    args?: T,
  ): Promise<{ id: string; breed: string }[]>;
  findFirst(args?: { where?: { id?: string } }): Promise<{ id: string; breed: string } | null>;
  findUnique(args: { where: { id: string } }): Promise<{ id: string; breed: string } | null>;
  create(args: { data: { breed: string } }): Promise<{ id: string; breed: string }>;
  createMany(args: { data: { breed: string }[] }): Promise<{ count: number }>;
  update(args: {
    where: { id: string };
    data: { breed?: string };
  }): Promise<{ id: string; breed: string }>;
  updateMany(args: { where?: { breed?: string }; data: { breed?: string } }): Promise<{
    count: number;
  }>;
  upsert(args: {
    where: { id: string };
    create: { breed: string };
    update: { breed?: string };
  }): Promise<{ id: string; breed: string }>;
  delete(args: { where: { id: string } }): Promise<{ id: string; breed: string }>;
  deleteMany(args?: { where?: { breed?: string } }): Promise<{ count: number }>;
  count(args?: { where?: { breed?: string } }): Promise<number>;
  aggregate(args: { _count?: true }): Promise<{ _count?: number }>;
  groupBy(args: { by: "breed"[] }): Promise<{ breed: string }[]>;

  // Not part of the scoped surface — must be dropped by ScopedOf.
  fields: { breed: string };
  $queryRaw(sql: string): Promise<unknown>;
}

type DogModels = {
  extDogProfile: ScopedOf<FakePrismaDelegate>;
};

// ---------------------------------------------------------------------------
// 1. ScopedOperation tracks ScopedDelegate and nothing else
// ---------------------------------------------------------------------------

expectType<
  Equals<
    ScopedOperation,
    | "findMany"
    | "findFirst"
    | "findUnique"
    | "create"
    | "createMany"
    | "update"
    | "updateMany"
    | "upsert"
    | "delete"
    | "deleteMany"
    | "count"
    | "aggregate"
    | "groupBy"
  >
>();

// ---------------------------------------------------------------------------
// 2. ScopedOf keeps the scoped ops (with their real types) and drops the rest
// ---------------------------------------------------------------------------

declare const scopedDog: ScopedOf<FakePrismaDelegate>;

async function scopedOfKeepsRealTypes(): Promise<void> {
  const rows = await scopedDog.findMany({ where: { breed: "collie" }, take: 5 });
  rows[0]!.breed.toUpperCase(); // typed as string, not unknown

  const created = await scopedDog.create({ data: { breed: "collie" } });
  created.id.toUpperCase();

  const n: number = await scopedDog.count({ where: { breed: "collie" } });
  void n;

  // @ts-expect-error — `nope` is not a field of the delegate's where input
  await scopedDog.findMany({ where: { nope: true } });
}

// @ts-expect-error — $queryRaw is not a scoped operation and must be absent
scopedDog.$queryRaw;

// @ts-expect-error — `fields` is not a scoped operation and must be absent
scopedDog.fields;

// ---------------------------------------------------------------------------
// 3. A declared model map types the extension's own models and closes the set
// ---------------------------------------------------------------------------

declare const typedDb: ScopedDb<DogModels>;

async function declaredMapIsTyped(): Promise<void> {
  const rows = await typedDb.extDogProfile.findMany({ where: { breed: "collie" } });
  rows[0]!.breed.toUpperCase();

  // core models are still there
  await typedDb.entity.findMany();
  await typedDb.post.count();
}

// @ts-expect-error — a typo in the model name is now a compile error, which is
// the entire point of declaring the map
typedDb.extDogProfiles;

// ---------------------------------------------------------------------------
// 4. The default surface is unchanged — this whole change is additive
// ---------------------------------------------------------------------------

declare const openDb: ScopedDb;

// any model name still resolves, to the erased delegate
const stillOpen: ScopedDelegate = openDb.whateverCoreRegistersAtRuntime;
void stillOpen;

// the 9 core models are exactly the named half
expectType<
  Equals<
    keyof CoreScopedModels,
    | "entity"
    | "post"
    | "postEntity"
    | "postMedia"
    | "taxonomyTaxon"
    | "taxonomyCategory"
    | "taxonomyDimension"
    | "productTaxonomyTag"
    | "activity"
  >
>();

// ---------------------------------------------------------------------------
// 5. Variance: a typed extension must fit in core's untyped registry
//
// This is the property the whole design rests on. `ExtensionRouteDefinition`
// declares `handle` as a method precisely so that this assignment holds; as a
// function-typed property it is contravariant and this fails, which would make
// declaring a model map impossible for any extension with routes.
// ---------------------------------------------------------------------------

const dogExtension: TrellisExtension<DogModels> = {
  id: "dog",
  terminology: { entity: "dog", entityPlural: "dogs" },
  routes: [],
  metadataSchema: null as never,
  extensionRoutes: [
    {
      path: "/profiles",
      method: "GET",
      async handle(_request, _params, _session, ctx) {
        const rows = await ctx.db.tenant(tid).extDogProfile.findMany({
          where: { breed: "collie" },
        });
        return { status: 200, body: { count: rows.length } };
      },
    },
  ],
  jobs: [
    {
      id: "sweep",
      schedule: "daily",
      crossTenantRead: ["extDogProfile"],
      async run(jobCtx) {
        // the job's tenant() is typed by the same map
        await jobCtx.tenant(tid).extDogProfile.count();
      },
    },
  ],
};

// core holds extensions it cannot type
const coreRegistry: TrellisExtension[] = [dogExtension];

// and core dispatches into them with its own open context
declare const coreCtx: ExtensionContext;
declare const coreJobCtx: ExtensionJobContext;
async function coreDispatches(): Promise<void> {
  for (const ext of coreRegistry) {
    for (const route of ext.extensionRoutes ?? []) {
      await route.handle(new Request("https://example.test"), {}, null, coreCtx);
    }
    for (const job of ext.jobs ?? []) await job.run(coreJobCtx);
  }
}

// ---------------------------------------------------------------------------
// 6. The model-map constraint rejects values that are plainly not delegates
// ---------------------------------------------------------------------------

// @ts-expect-error — a string is not a delegate
type _Bad = ScopedDb<{ extDogProfile: string }>;

// ---------------------------------------------------------------------------
// 7. The constraint rejects an INCOMPLETE delegate, at the declaration
//
// 0.9.1 shipped without this case and it cost a consumer a morning. The
// constraint was `Record<string, object>`, so a hand-written delegate with one
// operation satisfied it here and failed at the extension's registration call
// site in the consumer, with a message naming neither the map nor the fix.
//
// Everything above uses `FakePrismaDelegate`, which is complete by
// construction — which is exactly why the suite could not see this. A contract
// tested only against the shapes its author had in mind tests the author.
// ---------------------------------------------------------------------------

interface DogPrivateRow {
  microchip: string | null;
}

/** What a hand-written map reaches for first: just the operation it uses. */
interface PartialDelegate {
  findUnique(args: unknown): Promise<DogPrivateRow | null>;
}

// @ts-expect-error — an incomplete delegate is missing 12 of the 13 scoped
// operations, so it could never register into core's `OpenScopedModels`
type _Partial = ScopedDb<{ extDogPrivate: PartialDelegate }>;

// @ts-expect-error — and the same rejection reaches the extension type, so the
// author sees it on their own declaration rather than in the consumer
declare const partialExtension: TrellisExtension<{ extDogPrivate: PartialDelegate }>;
void partialExtension;

/**
 * The sanctioned hand-written form: extend the full contract shape, narrow only
 * the operations you actually care about. This is what an extension must write
 * when it cannot import generated Prisma types — e.g. because its client is
 * generated from a composed schema after its own package has already built.
 */
interface CompleteDelegate extends ScopedDelegate {
  findUnique(args: unknown): Promise<DogPrivateRow | null>;
}

type HandWrittenModels = { extDogPrivate: ScopedOf<CompleteDelegate> };

declare const handWrittenDb: ScopedDb<HandWrittenModels>;

async function handWrittenMapIsTyped(): Promise<void> {
  const row = await handWrittenDb.extDogPrivate.findUnique({ where: { id: "x" } });
  // narrowed by the hand-written signature, not `unknown`
  row?.microchip?.toUpperCase();

  // the other twelve operations are present, at the erased contract types
  await handWrittenDb.extDogPrivate.count();
}

// @ts-expect-error — the map still closes the model set for a hand-written map
handWrittenDb.extDogPrivates;

// and it still registers into core's untyped registry — the §5 property, which
// is what the constraint now guarantees up front rather than discovers late
declare const handWrittenExtension: TrellisExtension<HandWrittenModels>;
const handWrittenRegistry: TrellisExtension[] = [handWrittenExtension];

export {
  scopedOfKeepsRealTypes,
  declaredMapIsTyped,
  coreDispatches,
  dogExtension,
  coreRegistry,
  handWrittenMapIsTyped,
  handWrittenRegistry,
};
