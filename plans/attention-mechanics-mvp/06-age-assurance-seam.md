# 06 · S6 (deferred) — age-assurance seam

**S6 itself is NOT in the MVP.** This file specifies the *minimal design
preparation* to add now so that privacy-preserving age assurance (zero-knowledge
attestations / third-party double-blind age tokens) becomes a **drop-in provider
later**, with no rework of `computeAgeTier` call sites or the age-tier machinery.

## Why a seam now

- Age is **self-declared** today: `post-confirmation.ts` reads Cognito
  `custom:dateOfBirth` and calls `computeAgeTier()`
  (`age-tier-transition.ts:16-21`). There is no notion of *how confident* we are
  in that age.
- `identityVerificationProvider` (`schema.prisma:200`, jumio/onfido/veriff) is
  **identity verification, not age assurance** — it has no flow wired and must
  **not** be conflated with age (per the research, identity-document collection
  for age-gating is the privacy harm to avoid). Keeping them separate is the
  whole point.
- Retrofitting an assurance concept after age checks are sprinkled through the
  code is expensive; a thin seam now is cheap.

## The seam (build in the MVP)

Three small, additive pieces — all behaviour-preserving:

### 1. Provenance field (one nullable column)

```prisma
// User
ageAssuranceMethod String @default("self_declared") @map("age_assurance_method")
// future values: "zk_attestation" | "age_token" | "parental_confirmation"
ageAssuredAt       DateTime? @map("age_assured_at")
```

Distinct from the `identityVerification*` fields. Default makes every existing
user `self_declared`; no backfill, no behaviour change.

### 2. Provider interface (one self-declared implementation)

```ts
// apps/api/src/lib/age-assurance/age-assurance-provider.ts
export interface AgeAssuranceResult {
  dateOfBirth: Date | null;     // or just a minimum-age boolean, for ZK tokens
  minimumAgeMet: Record<string, boolean>; // e.g. {"13": true, "16": false}
  method: string;               // -> ageAssuranceMethod
  assuredAt: Date;
}
export interface AgeAssuranceProvider {
  readonly method: string;
  assure(input: AgeAssuranceInput): Promise<AgeAssuranceResult>;
}

// the ONLY implementation in the MVP — wraps today's behaviour verbatim
export class SelfDeclaredAgeAssurance implements AgeAssuranceProvider { ... }
```

A registry `AGE_ASSURANCE_PROVIDERS: Record<string, AgeAssuranceProvider>` with
just `self_declared` registered. `post-confirmation.ts` and
`age-tier-transition.ts` obtain the provider from the registry and record its
`method` into `ageAssuranceMethod` — instead of assuming self-declaration. Today
that resolves to exactly the current path.

### 3. Tier computation reads assurance, not raw DOB

`computeAgeTier` stays a pure function of a date. The *source* of that date (and
the confidence) flows through `AgeAssuranceResult`. Note the ZK case may yield no
`dateOfBirth`, only `minimumAgeMet` — so the seam allows tier derivation from a
**minimum-age boolean** as well as a DOB. Add a `tierFromAssurance(result)`
helper now (self-declared path: derive from `dateOfBirth` exactly as today).

## What S6 adds *later* (not now)

- A `ZkAttestationProvider` / `AgeTokenProvider` implementing the same interface
  (e.g. EU Digital Identity wallet age attestation, or a double-blind token
  service) — registered alongside `self_declared`.
- A verification flow/route that invokes the chosen provider when a tenant's
  policy (the `TenantPolicy` from [`01`](01-ranking-policy-boundary.md)) demands
  assurance beyond self-declaration — gated on explicit regulatory demand +
  data-localisation (`Tenant.region`).
- **No change** to `computeAgeTier`, the minor-protection bundle
  ([`04`](04-minor-protection-bundle.md)), or call sites — they already consume
  `ageTier`, which the new provider populates through the same path.

## Changes (MVP-scope only)

| File | Change |
|---|---|
| `prisma/schema.prisma` | add `ageAssuranceMethod` (default `self_declared`) + `ageAssuredAt` to `User` |
| `apps/api/src/lib/age-assurance/age-assurance-provider.ts` | **new** — interface, registry, `SelfDeclaredAgeAssurance`, `tierFromAssurance` |
| `apps/api/src/lambda/post-confirmation.ts` | resolve provider from registry; record `ageAssuranceMethod` |
| `apps/api/src/lib/age-tier-transition.ts` | go through `tierFromAssurance` (self-declared today) |

## Tests

- Every existing/new user resolves to `self_declared`; tier output identical to
  today for DOB fixtures (parity).
- `tierFromAssurance` derives the same tier from a `minimumAgeMet` map as from
  the equivalent DOB (proves the ZK-shaped input is already supported).
- Registry returns `self_declared` as the only provider; an unknown method id
  fails closed (most restrictive tier) — so a misconfigured future provider can
  never *loosen* protection.

## Effort / priority

Low (interface + one nullable column + wrap existing path). **Priority: do it in
the MVP** — it is the cheap insurance that makes S6 a later drop-in rather than a
refactor, which is exactly what was asked for.
