# Enshittification Resistance — Analysis

> **Status (2026-06-02):** Design analysis. Maps Cory Doctorow's
> "enshittification" framework onto Trellis's actual architecture and
> proposes concrete, mostly-mechanical changes. No code written yet.

## What this is

Doctorow's thesis is not "platforms have bad features." It is that platforms
**decay in three stages** —

1. good to users (to build the user base),
2. then abuse users to please business customers (advertisers, brands, tenants),
3. then claw value back from business customers to the shareholders, until the
   platform is a pile of value extracted from a corpse —

and that what historically *prevented* this decay was four external
disciplines: **competition, regulation, interoperability, and labour**.
Enshittification is what happens once a platform has removed the constraints
that would otherwise stop it. The flexibility of digital systems — "twiddling,"
the moment-to-moment, person-to-person adjustment of the deal — is the engine;
surveillance data is the fuel; lock-in and anti-interoperability law ("felony
contempt of business model") are what keep users from walking away while it
happens.

Trellis already implements most of Doctorow's *antidotes* — chronological feeds,
no behavioural ads, finite views, data export, safety-by-design. So this
analysis does **not** rehash those. It asks the sharper question.

## The reframe: reversible defaults vs. structural invariants

Enshittification is the story of good defaults being changed under revenue
pressure. Every property Trellis is proud of can be sorted into two bins:

- **Reversible defaults** — good behaviour that a future maintainer, PM, or
  acquirer can quietly switch off in a config or a one-line code change.
- **Structural invariants** — good behaviour that cannot be reversed without a
  visible, costly, externally-observable act.

> **The whole game is converting the first into the second.** A guarantee is
> only as strong as the effort required to break it. "We choose not to rank on
> engagement" is a reversible default. "The build fails if a ranking input
> references engagement, and the active policy is shown to every user" is an
> invariant.

This is also Doctorow's deepest structural point: what actually prevents decay
is **binding your own hands so that reversal is expensive** — and doing it while
it is still cheap, *before* the revenue pressure that wants the reversal
arrives.

## Documents

| # | Document | Doctorow mechanism | Leverage |
|---|----------|--------------------|----------|
| 01 | [Framework and the reframe](01-framework-and-reframe.md) | All four forces; what Trellis already gets right | — |
| 02 | [A portable social graph, not just a data dump](02-portable-social-graph.md) | Interoperability / right to exit | **Highest** |
| 03 | [No-twiddling as an enforced invariant](03-twiddling-invariant.md) | Twiddling; transparency | High |
| 04 | [Don't collect the behavioural surplus](04-data-minimization.md) | Surveillance as fuel | High |
| 05 | [Tenant policy is a floor, not a dial](05-tenant-policy-floor.md) | Stage 2 (abuse users for business customers) | Medium–High |
| 06 | [Interoperability commitment — no felony contempt](06-interoperability-commitment.md) | Adversarial interop | Medium |
| 07 | [Binding your own hands](07-binding-your-own-hands.md) | Making reversal costly | Medium |

## The one tension to watch

The monetization roadmap (subscriptions, brand partnerships, "value-exchange")
is where stage-2/stage-3 pressure will actually land — the
`analysis/monetization/.../review/tensions/` folder already flags
brand-independence risk. The defense is not a cleverer revenue model; it is that
the invariants in docs 02–05 must be **in place before the revenue pressure
arrives.** Enshittification-resistance is only real if the constraints predate
the incentive to break them.

## What Trellis already gets right

So the proposals below read as deltas, not a verdict:

- **Chronological-only, engagement-free ranking** with an anti-engagement guard
  already in code (`apps/api/src/lib/feed-pagination.ts` `validateSortField`,
  `:61`) — Doctorow's end-to-end principle, essentially.
- **Finite feeds / "caught up"** — removes the infinite-scroll attention trap
  that stage-1→2 monetization depends on.
- **No ads, no behavioural monetization** — the monetization analysis explicitly
  rejects engagement-maximization revenue.
- **Tenant identity federation (OIDC/SAML) with a real disconnect path** —
  tenants can exit.
- **Comprehensive deletion + export** (`apps/api/src/lib/routes/export.ts`,
  `routes/deletion.ts`, `lambda/delete-account-worker.ts`) — the bones of a
  right-to-exit exist.

## Source

Cory Doctorow, "Enshittification" (coined Nov 2022; *Enshittification: Why
Everything Suddenly Got Worse and What to Do About It*, 2025). The four
disciplining forces and the twiddling/end-to-end framing are from his essays and
talks of 2023–2025.
