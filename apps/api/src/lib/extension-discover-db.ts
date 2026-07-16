/**
 * Extension cross-tenant discover surface (05a Part B).
 *
 * `ctx.db.discover(reason)` is the sanctioned, audited, allow-listed way for an
 * extension route/hook/strategy to read content that is cross-tenant *by
 * construction* — a caller's feed candidates live in other users' personal
 * tenants (05a §4.1, §6). It is the mirror image of L1's `tenant(tid)`:
 *   - `tenant(tid)` = scoped read/write, tenant-bound by construction;
 *   - `discover(reason)` = global READ-ONLY, visibility-floored by construction.
 *
 * Every guarantee is enforced at runtime (not just in the type), because the
 * bound tenant that makes L1's guards safe is exactly what discover removes:
 *  1. READ-ONLY — only the five read methods exist on the facade (no write op is
 *     reachable), each executed inside `runUnscoped("ext:<id>:<reason>", …)` so
 *     every cross-tenant read is audited.
 *  2. Model gate — only models the extension declared in `crossTenantRead`
 *     (validated at registration against {@link DISCOVER_CORE_ALLOWLIST} ∪ its
 *     own `ext_*` models) resolve to a delegate; anything else is fail-closed.
 *  3. Baseline visibility floor — AND-merged into every `where`, non-overridable
 *     (public/SHOUT content, active catalog, caller region). §4.4(3).
 *  4. Projection guard — no `include`, no relation `select` (§4.4(4)); a
 *     relation-`where` guard rejects traversal to any non-declared model
 *     (`author`/`tenant`/… would otherwise be a field oracle, §4.4(4a)); and a
 *     per-model column allow-list strips `tenantId`/`authorId`/`geoData`/… so
 *     discover cannot build an author→tenant map or harvest locations (§4.4(4b)).
 *  5. Abuse caps — `take` clamped (default 50, hard max 200), deep `skip`
 *     rejected (§4.4(7)); route-level rate limiting is attached by the wrapper.
 *
 * Functional core / imperative shell, like `extension-scoped-db.ts`:
 *  - {@link planDiscoverOp} is pure: validate (throw) + rewrite args + report
 *    the columns to strip from results. No I/O.
 *  - {@link createDiscoverDb} is the thin shell: run the plan through
 *    `runUnscoped`, execute the raw read, project result rows.
 */

import { Prisma } from "@prisma/client";
import type { CrossTenantReadDelegate, DiscoverDb } from "@de-otio/trellis-extension-api";
import { runUnscoped } from "./tenant-scope.js";
import {
  buildReadOnlyFacade,
  READ_DELEGATE_METHODS,
  type ReadDelegateMethod,
} from "./extension-read-delegate.js";

// ---------------------------------------------------------------------------
// Constants — the core discover policy
// ---------------------------------------------------------------------------

/**
 * v1 core allow-list — catalog/content only (05a §4.4(1)). Deliberately minimal.
 * NEVER: user, tenant, tenantMember, entity (per-tenant data with an owner —
 * cross-tenant entity discovery is a separate future decision, OQ-4), or any
 * auth/moderation/audit model.
 */
export const DISCOVER_CORE_ALLOWLIST: ReadonlySet<string> = new Set([
  "post",
  "postTaxonomyTag",
  "entityTaxonomyTag",
  "taxonomyTaxon",
  "taxonomyCategory",
  "taxonomyDimension",
  "productTaxonomyTag",
]);

/** Machine-greppable audit reason: `ext:<id>:<reason>`. */
const REASON_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

const TAKE_DEFAULT = 50;
const TAKE_MAX = 200;
/** Reject deep offset pagination — a cross-tenant scan should not page far. */
const SKIP_MAX = 1000;

/**
 * Columns never returned from discover, per model. `tenantId` is excluded from
 * EVERY model (so discover can never build an author→tenant map); `post` also
 * drops `authorId`/`geoData`/`uri` (§4.4(4b)). An extension needing an excluded
 * column is a deliberate allow-list change, not a query tweak.
 */
const DISCOVER_EXCLUDED_COLUMNS: Record<string, ReadonlySet<string>> = {
  post: new Set(["tenantId", "authorId", "geoData", "uri"]),
};
const DEFAULT_EXCLUDED_COLUMNS: ReadonlySet<string> = new Set(["tenantId"]);

function excludedColumnsFor(model: string): ReadonlySet<string> {
  return DISCOVER_EXCLUDED_COLUMNS[model] ?? DEFAULT_EXCLUDED_COLUMNS;
}

/**
 * Per-model baseline visibility floor, AND-merged into every `where`
 * (§4.4(3)). Non-overridable: an extension `where: { radius: "NORMAL" }` still
 * AND-s with `SHOUT`, yielding zero rows rather than widening.
 */
function discoverBaselineWhere(
  model: string,
  callerRegion: string,
): Record<string, unknown> {
  switch (model) {
    case "post":
      // SHOUT = radiated to everyone; region floor mirrors core's feed filter.
      return {
        deletedAt: null,
        hiddenByAuthor: false,
        radius: "SHOUT",
        dataRegion: callerRegion,
      };
    case "taxonomyTaxon":
      return { isActive: true }; // drafts are not public catalog
    default:
      // Join/catalog tables (postTaxonomyTag, entityTaxonomyTag,
      // taxonomyCategory, taxonomyDimension, productTaxonomyTag): the post-side
      // floor applies via the relation-where guard; rows are intentionally public.
      return {};
  }
}

// ---------------------------------------------------------------------------
// DMMF-derived metadata (built once at module load) — relation targets +
// scalar fields per model, the ground truth the guards need.
// ---------------------------------------------------------------------------

function toPascal(camel: string): string {
  return camel.length === 0 ? camel : camel[0].toUpperCase() + camel.slice(1);
}
function toCamel(pascal: string): string {
  return pascal.length === 0 ? pascal : pascal[0].toLowerCase() + pascal.slice(1);
}

interface ModelMeta {
  /** relation field name → target model (camelCase delegate key). */
  readonly relations: ReadonlyMap<string, string>;
  /** scalar (non-relation) field names. */
  readonly scalars: ReadonlySet<string>;
}

const MODEL_META: ReadonlyMap<string, ModelMeta> = (() => {
  const map = new Map<string, ModelMeta>();
  for (const model of Prisma.dmmf.datamodel.models) {
    const relations = new Map<string, string>();
    const scalars = new Set<string>();
    for (const field of model.fields) {
      if (field.kind === "object") {
        relations.set(field.name, toCamel(field.type));
      } else {
        scalars.add(field.name); // scalar or enum
      }
    }
    map.set(toCamel(model.name), { relations, scalars });
  }
  return map;
})();

/** Prisma relation-filter operators whose value is a nested where on the target. */
const RELATION_FILTER_OPS = new Set(["some", "every", "none", "is", "isNot"]);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DiscoverGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoverGuardError";
  }
}

// ---------------------------------------------------------------------------
// Pure guards
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Reject `include` (any) and relation `select` (§4.4(4)) — a cross-model join is
 * not visibility-floored and would leak past the model allow-list.
 */
function guardProjection(args: Record<string, unknown>): void {
  if (args.include !== undefined) {
    throw new DiscoverGuardError(
      "include is not permitted on discover() (a cross-model join bypasses the model allow-list and visibility floor)",
    );
  }
  const select = args.select;
  if (isPlainObject(select)) {
    for (const [key, value] of Object.entries(select)) {
      if (isPlainObject(value)) {
        throw new DiscoverGuardError(
          `select of relation "${key}" is not permitted on discover()`,
        );
      }
    }
  }
}

/**
 * The load-bearing guard (§4.4(4a)). Walk the `where` tree; every relation key
 * traversed must target a model that is itself in the caller's allowed discover
 * set. Otherwise a relation filter (`author: { email: … }`) becomes a field
 * oracle over `User`/`Tenant`/`TenantMember` — the exact models the allow-list
 * declares NEVER.
 */
function guardRelationWhere(
  model: string,
  where: unknown,
  allowed: ReadonlySet<string>,
): void {
  if (!isPlainObject(where)) return;
  const meta = MODEL_META.get(model);
  for (const [key, value] of Object.entries(where)) {
    if (key === "AND" || key === "OR" || key === "NOT") {
      const branches = Array.isArray(value) ? value : [value];
      for (const branch of branches) guardRelationWhere(model, branch, allowed);
      continue;
    }
    const target = meta?.relations.get(key);
    if (!target) continue; // scalar field filter — no relation traversal, allowed
    if (!allowed.has(target)) {
      throw new DiscoverGuardError(
        `relation "${key}" on "${model}" traverses to "${target}", which is not in this extension's crossTenantRead set`,
      );
    }
    // Recurse into the relation filter (some/every/none/is/isNot → nested where,
    // or a direct nested where object).
    if (isPlainObject(value)) {
      for (const [op, sub] of Object.entries(value)) {
        if (RELATION_FILTER_OPS.has(op)) {
          guardRelationWhere(target, sub, allowed);
        } else {
          // direct nested-where field on the related model
          guardRelationWhere(target, value, allowed);
          break;
        }
      }
    }
  }
}

/** Reject `select`/`groupBy by` of an excluded column (§4.4(4b)). */
function guardColumns(model: string, args: Record<string, unknown>): void {
  const excluded = excludedColumnsFor(model);
  const select = args.select;
  if (isPlainObject(select)) {
    for (const key of Object.keys(select)) {
      if (excluded.has(key) && select[key]) {
        throw new DiscoverGuardError(
          `select of "${key}" is not permitted on discover("${model}")`,
        );
      }
    }
  }
  const by = args.by;
  const byList = Array.isArray(by) ? by : typeof by === "string" ? [by] : [];
  for (const col of byList) {
    if (typeof col === "string" && excluded.has(col)) {
      throw new DiscoverGuardError(
        `groupBy of "${col}" is not permitted on discover("${model}")`,
      );
    }
  }
}

function andMerge(
  where: unknown,
  floor: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.keys(floor).length === 0) {
    return isPlainObject(where) ? where : {};
  }
  if (isPlainObject(where)) {
    return { AND: [where, floor] };
  }
  return floor;
}

export interface DiscoverPlan {
  /** Rewritten args to hand the raw delegate. */
  readonly args: Record<string, unknown>;
  /** Columns to strip from result rows (belt-and-suspenders for no-`select` reads). */
  readonly stripColumns: ReadonlySet<string>;
}

/**
 * Pure planning + validation for one discover read. Throws
 * {@link DiscoverGuardError} on any guard violation; otherwise returns the
 * rewritten args and the columns to project out of results.
 */
export function planDiscoverOp(
  model: string,
  op: ReadDelegateMethod,
  rawArgs: unknown,
  allowed: ReadonlySet<string>,
  callerRegion: string,
): DiscoverPlan {
  const args: Record<string, unknown> = isPlainObject(rawArgs) ? { ...rawArgs } : {};

  guardProjection(args);
  guardColumns(model, args);
  guardRelationWhere(model, args.where, allowed);

  // Baseline floor, AND-merged and non-overridable.
  args.where = andMerge(args.where, discoverBaselineWhere(model, callerRegion));

  // Abuse caps.
  if (typeof args.skip === "number" && args.skip > SKIP_MAX) {
    throw new DiscoverGuardError(
      `skip ${args.skip} exceeds the discover() max of ${SKIP_MAX}`,
    );
  }
  if (op === "findMany" || op === "groupBy") {
    const requested = typeof args.take === "number" && args.take > 0 ? args.take : TAKE_DEFAULT;
    args.take = Math.min(requested, TAKE_MAX);
  }

  return { args, stripColumns: excludedColumnsFor(model) };
}

// ---------------------------------------------------------------------------
// Imperative shell
// ---------------------------------------------------------------------------

function stripRow(row: unknown, cols: ReadonlySet<string>): unknown {
  if (!isPlainObject(row) || cols.size === 0) return row;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!cols.has(k)) out[k] = v;
  }
  return out;
}

type RawDelegate = Record<string, (args?: unknown) => Promise<unknown>>;

function blockedDelegate(model: string): CrossTenantReadDelegate {
  return buildReadOnlyFacade(
    () => () => {
      throw new DiscoverGuardError(
        `model "${model}" is not in this extension's crossTenantRead declaration`,
      );
    },
    "extension-discover-db(blocked)",
  );
}

function discoverDelegate(
  raw: RawDelegate,
  model: string,
  extensionId: string,
  reason: string,
  allowed: ReadonlySet<string>,
  callerRegion: string,
): CrossTenantReadDelegate {
  const auditReason = `ext:${extensionId}:${reason}`;
  return buildReadOnlyFacade((method) => async (rawArgs: unknown) => {
    const plan = planDiscoverOp(model, method, rawArgs, allowed, callerRegion);
    const result = await runUnscoped(auditReason, () => raw[method](plan.args));
    if (method === "findMany") {
      return Array.isArray(result)
        ? result.map((r) => stripRow(r, plan.stripColumns))
        : result;
    }
    if (method === "findFirst") {
      return result === null ? null : stripRow(result, plan.stripColumns);
    }
    // count / aggregate / groupBy — no row set to project (groupBy `by`
    // columns were validated against the exclusion list in the planner).
    return result;
  }, "extension-discover-db");
}

/**
 * Build the discover surface for one request. `reason` is validated here (throws
 * on empty/free-text). Declared models resolve to an audited, guarded read-only
 * delegate; every other key resolves to a fail-closed blocked delegate.
 */
export function createDiscoverDb(
  rawPrisma: unknown,
  extensionId: string,
  reason: string,
  allowed: ReadonlySet<string>,
  callerRegion: string,
): DiscoverDb {
  if (!REASON_RE.test(reason)) {
    throw new DiscoverGuardError(
      `discover() reason must match ${REASON_RE} (got "${reason}")`,
    );
  }
  const prisma = rawPrisma as Record<string, RawDelegate>;
  const cache = new Map<string, CrossTenantReadDelegate>();

  return new Proxy(Object.create(null) as DiscoverDb, {
    get(_t, prop): CrossTenantReadDelegate | undefined {
      if (typeof prop !== "string") return undefined;
      let delegate = cache.get(prop);
      if (delegate) return delegate;
      delegate =
        allowed.has(prop) && typeof prisma[prop] === "object"
          ? discoverDelegate(prisma[prop], prop, extensionId, reason, allowed, callerRegion)
          : blockedDelegate(prop);
      cache.set(prop, delegate);
      return delegate;
    },
  });
}

// ---------------------------------------------------------------------------
// Registration-time manifest validation
// ---------------------------------------------------------------------------

/**
 * The set of models an extension may declare in `crossTenantRead`:
 * {@link DISCOVER_CORE_ALLOWLIST} ∪ its own `ext_*` models.
 */
export function resolveDiscoverAllowlist(
  ownModels: readonly string[],
): ReadonlySet<string> {
  return new Set<string>([...DISCOVER_CORE_ALLOWLIST, ...ownModels]);
}

/**
 * Validate an extension's `crossTenantRead` declaration. Returns the list of
 * undeclarable models (empty ⇒ valid). The caller fails startup on a non-empty
 * result (§4.4(1) — fail loudly at registration, not first request).
 */
export function invalidCrossTenantReadModels(
  crossTenantRead: readonly string[] | undefined,
  ownModels: readonly string[],
): string[] {
  if (!crossTenantRead || crossTenantRead.length === 0) return [];
  const allowed = resolveDiscoverAllowlist(ownModels);
  return crossTenantRead.filter((m) => !allowed.has(m));
}
