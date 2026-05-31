# Structural Echo Chambers: Architectural Levers for Trellis

## Source

Jennifer Ouellette, "RIP social media. What comes next is messy." *Ars Technica*, May 7, 2026, summarising recent work by **Petter Törnberg** (University of Amsterdam) and co-author Richard Rogers:

- Törnberg, *PLoS ONE* 2026 — DOI: [10.1371/journal.pone.0347207](https://doi.org/10.1371/journal.pone.0347207)
- Törnberg, *Journal of Quantitative Description: Digital Media* 2026 — DOI: [10.51685/jqd.2026.005](https://doi.org/10.51685/jqd.2026.005)
- Törnberg & Rogers, preprint (cited in article)

## Headline finding

Echo chambers, attention inequality, and amplification of extreme voices are **structurally embedded in the architecture of social media** — not artifacts of "the algorithm" or human negativity bias. Platform-level interventions (chronological feeds, content moderation, recommendation tweaks) don't change the underlying dynamics.

Methodology: agent-based simulation with LLM-driven personas, plus empirical analysis of r/MensRights and 2020/2024 American National Election Studies data.

## The five mechanisms worth designing against

1. **Leave-threshold tipping.** Users leave when the share of disagreers exceeds a personal threshold. Even modest thresholds amplify: each random interaction becomes more likely to push someone over the edge, the community homogenises, more divergent users leave, the centre of gravity shifts. A community with broad initial diversity tips into homogeneity rapidly.

2. **The 10% friendly floor (counterintuitive).** If a user can find ~10% of others who broadly agree with them inside an otherwise diverse space, they tolerate disagreement and stay. Below that, departure dynamics dominate. Filter bubbles, normally blamed for homogeneity, can be a *cure* when used to guarantee this floor inside diverse communities.

3. **Boiling-frog effect.** Users who stay are influenced by the drifting community and become more extreme themselves. Drift is self-reinforcing.

4. **Linguistic-distance predicts departure** (r/MensRights study). Users whose language diverges from the community centroid are most likely to leave next. This is a measurable leading indicator of imminent polarisation.

5. **Geography is a free defense.** The "local coffeehouse" is diverse because geography forces unrelated people to share space. Non-local platforms (WhatsApp, Substack, generic feeds) have no such constraint and tip readily.

Other findings worth noting:

- **Botification.** Human posters on Facebook/Twitter/X dropped ~50% (2020 → 2024); LLM-generated content fills the gap, often platform-instigated.
- **Working examples cited.** Bluesky's blocking tools; X's Community Notes (which surfaces cross-partisan-endorsed content — a working bridging signal in production).

## Mapping to Trellis architecture

Trellis's graph layer (Neo4j AuraDB; scored relationships, circle tiers, typed entity edges — see [doc/02-technical/architecture/14-graph-and-circles.md](../doc/02-technical/architecture/14-graph-and-circles.md)) is the substrate where these levers naturally live. None of what follows requires a new system; most are queries or invariants over what's already designed.

### Tier 1 — actionable now

**The 10% floor as a feed invariant.** For any discovery/ranking surface, guarantee a minimum proportion of results from the user's affinity neighbourhood. Implementation: a Cypher query that mixes a "diverse" candidate set with an "affinity-floor" candidate set before ranking. This is the single most evidence-backed intervention in the article.

**Bridging score (Community-Notes generalised).** Define a content quality signal as: positively engaged with by users from normally-divergent affinity clusters. Trellis's typed-edge graph already has the topology required; this is a Cypher computation, not a new data model. Use it to rank replies and surface cross-circle posts.

**Soft circle membership.** Tiered circles already mitigate the binary leave/stay decision that drives leave-threshold tipping. Make sure the UI doesn't push users toward all-in or out states — soft membership is structurally protective and should be the default expression of affiliation.

### Tier 2 — design tenets to write down

**Geographic anchoring for B2B.** Many vertical B2B participants (local services, hospitality, tourism, trade-specific providers) are inherently geo-bounded; that's the coffeehouse property the article says non-local platforms lack. Lean into geo-scoped discovery for B2B surfaces — it's protective, not just a UX choice. For verticals where B2B is the primary revenue line, this aligns with monetisation rather than fighting it.

**No AI personas in the social graph.** AI assistants for domain-specific Q&A are fine and clearly framed; AI accounts that *look like users* are exactly the botification dynamic Törnberg flags. Worth writing down as a tenet now so it doesn't quietly creep in via a "AI mascot" feature later.

**Resist algorithmic-broadcast drift.** Törnberg's strongest design claim is that TikTok/Reels-style for-you feeds aren't "social" anymore — they're a different medium. Keep the platform's primary surfaces interaction-based (replies, circles, follows). If a discovery feed is added, treat it as a tributary, not the river.

**Bot-resistance: layer 1 is in place; layer 2 (policy) is the gap.** As of writing, what exists:

- Invitation-code signup gate ([apps/api/src/lambda/pre-signup.ts](../apps/api/src/lambda/pre-signup.ts); reCAPTCHA v3 on invitation creation in trellis).
- AWS WAF edge IP rate limits — general 10k/5min, 500/5min on `/api/circles/*` and `/api/discovery/*` (defined in the WAF/network stack of the deploying consumer repo, e.g. `infra/lib/stacks/network-stack.ts`; trellis ships no standalone infra). Bot Control (`TARGETED`, JS fingerprinting) in prod.
- Cognito TOTP MFA wired but **optional** (security review M-3, [analysis/security-review.md](security-review.md)).
- ActivityPub inbound HTTP signature verification (RSA-SHA256) in trellis.
- WebAuthn/passkeys: Cognito-supported, scheduled Month-2 in [spyware-defense/03-priorities.md](spyware-defense/03-priorities.md) (P1.3); not yet wired.

What's absent and needs to land before launch (these are *policy over existing primitives*, not new plumbing):

- **Per-account rate limits keyed to graph-trust score** on posts/comments/follows/DMs. The Neo4j scored-relationship graph already exists; nothing reads it to gate behaviour. The trellis in-memory `RateLimiter` covers auth routes only and resets on worker restart — needs persistent (DynamoDB-backed) per-account counters tied to a trust tier derived from the graph.
- **Account-creation abuse controls** beyond the invite gate: per-IP, per-email-domain, per-device limits in pre-signup; disposable-email-domain blocklist.
- **New-account cooldown / reduced-reach period** (can't DM strangers, can't post in some circles, capped follows-per-day) decaying as graph-trust accrues.
- **Federation throttling**: per-remote-instance rate limits on inbound ActivityPub, plus an allow/block-list mechanism. Signature verification alone doesn't bound abuse from a hostile cooperating instance.
- **Behavioural-anomaly signals** (posting cadence, reply graph shape, follower-growth slope) feeding a moderation queue, not auto-ban. Phase 2.
- **LLM-content / C2PA / image-origin checks** — discussed in the misinformation analysis in the product repo, but not implemented. Phase 2.

The principle holds: this is cheaper to build now than retrofit. The work is *policy and graph queries*, not new infrastructure — the invite graph, scored relationships, and WAF are already there to lean on.

### Tier 3 — phase 2 / instrumentation

**Departure-risk as a community-health signal.** Linguistic drift of a user vs. the circle centroid is a leading indicator that a circle is heading toward homogenisation. Don't surface it to the *user* (creepy and may accelerate departure); use it as a moderation/admin signal that a circle needs attention. Requires embedding work that's not in scope today.

**Robust block / mute / mutelists** (Bluesky-style). Worth scoping against ActivityPub semantics. Not an architectural lever per Törnberg, but cited as one of the few interventions that demonstrably works.

## Honest caveats

- Törnberg himself says he doesn't yet know how to operationalise the "pivot points" reliably. The 10%-floor and bridging-score have the strongest empirical backing; the rest are tenets / things-not-to-screw-up rather than features to build.
- A topical-vertical domain is partly protective: it's a topical affinity space, not a political one. Echo-chamber risk still applies (intra-topic method/preference debates, advocacy factions), and the B2B side has commercial echo-chamber risk (vendor cliques), but it's a less hostile starting point than a general-purpose platform.
- The "10%" number is from agent-based simulation with LLM personas, not field-tested on a deployed platform. Treat it as the right *order of magnitude* and a useful invariant to instrument, not a load-bearing constant.

## Relationship to other analyses

- Complementary to [safer-social-design/](safer-social-design/) (Nagata et al., addictive-design / minor safety). That analysis covers *individual-level* harms (sleep, attention, addiction-like behaviour); this one covers *community-level* dynamics (polarisation, departure, drift). Different mechanisms, both worth designing against.
- Reinforces the generic-core goal: the 10%-floor invariant and bridging score are domain-agnostic graph operations and would apply to any social product built on Trellis, regardless of vertical.

## Suggested next step

If one thing goes forward: prototype the **10%-floor feed invariant** and the **bridging-score Cypher query** against the actual circle data model and see if the assumptions survive contact with the schema. That's a small spike, not a feature commitment.
