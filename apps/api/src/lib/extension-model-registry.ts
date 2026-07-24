/**
 * Composed extension-model registry (O-1 design §12.3, Q8 item 4).
 *
 * The single generated source of truth for the extension-owned (`ext_*`) models
 * present in the composed schema. Three consumers agree on this contract:
 *
 * - **L1** feeds every entry's `model` into `TENANT_SCOPED_MODELS` so the
 *   scoped proxy enforces isolation and the `tenant-scope.test.ts` coverage
 *   tripwire stays green.
 * - **L2** (the fragment composer) GENERATES this array from the merged
 *   fragments — it is the "allowlist derived from the composed schema".
 * - **L4** iterates it for GDPR erasure: models with a non-null
 *   `erasureSubjectField` join the per-subject `deleteMany` sequence.
 *
 * **Empty today by design.** The only extension (`@skybber/ext-dogs`) owns no
 * Prisma tables yet — it is routes + taxonomy seeds. O-1 is infrastructure
 * ahead of its first table-owner (lane-02). L2 will emit entries here once a
 * fragment declares models.
 */

/**
 * A scalar FK column on a composed model whose tenant-ownership is validated
 * read-before-write by the scoped proxy (O-1 design §1 L1(i); security F3/B4).
 * Structurally identical to `ScopedFkField` in extension-scoped-db.ts — kept a
 * distinct declaration here to avoid a circular import (scoped-db imports this
 * module, not vice versa).
 */
export interface ExtensionModelFkField {
  /** The scalar FK column on THIS model, e.g. "entityId". */
  readonly field: string;
  /** The referenced model's Prisma delegate key (camelCase), e.g. "entity". */
  readonly targetModel: string;
  /** The tenant column on the TARGET model (conventionally "tenantId"). */
  readonly targetTenantField: string;
}

/**
 * One composed extension-owned model, as needed by isolation + erasure.
 */
export interface ExtensionModelRegistryEntry {
  /** Prisma model name (camelCase delegate key), e.g. "dogReminder". */
  readonly model: string;
  /** The mandatory tenant column injected on every scoped op, e.g. "tenantId". */
  readonly tenantField: string;
  /**
   * The column identifying the GDPR data subject for per-subject erasure, or
   * `null` when the model is `none-personal` / `cascade-only` (design §6).
   */
  readonly erasureSubjectField: string | null;
  /**
   * FK scalars whose target tenant-ownership is validated on create/update/upsert
   * (security F3/B4). Omitted/empty ⇒ no FK-tenant check for this model. A FK to a
   * per-SUBJECT model (`User`) does NOT belong here — that is an erasure linkage,
   * not a tenant check (see `CORE_FK_ALLOWLIST` in extension-scoped-db.ts).
   */
  readonly fkFields?: readonly ExtensionModelFkField[];
}

/**
 * The composed registry — the compiled-in DEFAULT. Empty by design (no extension
 * owns tables at build time). The runtime ACTIVE registry is injected at boot by
 * the consuming app via {@link setExtensionModelRegistry} (see below); this const
 * remains the fallback when nothing is injected.
 */
export const EXTENSION_MODEL_REGISTRY: readonly ExtensionModelRegistryEntry[] =
  [];

// ---------------------------------------------------------------------------
// Boot-time injection seam (security F5 / plan 011 Phase B)
//
// A consuming app that owns `ext_*` tables composes its schema, obtains the
// generated registry, and injects it here BEFORE the server starts serving.
// The three deep readers (tenant-scope, extension-validator, extension-scoped-db,
// user-data-deletion) read `getExtensionModelRegistry()`, never the const, so an
// injected registry reaches isolation + erasure uniformly. `freeze` closes the
// window: once the server is listening the registry can never change (no TOCTOU,
// no mid-flight mutation of the scoped surface).
// ---------------------------------------------------------------------------

let activeRegistry: readonly ExtensionModelRegistryEntry[] = EXTENSION_MODEL_REGISTRY;
let frozen = false;

/**
 * Inject the composed extension-model registry at boot. MUST be called before
 * {@link freezeExtensionModelRegistry} (i.e. before the HTTP listener binds) —
 * `startServer` freezes automatically. Throws if called after freezing.
 */
export function setExtensionModelRegistry(
  entries: readonly ExtensionModelRegistryEntry[],
): void {
  if (frozen) {
    throw new Error(
      "setExtensionModelRegistry: registry is frozen (the server has already started). " +
        "It can only be set at boot, before startServer().",
    );
  }
  activeRegistry = entries;
}

/**
 * Freeze the registry so it can never change while requests are served. Called
 * by `startServer` immediately before binding the listener.
 */
export function freezeExtensionModelRegistry(): void {
  frozen = true;
}

/** The active registry — the injected one if set, else the empty default. */
export function getExtensionModelRegistry(): readonly ExtensionModelRegistryEntry[] {
  return activeRegistry;
}

/**
 * TEST-ONLY reset of the boot injection state. Not part of the public contract;
 * exists so unit tests can exercise set/freeze in isolation.
 */
export function __resetExtensionModelRegistryForTest(): void {
  activeRegistry = EXTENSION_MODEL_REGISTRY;
  frozen = false;
}
