# Next Steps and Open Questions

## Recommended plan (if Option A is approved)

1. **Create `packages/crypto-envelope/`** as a new workspace package (or publish standalone to dot/npm CodeArtifact). Lift the 9 files listed in [`03-integration-options.md`](03-integration-options.md). Skip chaoskb-product-specific modules.
2. **Retire `@trellis/crypto`** — re-export the new package under the old name for backward compatibility during migration, then migrate call sites. `@trellis/crypto` becomes a thin re-export shim.
3. **Update [spyware-defense P1.1](../spyware-defense/03-priorities.md)** — note that crypto primitives are no longer the hard part; DM work becomes "protocol + UX on top of existing primitives." Adjust effort estimate downward.
4. **Update the downstream border-safety architecture** (in the trellis product repo) — wire the travel-prep snapshot to encrypted-blob storage using the new package. The `UserEncryptionKey.keyType` border-safety value becomes the real thing.
5. **Consider** adding a tier-upgrade path for users who opt into Maximum security — chaoskb's protocol is directly applicable.

**Effort estimate:**

| Step | Effort | Notes |
|------|--------|-------|
| 1 | 3–5 days | Mostly mechanical: move files, adjust imports, set up publishing |
| 2 | 3–5 days | Migration of existing call sites; backward-compatible shim keeps downtime near zero |
| 3 | 1 day | Doc update only |
| 4 | 2–4 weeks | Real protocol + UX work; gates on the downstream border-safety Phase 2 |
| 5 | Deferrable | UX and product decision; needs user-facing design |

Steps 1–3 are ~2 weeks of mechanical work; 4 is the substantive engineering; 5 is optional.

---

## Open questions — status

Resolved or outstanding as of 2026-04-12:

**Q1. Is chaoskb eligible to become a published npm dependency?** **Resolved** — the package will be published publicly under `@de-otio/crypto-envelope`, MIT, on `github.com/deotio`. See [`crypto-envelope-package/README.md`](../crypto-envelope-package/README.md) Decision B and [`crypto-envelope-package/04-governance-and-rollout.md`](../crypto-envelope-package/04-governance-and-rollout.md) for publishing details (provenance, Trusted Publishing, semver policy).

**Q2. Is there appetite to upgrade `@trellis/crypto` now, or only when E2E DMs are actually being built?** **Resolved** — yes, upgrade now via the migration plan in [`crypto-envelope-package/04-governance-and-rollout.md`](../crypto-envelope-package/04-governance-and-rollout.md#migration-plan-for-chaoskb-and-trellis). Current AES-GCM usage carries birthday-bound risk; waiting compounds it. Trellis migrates in Phase 1 after chaoskb, with a re-export shim keeping call-site changes minimal.

**Q3. Which tier model makes sense for a consumer product?** **Partially resolved.** The package ships a **two-tier core** (Standard SSH-wrap, Maximum Argon2id passphrase) in v1.0 — see [`crypto-envelope-package/03-package-design.md`](../crypto-envelope-package/03-package-design.md#tier-model--two-tiers-not-three). Product-specific mapping (what tier corresponds to what feature set — e.g. Cognito-only for casual users, passphrase-derived for border-travel prep) is still worth a separate design pass inside the consuming product, not in the shared package. The BIP39 question for at-risk audiences is an optional-adapter decision documented at [`crypto-envelope-package/03-package-design.md`](../crypto-envelope-package/03-package-design.md#tier-model--two-tiers-not-three).

**Q4. Does the downstream border-safety feature want an encrypted archive right away, or is that deferred?** Still open. The envelope package is now a pre-req either way; the feature-specific timing decision remains with that feature's owner in the trellis product repo.

**Q5. Does chaoskb stay standalone, or does it eventually merge into the Trellis ecosystem?** Still open; product-level, not engineering. Chaoskb stays standalone for the purpose of this migration — it consumes the shared package as a dependency. Deeper integration is a separate future question.

---

## What's been decided (2026-04-12)

- **Shared package extraction:** yes. Both chaoskb and trellis consume `@de-otio/crypto-envelope`.
- **Public release:** yes. MIT, public GitHub, npm with provenance.
- **Tier model:** two tiers (Standard SSH-wrap, Maximum passphrase). BIP39 is an optional per-consumer adapter, not a core tier.
- **Multi-device key transfer:** out of scope for v1.0; `@noble/curves` + app-level code, or later adapter.

Remaining decisions live with the owners of the consuming projects (border-safety timing in the trellis product repo; a consumer product's user-facing tier-to-feature mapping), not with the shared package.
