# Trellis Mapping

How the lineages and the synthesis gap connect to existing Trellis monetization analysis.

---

## Direct Engagements With Existing Documents

| Document | Engagement |
|---|---|
| [`../README.md`](../README.md) | The value-exchange thesis is the existing closest articulation of "tax-shaped funding" — users contribute, brands fund, platform sustains. Lineage 2 (mechanism design, especially QF) is the academic ancestor the doc does not currently cite. Worth naming. |
| [`../06-revenue-model.md`](../06-revenue-model.md) | Currently brand-payment-centric. A "common-services-funded-by-participants" alternative — QF-shaped pooled funding, or COST-shaped levies — is a structurally different revenue model worth sketching as an option, even if not adopted. |
| [`../11-universal-micro-influencer.md`](../11-universal-micro-influencer.md) | Already collapses the influencer/user distinction at the *earner* level. The dual-citizenship claim extends the same move to the *governance* level — collapsing the B2B-customer / B2C-user distinction. Structurally the same intellectual move applied one layer down. |
| [`../12-freemium-value-exchange-viability.md`](../12-freemium-value-exchange-viability.md) (superseded) | The viability sketch implicitly assumed a single citizen class. The dual-citizenship framing would re-open the question of what proportional contribution means when classes contribute on different scales. |
| [`../13-indie-property-cases.md`](../13-indie-property-cases.md) | The "third equilibrium" Trellis needs to offer indie properties is structurally a *common services* offer — hosting, moderation, payments, federation reach — that the operator can't economically supply alone. That is the city-supplying-utilities pattern in miniature. |
| [`../14-european-platform-discourse.md`](../14-european-platform-discourse.md) | `stiftungen.social` (16 foundations, one Mastodon instance) is the *real-world prototype* of multiple organisational citizens jointly funding common infrastructure. The hypothesis names what they are doing implicitly. |
| [`../../../generic-core/11-activitypub-assessment.md`](../../../generic-core/11-activitypub-assessment.md) | Federation makes the city-analogy concrete in a way a closed platform does not: tenants are sovereign-ish polities, the federation protocol is the *international layer*, Trellis is the constitutional-default-setter. Worth re-reading the assessment through this lens. |

---

## Where Trellis Sits in the City Analogy

A clarifying distinction is worth being explicit about: **Trellis is not the city.**

Each tenant (each Trellis-hosted property) is closer to a city. Trellis is the substrate on which cities are built — closer to a constitutional layer or a federation-of-cities protocol than to any individual city.

This matters for the design questions in [05-the-synthesis-gap.md](05-the-synthesis-gap.md):

- The **common-services menu** is per-tenant. Trellis provides primitives (auth, moderation, federation, payments, identity verification); tenants assemble them into a service offering for their citizens.
- The **tax base** is per-tenant. Trellis takes its own share — but that share is *infrastructure rent*, not *tax*. Tenants tax their own citizens.
- The **citizenship gradient** is per-tenant. Different tenants can choose different B2B/B2C balances. A foundation-coalition instance and a vertical commercial instance will look different.
- The **constitutional defaults** are Trellis's. Identity-federation v0.7, ActivityPub federation enablement, value-exchange primitives, micro-influencer mechanics — these set the menu of what tenants *can* do, and the priors of what they will do by default.

In the city analogy, Trellis is the level at which **EU-style framework rules** are set (DSA, GDPR analogue), not the level at which municipal services are provided. This re-frames a lot of the value-exchange-platform monetization work as **tenant-level concerns**, with Trellis-level concerns being one level up.

---

## Action Items Surfaced by This Survey

1. **Name the academic ancestry in `../README.md`** — the value-exchange thesis is currently presented as original. It is closer to *applied quadratic funding for social platforms* than to original mechanism design. Naming the ancestry is more credible, not less.
2. **Sketch the dual-citizenship alternative in `../06-revenue-model.md`** — even if not adopted, naming it as an option makes the chosen model legible by contrast.
3. **Add a row to `../14-european-platform-discourse.md`** linking `stiftungen.social` to this folder — the foundation-coalition is the operational prototype of the framing.
4. **Re-read `../../../generic-core/11-activitypub-assessment.md` through the federation-as-international-layer lens** — federation may be doing more positioning work than the assessment currently credits it for.
5. **Open question for the identity-federation v0.7 design**: does it support multi-class citizenship (B2B tenants and B2C tenants on the same instance with different rights), or does it implicitly assume single-class? This was already surfaced by [`../14-european-platform-discourse.md`](../14-european-platform-discourse.md) Signal 2; the city framing sharpens it.
6. ~~Move the secure-voting design into the Trellis doc tree.~~ **Done 2026-05-25.** The seven voting documents now live at [`doc/02-technical/voting/`](../../../doc/02-technical/voting/). See [08-secure-voting.md](08-secure-voting.md) for the argument and the record of the move.
