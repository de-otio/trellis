// CONTRACT: stable — coordinate changes. Shared P0b quota value types.
//
// Pure data contracts shared by the quota-enforcement functional-core unit and
// the shell that loads/persists tenant usage. NO behavior, NO limits literals
// here — the LIMITS are operational parameters sourced from Env.media at the
// call site (a hard-coded cap in this PUBLIC tarball would be a published
// quota). This file only names the shapes.

/** A tenant's current measured usage of the media store. */
export interface QuotaState {
  /** Number of objects currently counted against the tenant's quota. */
  readonly currentObjects: number;
  /** Total bytes currently counted against the tenant's quota. */
  readonly currentBytes: number;
}

/** The tenant's quota ceilings. Injected from Env.media — never literals. */
export interface QuotaLimits {
  /** Maximum number of objects the tenant may store. */
  readonly maxObjects: number;
  /** Maximum total bytes the tenant may store. */
  readonly maxBytes: number;
}
