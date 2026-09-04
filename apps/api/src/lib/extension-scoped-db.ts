/**
 * Extension scoped-DB proxy (O-1 design §5.1 / §12.3 — the L1 deliverable).
 *
 * The **only** data surface an extension ever touches: `ExtensionDb.tenant(tid)`
 * returns a {@link ScopedDb} whose every operation is tenant-bound **by
 * construction**. Unlike core's `tenant-scope.ts` `$extends` layer (which is
 * `"off"` by default and explicitly punts by-id / raw-SQL / nested-write paths to
 * a non-existent "RLS backstop", `tenant-scope.ts:9,27-33,311-313`), this proxy
 * is **ENFORCE-ALWAYS** — independent of the global `TENANT_SCOPE_MODE` flag —
 * because an extension-owned (`ext_*`) table always holds tenant data and must
 * never depend on a core rollout toggle being flipped (design §12.1).
 *
 * Functional core / imperative shell:
 *  - {@link planScopedOp} is a **pure function** (mirroring `planTenantScope`):
 *    given a model's metadata, an operation, its args, and the bound tenant, it
 *    returns a {@link ScopedOpPlan} describing the rewrite — no I/O, no Prisma
 *    types.
 *  - {@link createScopedDb} is the thin imperative shell: it runs the plan's
 *    read-before-write FK checks, dispatches to the raw delegate, and asserts
 *    the affected-count on the by-id rewrites.
 *
 * What the proxy guarantees (design §12.3 H2 + the L1 review fixes):
 *  (a) injects `tenantField = tid` into `where` on where-mergeable ops and stamps
 *      it onto `data` for `create`/`createMany`;
 *  (b) rewrites by-id ops the core layer cannot scope —
 *      `findUnique → findFirst`, `update → updateMany + assert count === 1`,
 *      `delete → capture + deleteMany + assert count === 1` — so a cross-tenant
 *      id is a `null` read or a 0-count NotFound, never a silent cross-tenant
 *      write;
 *  (c) validates FK-target tenant ownership on `create`/`update`/`upsert`
 *      (read-before-write `findFirst({ id: fk, tenantField: tid })` → `null`
 *      fails the op) for every declared FK field;
 *  (d) rejects cross-model **nested writes** (`connect`/`create`/`connectOrCreate`
 *      … in `data`) by throwing (design Q10 — v1 models are shallow);
 *  (e) guards `include`/`select` of relations to models outside the scoped
 *      surface (a relation join is not tenant-filtered and could leak another
 *      tenant's rows) by throwing.
 *
 * `queryRaw`/`executeRaw` are structurally absent from {@link ScopedDb}.
 */

import type {
  ScopedDb,
  ScopedDelegate,
  TenantId,
} from "@de-otio/trellis-extension-api";
import {
  getExtensionModelRegistry,
  type ExtensionModelRegistryEntry,
} from "./extension-model-registry.js";

// ---------------------------------------------------------------------------
// Model metadata — what the proxy needs to know about a scoped model
// ---------------------------------------------------------------------------

/**
 * A scalar FK column that references a tenant-owned model. On write ops the
 * proxy reads the target filtered by `{ id: <fk>, targetTenantField: <tid> }`;
 * a `null` target (a row NOT owned by the bound tenant) fails the op — closing
 * the plain-scalar-FK cross-tenant hole (design §1 L1(i), review Sec-1).
 */
export interface ScopedFkField {
  /** The scalar FK column on THIS model, e.g. `"entityId"`. */
  readonly field: string;
  /** The referenced model's Prisma delegate key (camelCase), e.g. `"entity"`. */
  readonly targetModel: string;
  /** The tenant column on the TARGET model (conventionally `"tenantId"`). */
  readonly targetTenantField: string;
}

/** Everything the scoped proxy needs to enforce isolation for one model. */
export interface ScopedModelMeta {
  /** Prisma delegate key (camelCase), e.g. `"dogReminder"` / `"entity"`. */
  readonly model: string;
  /** The mandatory tenant column injected on every op, e.g. `"tenantId"`. */
  readonly tenantField: string;
  /**
   * FK scalar fields whose target ownership is validated on create/update/upsert
   * (the declared `entityField` plus any FK-to-core-allowlist scalars). Empty for
   * the core delegates (core-model FK integrity is core's concern, §12.1).
   */
  readonly fkFields: readonly ScopedFkField[];
  /**
   * Scalar `Json` columns, skipped by the nested-write and FK scans so a JSON
   * blob that happens to contain a key like `connect` is not misread as a nested
   * relation write. Defaults to none.
   */
  readonly jsonFields: readonly string[];
  /**
   * Columns an extension may **never write**, on any operation.
   *
   * REQUIRED, not optional, on purpose: a new entry in
   * {@link CORE_SCOPED_DELEGATE_META} must state its protected set explicitly, and
   * "I forgot" must be a compile error rather than a silently unprotected model.
   * Use `[]` to mean "nothing protected" — that is a decision, and it should read
   * like one.
   *
   * The AI Act Art. 50 provenance columns are the founding members (see
   * {@link PROVENANCE_PROTECTED_FIELDS}). An extension is precisely where a
   * vertical adds a generation feature, and `post`/`postMedia` are on this scoped
   * surface with `create`/`update`/`updateMany`/`upsert` all permitted — so
   * without this the extension-review criterion ("must not write provenance
   * fields directly, suppress an existing value, or downgrade one") was
   * honour-system, enforceable only by a human reading a diff. Monotonicity lives
   * in the core handlers, which an extension bypasses entirely by going through
   * this surface.
   */
  readonly protectedFields: readonly string[];
}

/**
 * The synthetic-content provenance columns (AI Act Art. 50). Off-limits to
 * extensions on every model that carries them.
 *
 * WHY A TOTAL BAN rather than "may raise, may not lower": the planner is a pure
 * function with no database access, so it cannot compare a proposed value against
 * the stored one — a monotonicity check is not expressible here. And a total ban
 * is what the criterion actually wants: provenance must be set through the
 * sanctioned core path, which mints `basis` server-side. An extension that could
 * write `basis` could forge `PLATFORM_GENERATED`, our own strongest attestation,
 * which is the same forgery the request schemas' `.strict()` exists to prevent.
 *
 * An extension that legitimately generates content sets provenance by calling the
 * core post/comment API, not by writing the column.
 */
export const PROVENANCE_PROTECTED_FIELDS: readonly string[] = [
  // Post
  "textSourceType",
  "textBasis",
  // PostMedia
  "declaredSourceType",
  "declaredBasis",
  // MediaFile (not on the scoped surface today; listed so that adding it there
  // does not silently expose the intrinsic reading to extension writes).
  "embeddedSourceType",
  "provenanceExamined",
];

// ---------------------------------------------------------------------------
// Core-delegate metadata + FK allowlist
// ---------------------------------------------------------------------------

/**
 * The core Prisma models exposed on the scoped surface that carry their OWN
 * `tenantId` column (verified against `prisma/schema.prisma`). Every op on these
 * is tenant-scoped by column injection, exactly like an `ext_*` model.
 *
 * Deliberately EXCLUDES two of the historical delegate-bag entries:
 *  - `activity` — the ActivityPub `activities` table is global/federation and
 *    carries no `tenantId` (schema-verified); it cannot be column-scoped.
 *  - `postEntity` — no such Prisma model exists (the old bag exposed an
 *    `undefined` delegate).
 * Both are therefore **blocked** on the scoped surface (fail-closed — see
 * {@link createScopedDb}); an extension needing that data uses `graphService`
 * or a tenant-carrying model. (ASSUMPTIONS A-L1.1.)
 */
export const CORE_SCOPED_DELEGATE_META: readonly ScopedModelMeta[] = [
  {
    model: "entity",
    tenantField: "tenantId",
    fkFields: [],
    jsonFields: [],
    protectedFields: [],
  },
  {
    model: "post",
    tenantField: "tenantId",
    fkFields: [],
    jsonFields: [],
    // Art. 50: an extension must not write, suppress or downgrade provenance.
    protectedFields: PROVENANCE_PROTECTED_FIELDS,
  },
  {
    model: "postMedia",
    tenantField: "tenantId",
    fkFields: [],
    jsonFields: [],
    protectedFields: PROVENANCE_PROTECTED_FIELDS,
  },
  {
    model: "taxonomyTaxon",
    tenantField: "tenantId",
    fkFields: [],
    jsonFields: [],
    protectedFields: [],
  },
  {
    model: "taxonomyCategory",
    tenantField: "tenantId",
    fkFields: [],
    jsonFields: [],
    protectedFields: [],
  },
  {
    model: "taxonomyDimension",
    tenantField: "tenantId",
    fkFields: [],
    jsonFields: [],
    protectedFields: [],
  },
  {
    model: "productTaxonomyTag",
    tenantField: "tenantId",
    fkFields: [],
    jsonFields: [],
    protectedFields: [],
  },
];

/**
 * Core models an extension FK may name as a **tenant-check** target (design
 * §12.4 item 3 — kept a small explicit set here; L2's composer derives the full
 * allowlist from the composed core schema). `user` is intentionally absent:
 * a FK to `User` is a per-SUBJECT (GDPR) linkage, not a per-tenant one, and is
 * handled by L4's erasure flow, not by this proxy's tenant check.
 */
export const CORE_FK_ALLOWLIST: ReadonlySet<string> = new Set(["entity", "tenant"]);

// ---------------------------------------------------------------------------
// Pure planner — the functional core
// ---------------------------------------------------------------------------

/** Ops whose `where` can safely have `{ tenantField: tid }` AND-merged in. */
export const WHERE_MERGEABLE_OPS: ReadonlySet<string> = new Set([
  "findFirst",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "deleteMany",
]);

/**
 * Relation-write operators that mark a **nested write** when they appear as keys
 * of an object-valued `data` field. Deliberately excludes the scalar-update
 * operators (`set`/`increment`/`decrement`/`multiply`/`divide`/`push`) so a
 * legitimate `{ count: { increment: 1 } }` is not misread as a relation write.
 */
export const NESTED_WRITE_KEYS: ReadonlySet<string> = new Set([
  "connect",
  "connectOrCreate",
  "create",
  "createMany",
  "disconnect",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
]);

/** A read-before-write FK ownership check the shell must run before the op. */
export interface FkCheck {
  readonly targetModel: string;
  readonly where: Record<string, unknown>;
}

/** The pure decision for one scoped op; the shell maps it onto the raw delegate. */
export type ScopedOpPlan =
  | { readonly kind: "reject"; readonly message: string }
  | {
      readonly kind: "call";
      readonly operation: string;
      readonly args: Record<string, unknown>;
      readonly fkChecks: readonly FkCheck[];
    }
  | { readonly kind: "find-by-id"; readonly args: Record<string, unknown> }
  | {
      readonly kind: "update-by-id";
      readonly where: Record<string, unknown>;
      readonly data: Record<string, unknown>;
      readonly fkChecks: readonly FkCheck[];
    }
  | { readonly kind: "delete-by-id"; readonly where: Record<string, unknown> }
  | {
      readonly kind: "upsert-by-id";
      readonly where: Record<string, unknown>;
      readonly create: Record<string, unknown>;
      readonly update: Record<string, unknown>;
      readonly createFkChecks: readonly FkCheck[];
      readonly updateFkChecks: readonly FkCheck[];
    };

export interface PlanScopedOpInput {
  readonly meta: ScopedModelMeta;
  readonly operation: string;
  readonly args: Record<string, unknown> | undefined;
  readonly tenantId: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Date) &&
    !(v instanceof Uint8Array)
  );
}

function asObject(v: unknown): Record<string, unknown> {
  return isPlainObject(v) ? v : {};
}

/** AND-merge `{ tenantField: tid }` into an existing `where` (never mutating). */
function andTenant(
  where: unknown,
  tenantField: string,
  tenantId: string,
): Record<string, unknown> {
  const clause = { [tenantField]: tenantId };
  if (where !== undefined && typeof where === "object" && where !== null) {
    return { AND: [where as Record<string, unknown>, clause] };
  }
  return clause;
}

/** Reject `include` (any) and relation `select` (nested object select). */
function guardProjection(args: Record<string, unknown>): string | null {
  if (args.include !== undefined) {
    return "include is not permitted on the scoped extension surface (a cross-model join is not tenant-filtered and could leak another tenant's rows)";
  }
  const select = args.select;
  if (isPlainObject(select)) {
    for (const [key, value] of Object.entries(select)) {
      if (isPlainObject(value)) {
        return `select of relation "${key}" is not permitted on the scoped extension surface (nested relation reads are not tenant-filtered)`;
      }
    }
  }
  return null;
}

/** Reject if any non-JSON `data` field carries a nested relation write. */
function findNestedWrite(
  data: Record<string, unknown>,
  jsonFields: readonly string[],
): string | null {
  for (const [key, value] of Object.entries(data)) {
    if (jsonFields.includes(key)) continue;
    if (
      isPlainObject(value) &&
      Object.keys(value).some((k) => NESTED_WRITE_KEYS.has(k))
    ) {
      return `nested write on relation "${key}" is not permitted on the scoped extension surface (design Q10 — extension models are shallow in v1)`;
    }
  }
  return null;
}

/** Reject a write that tries to set the tenant column itself (tenant reassignment). */
function guardTenantField(
  data: Record<string, unknown>,
  tenantField: string,
): string | null {
  if (Object.prototype.hasOwnProperty.call(data, tenantField)) {
    return `cannot set "${tenantField}" directly on the scoped extension surface (the tenant is bound by tenant(tid))`;
  }
  return null;
}

/**
 * Reject a write that touches a protected column.
 *
 * Keyed on PRESENCE, not on value: `{ textSourceType: undefined }` is rejected
 * too. Prisma treats an explicit `undefined` as "omit this field", so allowing it
 * would be harmless in practice — but the check exists to make an extension's
 * *intent* to write provenance fail loudly, and an extension that computes the
 * value conditionally would otherwise pass review while occasionally attempting
 * the write. `hasOwnProperty` is the same test `guardTenantField` uses, for the
 * same reason.
 */
function guardProtectedFields(
  data: Record<string, unknown>,
  protectedFields: readonly string[],
): string | null {
  for (const field of protectedFields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      return `cannot write "${field}" on the scoped extension surface: it is a synthetic-content provenance column (AI Act Art. 50). Set provenance through the core post/comment API, which mints the basis server-side — an extension that could write it could forge PLATFORM_GENERATED.`;
    }
  }
  return null;
}

/** Build the read-before-write FK ownership checks for a write payload. */
function fkChecksFor(
  data: Record<string, unknown>,
  meta: ScopedModelMeta,
  tenantId: string,
): FkCheck[] {
  const checks: FkCheck[] = [];
  for (const fk of meta.fkFields) {
    if (meta.jsonFields.includes(fk.field)) continue;
    const value = data[fk.field];
    if (typeof value !== "string") continue; // absent / null / non-scalar → nothing to check
    checks.push({
      targetModel: fk.targetModel,
      where: { id: value, [fk.targetTenantField]: tenantId },
    });
  }
  return checks;
}

/**
 * Pure scoping decision for one Prisma operation on a scoped model. No I/O, no
 * Prisma types — the imperative shell ({@link createScopedDb}) executes it.
 * ENFORCE-ALWAYS: there is no `"off"` branch.
 */
export function planScopedOp(input: PlanScopedOpInput): ScopedOpPlan {
  const { meta, operation, tenantId } = input;
  const args = input.args ?? {};
  const tf = meta.tenantField;

  // (e) Projection guard — applies to every op that can request relations.
  const proj = guardProjection(args);
  if (proj) return { kind: "reject", message: proj };

  // (a) Where-mergeable reads/deletes (no data payload).
  if (WHERE_MERGEABLE_OPS.has(operation)) {
    return {
      kind: "call",
      operation,
      args: { ...args, where: andTenant(args.where, tf, tenantId) },
      fkChecks: [],
    };
  }

  // (b) findUnique by a unique selector → findFirst with the tenant AND-merged.
  if (operation === "findUnique") {
    return {
      kind: "find-by-id",
      args: { ...args, where: andTenant(args.where, tf, tenantId) },
    };
  }

  // (a)+(c)+(d) create — stamp tenant, validate FK targets, reject nested writes.
  if (operation === "create") {
    const data = asObject(args.data);
    const reassign =
      guardTenantField(data, tf) ??
      guardProtectedFields(data, meta.protectedFields);
    if (reassign) return { kind: "reject", message: reassign };
    const nested = findNestedWrite(data, meta.jsonFields);
    if (nested) return { kind: "reject", message: nested };
    return {
      kind: "call",
      operation: "create",
      args: { ...args, data: { ...data, [tf]: tenantId } },
      fkChecks: fkChecksFor(data, meta, tenantId),
    };
  }

  if (operation === "createMany") {
    const rows = Array.isArray(args.data) ? args.data : [args.data];
    const stamped: Record<string, unknown>[] = [];
    const checks: FkCheck[] = [];
    for (const row of rows) {
      const data = asObject(row);
      const reassign =
        guardTenantField(data, tf) ??
        guardProtectedFields(data, meta.protectedFields);
      if (reassign) return { kind: "reject", message: reassign };
      const nested = findNestedWrite(data, meta.jsonFields);
      if (nested) return { kind: "reject", message: nested };
      stamped.push({ ...data, [tf]: tenantId });
      checks.push(...fkChecksFor(data, meta, tenantId));
    }
    return {
      kind: "call",
      operation: "createMany",
      args: { ...args, data: stamped },
      fkChecks: checks,
    };
  }

  // updateMany — scope the where AND validate FK targets in the data.
  if (operation === "updateMany") {
    const data = asObject(args.data);
    const reassign =
      guardTenantField(data, tf) ??
      guardProtectedFields(data, meta.protectedFields);
    if (reassign) return { kind: "reject", message: reassign };
    const nested = findNestedWrite(data, meta.jsonFields);
    if (nested) return { kind: "reject", message: nested };
    return {
      kind: "call",
      operation: "updateMany",
      args: { ...args, where: andTenant(args.where, tf, tenantId), data },
      fkChecks: fkChecksFor(data, meta, tenantId),
    };
  }

  // (b)+(c)+(d) update by id → updateMany + assert count === 1.
  if (operation === "update") {
    const data = asObject(args.data);
    const reassign =
      guardTenantField(data, tf) ??
      guardProtectedFields(data, meta.protectedFields);
    if (reassign) return { kind: "reject", message: reassign };
    const nested = findNestedWrite(data, meta.jsonFields);
    if (nested) return { kind: "reject", message: nested };
    return {
      kind: "update-by-id",
      where: andTenant(args.where, tf, tenantId),
      data,
      fkChecks: fkChecksFor(data, meta, tenantId),
    };
  }

  // (b) delete by id → capture + deleteMany + assert count === 1.
  if (operation === "delete") {
    return { kind: "delete-by-id", where: andTenant(args.where, tf, tenantId) };
  }

  // (b)+(c)+(d) upsert by id → read-before-write emulation (guard where + create).
  if (operation === "upsert") {
    const create = asObject(args.create);
    const update = asObject(args.update);
    const reassign =
      guardTenantField(create, tf) ??
      guardTenantField(update, tf) ??
      guardProtectedFields(create, meta.protectedFields) ??
      guardProtectedFields(update, meta.protectedFields);
    if (reassign) return { kind: "reject", message: reassign };
    const nested =
      findNestedWrite(create, meta.jsonFields) ??
      findNestedWrite(update, meta.jsonFields);
    if (nested) return { kind: "reject", message: nested };
    return {
      kind: "upsert-by-id",
      where: andTenant(args.where, tf, tenantId),
      create: { ...create, [tf]: tenantId },
      update,
      createFkChecks: fkChecksFor(create, meta, tenantId),
      updateFkChecks: fkChecksFor(update, meta, tenantId),
    };
  }

  // Fail-closed: anything else (incl. $queryRaw-shaped names) is not permitted.
  return {
    kind: "reject",
    message: `operation "${operation}" is not permitted on the scoped extension surface`,
  };
}

// ---------------------------------------------------------------------------
// Imperative shell — the proxy over the raw Prisma client
// ---------------------------------------------------------------------------

/** Thrown by the scoped surface on any isolation violation or missing row. */
export class ScopedDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopedDbError";
  }
}

/** The minimal raw-delegate shape the shell drives (no `any`). */
interface RawDelegate {
  findFirst(args?: unknown): Promise<unknown>;
  findMany(args?: unknown): Promise<unknown[]>;
  create(args: unknown): Promise<unknown>;
  createMany(args: unknown): Promise<{ count: number }>;
  updateMany(args: unknown): Promise<{ count: number }>;
  deleteMany(args?: unknown): Promise<{ count: number }>;
  count(args?: unknown): Promise<number>;
  aggregate(args: unknown): Promise<unknown>;
  groupBy(args: unknown): Promise<unknown[]>;
}

/** The subset of the Prisma client the shell uses: model delegates by key. */
export type RawPrismaLike = Record<string, RawDelegate>;

async function runFkChecks(
  prisma: RawPrismaLike,
  checks: readonly FkCheck[],
): Promise<void> {
  for (const check of checks) {
    const target = prisma[check.targetModel];
    if (!target || typeof target.findFirst !== "function") {
      throw new ScopedDbError(
        `FK target model "${check.targetModel}" is not available on the scoped surface`,
      );
    }
    const found = await target.findFirst({ where: check.where });
    if (found === null || found === undefined) {
      throw new ScopedDbError(
        `referenced ${check.targetModel} row is not owned by this tenant`,
      );
    }
  }
}

const NOT_FOUND = "record not found for this tenant";

async function executeScopedOp(
  prisma: RawPrismaLike,
  raw: RawDelegate,
  meta: ScopedModelMeta,
  operation: string,
  args: Record<string, unknown> | undefined,
  tenantId: string,
): Promise<unknown> {
  const plan = planScopedOp({ meta, operation, args, tenantId });

  switch (plan.kind) {
    case "reject":
      throw new ScopedDbError(plan.message);

    case "call": {
      await runFkChecks(prisma, plan.fkChecks);
      const fn = (raw as unknown as Record<
        string,
        (a: unknown) => Promise<unknown>
      >)[plan.operation];
      return fn(plan.args);
    }

    case "find-by-id":
      return raw.findFirst(plan.args);

    case "update-by-id": {
      await runFkChecks(prisma, plan.fkChecks);
      const res = await raw.updateMany({ where: plan.where, data: plan.data });
      if (res.count !== 1) throw new ScopedDbError(NOT_FOUND);
      return raw.findFirst({ where: plan.where });
    }

    case "delete-by-id": {
      const row = await raw.findFirst({ where: plan.where });
      if (row === null || row === undefined) throw new ScopedDbError(NOT_FOUND);
      const res = await raw.deleteMany({ where: plan.where });
      if (res.count !== 1) throw new ScopedDbError(NOT_FOUND);
      return row;
    }

    case "upsert-by-id": {
      const existing = await raw.findFirst({ where: plan.where });
      if (existing !== null && existing !== undefined) {
        await runFkChecks(prisma, plan.updateFkChecks);
        const res = await raw.updateMany({
          where: plan.where,
          data: plan.update,
        });
        if (res.count !== 1) throw new ScopedDbError(NOT_FOUND);
        return raw.findFirst({ where: plan.where });
      }
      await runFkChecks(prisma, plan.createFkChecks);
      return raw.create({ data: plan.create });
    }
  }
}

/** Build the tenant-bound delegate for one model. */
function makeScopedDelegate(
  prisma: RawPrismaLike,
  meta: ScopedModelMeta,
  tenantId: string,
): ScopedDelegate {
  const raw = prisma[meta.model];
  if (!raw) {
    return makeBlockedDelegate(meta.model);
  }
  const run = (operation: string) => (args?: unknown) =>
    executeScopedOp(
      prisma,
      raw,
      meta,
      operation,
      args as Record<string, unknown> | undefined,
      tenantId,
    );
  return {
    findMany: run("findMany") as ScopedDelegate["findMany"],
    findFirst: run("findFirst") as ScopedDelegate["findFirst"],
    findUnique: run("findUnique") as ScopedDelegate["findUnique"],
    create: run("create") as ScopedDelegate["create"],
    createMany: run("createMany") as ScopedDelegate["createMany"],
    update: run("update") as ScopedDelegate["update"],
    updateMany: run("updateMany") as ScopedDelegate["updateMany"],
    upsert: run("upsert") as ScopedDelegate["upsert"],
    delete: run("delete") as ScopedDelegate["delete"],
    deleteMany: run("deleteMany") as ScopedDelegate["deleteMany"],
    count: run("count") as ScopedDelegate["count"],
    aggregate: run("aggregate") as ScopedDelegate["aggregate"],
    groupBy: run("groupBy") as ScopedDelegate["groupBy"],
  };
}

/** A fail-closed delegate: every op throws. Used for blocked/unknown models. */
function makeBlockedDelegate(model: string): ScopedDelegate {
  // async so the rejection surfaces via the returned Promise (the whole surface
  // is async), not as a synchronous throw at call time.
  const blocked = async (): Promise<never> => {
    throw new ScopedDbError(
      `model "${model}" is not available on the scoped extension surface`,
    );
  };
  return {
    findMany: blocked,
    findFirst: blocked,
    findUnique: blocked,
    create: blocked,
    createMany: blocked,
    update: blocked,
    updateMany: blocked,
    upsert: blocked,
    delete: blocked,
    deleteMany: blocked,
    count: blocked,
    aggregate: blocked,
    groupBy: blocked,
  };
}

/**
 * Build a {@link ScopedDb} bound to `tenantId` over the raw Prisma client. Every
 * delegate access on the returned handle is tenant-scoped enforce-always; a
 * model not in `metas` (e.g. `activity`, `postEntity`, or any table outside the
 * scoped surface) returns a fail-closed delegate whose ops throw.
 */
export function createScopedDb(
  prisma: RawPrismaLike,
  tenantId: TenantId,
  metas: ReadonlyMap<string, ScopedModelMeta>,
): ScopedDb {
  const cache = new Map<string, ScopedDelegate>();
  const handler: ProxyHandler<ScopedDb> = {
    get(_target, prop): ScopedDelegate | undefined {
      if (typeof prop !== "string") return undefined;
      const cached = cache.get(prop);
      if (cached) return cached;
      const meta = metas.get(prop);
      const delegate = meta
        ? makeScopedDelegate(prisma, meta, tenantId)
        : makeBlockedDelegate(prop);
      cache.set(prop, delegate);
      return delegate;
    },
  };
  return new Proxy({} as ScopedDb, handler);
}

// ---------------------------------------------------------------------------
// Metadata assembly — core delegates + composed ext_* registry
// ---------------------------------------------------------------------------

/**
 * Map the composed-model registry into proxy metadata. `fkFields` now flows from
 * the registry entry (security F3/B4 — populated by the composer so the FK-tenant
 * read-before-write check fires for `ext_*` models); `jsonFields` stays empty
 * (no owned model declares a JSON FK-bearing column in v1).
 */
export function registryToMetas(
  registry: readonly ExtensionModelRegistryEntry[],
): ScopedModelMeta[] {
  return registry.map((entry) => ({
    model: entry.model,
    tenantField: entry.tenantField,
    fkFields: entry.fkFields ?? [],
    jsonFields: [],
    // An `ext_*` model's columns are the extension's OWN — there is nothing for
    // core to protect there. Protection applies to CORE models the extension is
    // allowed to reach (see CORE_SCOPED_DELEGATE_META).
    protectedFields: [],
  }));
}

function assembleScopedModelMetas(
  extMetas: readonly ScopedModelMeta[],
): Map<string, ScopedModelMeta> {
  const map = new Map<string, ScopedModelMeta>();
  for (const meta of CORE_SCOPED_DELEGATE_META) map.set(meta.model, meta);
  for (const meta of extMetas) map.set(meta.model, meta);

  // FK targets must resolve to a known scoped model or a core allowlist entry.
  for (const meta of extMetas) {
    for (const fk of meta.fkFields) {
      if (!CORE_FK_ALLOWLIST.has(fk.targetModel) && !map.has(fk.targetModel)) {
        throw new ScopedDbError(
          `model "${meta.model}" declares an FK "${fk.field}" to unknown target "${fk.targetModel}" (not a core allowlist model or a model on the scoped surface)`,
        );
      }
    }
  }
  return map;
}

// The default (no-arg) path reads the boot-injected registry and CACHES the
// assembled map (security F5): the registry is immutable after freeze, and
// `createExtensionContext` calls this per request — recomputing each time is
// waste. The cache is keyed on the active-registry array identity, so a
// `setExtensionModelRegistry` (before freeze) or a test reset — which replaces
// the array reference — invalidates it automatically.
let cachedRegistryRef: readonly ExtensionModelRegistryEntry[] | null = null;
let cachedRegistryMetas: Map<string, ScopedModelMeta> | null = null;

/**
 * Assemble the full `delegate key → ScopedModelMeta` map for a scoped surface:
 * the tenant-carrying core delegates plus the extension's own composed models.
 * With no argument it reads the boot-injected registry (cached); an explicit
 * `extMetas` (used by tests) bypasses the cache.
 */
export function buildScopedModelMetas(
  extMetas?: readonly ScopedModelMeta[],
): Map<string, ScopedModelMeta> {
  if (extMetas !== undefined) {
    return assembleScopedModelMetas(extMetas);
  }
  const registry = getExtensionModelRegistry();
  if (cachedRegistryMetas && cachedRegistryRef === registry) {
    return cachedRegistryMetas;
  }
  const map = assembleScopedModelMetas(registryToMetas(registry));
  cachedRegistryRef = registry;
  cachedRegistryMetas = map;
  return map;
}
