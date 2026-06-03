# 06 · External grounding: the ethics of attention

External academic grounding for the whole "healthy by design" thesis — broader
than the IRL primitives, but it directly reframes why they matter.

**Source.** GoodAttention / Salient Solutions Research Groups (2026),
*Social Media Bans and the Ethics of Attention*, policy brief, University of
Oslo (PI Sebastian Watzl; funded by the ERC + Research Council of Norway;
contributors incl. James Williams, *Stand Out of Our Light*).
<https://www.hf.uio.no/ifikk/english/research/projects/goodattention/news/goodattention_final-social-media-bans.pdf>

> The canonical capture of this source (and its general architecture mapping)
> lives in [`analysis/safer-social-design/09-attention-regulation-and-age-limits/`](../../../analysis/safer-social-design/09-attention-regulation-and-age-limits/README.md).
> This file focuses on how the argument bears on the **IRL primitives**
> specifically; it does not re-derive the general mapping.

## The argument (one paragraph)

The age-restriction debate is mis-framed. The problem is not "social media" and
not "mental health" — it is **overwhelming attentional power** concentrated in a
few technology companies, present equally in search, messaging, shopping, and
chatbots. Age bans leave that power intact, *disempower* the already-weak (young
people), and require age-verification that imposes surveillance and privacy
costs — while the mental-health evidence for bans is scant. The harm is broader
than mental health: concentrated attentional power threatens **autonomy,
epistemic justice, the ability to find meaning, social recognition, democratic
participation, and digital sovereignty**. The remedy is **empowerment, not
restriction**: disperse and regulate attentional power and enhance user agency
("cognitive liberty").

## Implications for trellis

### 1. Reframe "healthy" from *mental-health* to *agency / cognitive liberty*

Our design docs (and skybber's `003-safer-social-design`) lean on an
anti-addiction / mental-health frame. The paper argues that frame is empirically
shaky and strategically wrong. The stronger thesis, which trellis should adopt:
**trellis exists to return attentional agency to the user.** The circles model,
`PostRadius`, glance mode, no-engagement-ranking, quiet hours — reframe all of
these as *agency-enhancing*, not *harm-reducing*.

For the IRL primitives specifically: real-life interaction is a route to
**meaning, social recognition, and care** — the goods the attention economy
erodes (the paper cites work tying attention to care and meaning in life). The
"met in person" edge and gatherings are **meaning-restoring**, not merely
"anti-doomscroll." This is the positive content of "healthy."

### 2. Trellis is the paper's recommendation 5.5

Rec 5.5 calls for "public-interest digital infrastructure … public or non-profit
platforms … open and accountable recommendation systems … platforms specifically
designed for children or teenagers." An ad-free, agency-first platform with
transparent ranking *is* that. Worth stating explicitly in the platform's
positioning.

### 3. Federation is the paper's recommendation 5.4

Rec 5.4 (interoperability + user mobility: "switching or leaving platforms
without losing social networks") is exactly what ActivityPub federation
provides. This strengthens the case for keeping federation a **first-class
goal**, not an optional toggle — it is a core part of the agency thesis, not a
nice-to-have.

### 4. The steer: agency + privacy over age-gating + surveillance

The paper is explicitly hostile to age verification and the surveillance it
entails. **Design steer for the IRL work:** the minor-safety defaults for
presence, proximity, and discoverable gatherings (see
[`05-open-questions-and-sizing.md`](05-open-questions-and-sizing.md)) should rest
on **agency, good environment design, and privacy** — *not* on age-verification
or location surveillance. This nudges away from the KOSA-compliance framing
skybber currently uses and toward the exposure-policy / consent model already in
[`../entity-location-subsystem.md`](../entity-location-subsystem.md).

### 5. Validates current choices; names what to avoid and what to add

| Paper's mechanism-level target (§5.1) | Trellis posture |
|---|---|
| Personalized engagement-optimizing ranking | **Already avoided** — recency within relationship tiers, no like/comment/share ranking |
| Micro-targeted / real-time-bidding advertising | **Avoid entirely** — no ad-driven attention market |
| Dark patterns | **Design constraint** — no manipulative patterns; friction is user-controlled (`PostRadius`) |
| Opaque recommenders (§5.2 transparency) | **Go further than today** — make the feed logic observable and contestable: "why am I seeing this" |

## How this folds into the rest of the folder

- Sharpens [`01-thesis.md`](01-thesis.md): the "positive half of healthy" is
  *agency/meaning*, with external academic backing.
- Reframes the wellbeing payoff in [`03-primitives.md`](03-primitives.md):
  reward-the-offline-outcome is agency-/meaning-restoring, and the
  anti-gamification guardrail is an instance of "no dark patterns."
- Adds a design steer to the minor-safety open question in
  [`05-open-questions-and-sizing.md`](05-open-questions-and-sizing.md).
