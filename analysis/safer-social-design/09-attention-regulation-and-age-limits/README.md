# Attention-economy regulation & Trellis design alignment

**Captured:** 2026-06-01

This folder distils an external policy/ethics argument about attention, age
limits, and social-media regulation, maps it onto Trellis's architecture, and
proposes concrete changes. Nothing here mandates an immediate code change; it is
design-direction validation, a few boundary-placement nudges, and a prioritized
suggestions list.

## Sources

Both from the same University of Oslo research groups (GoodAttention / Salient
Solutions; PI Sebastian Watzl):

1. Watzl, *"Age limits on social media are a dead end"* — UiO research news, 2026.
   <https://www.uio.no/english/research/research-news/articles/2026/age-limits-on-social-media-are-a-dead-end.html>
2. GoodAttention / Salient Solutions (2026), *Social Media Bans and the Ethics
   of Attention*, policy brief, University of Oslo (funded by the ERC + Research
   Council of Norway; contributors incl. James Williams, *Stand Out of Our
   Light*).
   <https://www.hf.uio.no/ifikk/english/research/projects/goodattention/news/goodattention_final-social-media-bans.pdf>

(2) is the formal, citable version of (1)'s argument and is the canonical source
capture for this research in the repo.

## One-sentence summary

Age limits are the wrong remedy because they target the wrong layer — the real
problem is concentrated **attentional power**, and the fix is **user empowerment
/ cognitive liberty**, a posture Trellis's federation-first, no-engagement-
ranking, finite-circles shape already embodies and should lean into.

## Topic map

| File | What it covers |
|---|---|
| [`01-the-argument.md`](01-the-argument.md) | The external argument (both sources): why age limits fail, "social media" as the wrong category, harms beyond mental health, empowerment as the goal, the five alternatives |
| [`02-trellis-alignment.md`](02-trellis-alignment.md) | How the argument maps onto Trellis — design-direction validation, the reframe from mental-health to agency, the one transparency gap |
| [`03-suggested-changes.md`](03-suggested-changes.md) | **Concrete suggested changes / additional features**, prioritized, with the age-tier compliance constraint made explicit |

## Compliance note (read before 03)

The age-tier work already in the codebase (`dateOfBirth`, `ageTier`,
`ParentalLink`, `privacy-defaults.ts`) is **likely required for near-term
compliance** (KOSA, EU DSA, AU/EU age laws) and is **not** to be walked back on
the strength of this research. The brief's anti-age-gating argument is a critique
of age-gating *as the primary remedy*, not a licence to skip legally-required
minor protections. The suggestions in [`03`](03-suggested-changes.md) are
**additive** — they shape *how* compliance is met (privacy-preserving assurance,
mechanism-level protection), not *whether* age tiers exist.
