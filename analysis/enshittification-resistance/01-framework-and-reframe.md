# 01 — The framework and the reframe

## Doctorow's model, briefly

Enshittification describes a **three-stage decay**:

1. **Good to users.** The platform subsidises a great experience to accumulate
   users and the social graph that locks them in.
2. **Abuse users to please business customers.** Once users can't easily leave,
   value is shifted to advertisers, sellers, brands — and, in a multi-tenant
   core, to *tenants*.
3. **Claw value back to the platform.** Once business customers are locked in
   too, the platform withdraws value from them as well, leaving the thinnest
   viable product that still extracts.

Two enabling mechanisms run underneath all three stages:

- **Twiddling** — the moment-to-moment, person-to-person adjustment of the deal
  that digital flexibility allows: the feed you see, the price you're quoted,
  the payout a creator gets, all tuned in real time and individually. Twiddling
  is powered by **surveillance** (behavioural data), which is its fuel.
- **Lock-in** — high switching costs (the social graph), reinforced by
  **anti-interoperability** law and technical measures Doctorow calls "felony
  contempt of business model": using IP law (DMCA 1201, CFAA), DRM, and ToS
  clauses to make it illegal to build the tools that would let users leave.

## The four disciplining forces

Historically, four forces kept companies from enshittifying because each made
decay *costly*:

| Force | What it does | Trellis surface |
|-------|--------------|-----------------|
| **Competition** | Users defect to rivals | Credible exit (doc 02) |
| **Regulation** | The state punishes abuse | Disclosable policy (doc 03) |
| **Interoperability** | Users self-help around abuse | Portable graph, open client API (docs 02, 06) |
| **Labour** | Workers refuse to build the abuse | Governance / `CRIA` process (doc 07) |

Trellis can't legislate or unionise, but it **can** make competition and
interoperability structurally real, and it can make regulation easy to satisfy
by being transparent by construction.

## The reframe: defaults vs. invariants

Trellis already encodes Doctorow's antidotes — but mostly as **reversible
defaults**. Enshittification is precisely the process of changing good defaults
under pressure. So the design question for every good property is:

> Is this a default a future maintainer can quietly flip, or an invariant that
> cannot be reversed without a visible, costly, externally-observable act?

Examples of the conversion this analysis proposes:

| Reversible default (today) | Structural invariant (proposed) | Doc |
|---|---|---|
| "We don't rank on engagement" (a code convention) | The build fails if a ranking input references engagement; the active policy id is shown to every user | 03 |
| "You can export your data" (a JSON dump) | A re-importable graph export, round-trip tested in CI, so another instance can receive you | 02 |
| "Safe defaults live in core" | The tenant-policy merge can only *tighten* the safety floor, never loosen it | 05 |
| "We don't microtarget" | The per-user behavioural surplus that would enable microtargeting is never collected | 04 |

## What Trellis already gets right

This is genuinely a strong baseline, which is why the proposals are deltas:

- **Engagement-free chronological ranking**, with the guard already in code:
  `apps/api/src/lib/feed-pagination.ts` `validateSortField` (`:61`) rejects any
  sort field except `createdAt`. The
  [ranking-policy-boundary plan](../../plans/attention-mechanics-mvp/01-ranking-policy-boundary.md)
  lifts this into a named, disclosable policy object whose `RankingInput` enum
  has **no member** for likes/comments/shares/views.
- **Finite feeds** with a "caught up" signal — infinite scroll is
  architecturally impossible (the attention trap stage-2 monetization needs).
- **No behavioural ads or engagement monetization** — see
  `analysis/monetization/`.
- **Tenant identity federation** (OIDC/SAML) with `AdminUserGlobalSignOut` on
  disconnect — tenants can leave.
- **Account deletion + data export** —
  `apps/api/src/lib/routes/export.ts`, `routes/deletion.ts`,
  `apps/api/src/lambda/delete-account-worker.ts`.

The gaps are not "Trellis does the wrong thing." They are "Trellis does the
right thing in a way that is cheap to undo." Docs 02–07 each take one such gap.
