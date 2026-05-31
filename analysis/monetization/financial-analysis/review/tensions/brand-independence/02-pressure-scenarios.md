# Pressure Scenarios

Four concrete scenarios of how brand pressure could manifest. Each describes the scenario, the temptation, and the structural safeguard needed.

---

## Scenario 1: Pressure on Quality Standards

**Setup**: A major pet food brand pays $10K/month for value actions. Their product review scores average 3.2/5. The platform's quality threshold requires 2.5/5 minimum, but many of this brand's reviews are flagged as "low effort" by the quality scoring algorithm, meaning they don't count as completed actions and don't generate revenue.

**The pressure**: The brand complains that 30% of their reviews are being filtered. They say the quality bar is too high for their product category ("pet food reviews are naturally short — 'my dog loves it' is a valid review"). They signal they'll reduce their monthly budget if the filtering rate doesn't improve.

**The temptation**: Lower the quality threshold for food-category reviews. It's easy to justify: "food reviews ARE naturally shorter than, say, harness reviews." The immediate revenue impact of losing a $10K/month partner is concrete; the trust erosion from lower-quality reviews is diffuse.

**Why it's dangerous**: Once you create per-category exceptions, every brand has a reason why their category is special. The exception becomes the rule. Users notice that food reviews are lower quality and lose trust in all reviews.

**Structural safeguard**: Quality thresholds must be platform-wide and brand-agnostic. No per-brand exceptions. No per-category exceptions. The quality scoring algorithm is calibrated once, applied everywhere. This should be contractual — part of the brand partnership agreement — not just internal policy.

---

## Scenario 2: Pressure on Action Design

**Setup**: A successful brand partner proposes a new value action type: "Share this product to your social feed." They're willing to pay $8 per share — double the rate for reviews. The action crosses the architectural boundary between Contribution Space and social feed, but the brand frames it as "user-initiated sharing" (users choose to share).

**The pressure**: The economics are compelling. $8/action at scale could significantly boost Stream 2 revenue. The brand is enthusiastic and willing to increase their monthly budget. Other brands express interest in the same action type.

**The temptation**: Frame it as consistent with the transparency architecture: "The share is clearly labeled, the user initiates it, and it appears with full disclosure." Technically true. But it blurs the boundary between the social space and the commercial space — the exact contamination risk identified in the tensions analysis.

**Why it's dangerous**: Once brand content can be pushed into the social feed via any mechanism, the dam breaks. Other action types follow: "Share a recommendation," "Post about your experience," "Create content featuring our product." The social feed gradually fills with commercially motivated content, even if each piece is labeled.

**Structural safeguard**: The platform defines which action types exist. Brands cannot propose new types. New action types require a design review against the transparency principles before launch. Specifically: no action type should result in content appearing in the social feed as a primary effect. Users can always share their contributions voluntarily, but no action type should be designed with sharing as the completion criteria.

---

## Scenario 3: Pressure Toward Positive-Only Content

**Setup**: Brands want reviews, but they really want positive reviews. The transparency architecture prevents them from explicitly requesting positive content. But brands discover they can signal their preference indirectly.

**The mechanism**: Brands request to focus their value-action budget on "endorsed recommendation" actions ($3-8 per post) rather than "product review" actions ($2-5 per review). Recommendations are structurally biased toward positive content — you don't recommend something you dislike. If brands can steer budget toward recommendation-type actions, the overall content mix shifts positive without any explicit rule being broken.

**The pressure**: A brand says "We'd like to allocate 80% of our budget to recommendations and 20% to reviews." This seems reasonable — they value recommendations more. But the effect is to suppress honest reviews in favor of positive endorsements.

**The escalation**: Other brands follow suit. The platform's "authentic reviews" become an afterthought because the economic incentive points toward recommendations. Users notice that value-action content is overwhelmingly positive and lose trust.

**Why it's dangerous**: No single rule is broken. Each brand's preference is individually reasonable. But the aggregate effect undermines the core value proposition: authentic, honest user contributions.

**Structural safeguard**: Brands cannot cherry-pick action types. If a brand participates in the value-exchange system, their budget covers all action types that users choose. The allocation across action types is user-driven: if 60% of users choose to write reviews and 40% choose to recommend, that's the split. The brand pays for whatever users do, at the type-specific rate.

**Implementation**: `Brand.actionConfig` should define the per-type payment rate, but NOT an allocation cap or preference. The `ValueAction` completion flow presents all available action types to the user; the user picks. Brand budget decrements regardless of type.

---

## Scenario 4: Revenue Concentration Creates Veto Power

**Setup**: In Year 2, the platform has 35 brand partners. The top 3 (a major pet food company, a pet insurance provider, and a veterinary chain) represent 55% of total brand revenue — about $20K/month combined. Total platform revenue is $41K/month.

**The crisis**: The pet food company (largest partner, $8K/month) announces they're pausing their budget for Q3 due to internal restructuring. Revenue drops to $33K/month — below the $35K needed for comfortable operations.

**The pressure**: The remaining two major brands now know their leverage. Even without saying anything, the platform's decisions are influenced by "we can't afford to lose [insurance provider] too." Product decisions, quality thresholds, action types — everything gets filtered through "how will our top partners react?"

**Why it's dangerous**: Concentration risk doesn't require bad actors. Even well-intentioned brands benefit from the platform's fear of losing them. The structural dynamic distorts decision-making regardless of intent.

**Structural safeguards**:

1. **Concentration monitoring**: If any single brand exceeds 20% of total brand revenue, flag for review. If any brand exceeds 30%, actively recruit competitive brands to diversify. Track this quarterly.

2. **Pipeline diversification**: Maintain a pipeline of prospective brand partners in each category. If the top food brand churns, there should be 3 food brands ready to onboard. Self-serve brand portal (Year 2) helps.

3. **Cash reserve**: Maintain enough cash to survive the loss of the top 2 brand partners simultaneously. In Year 2, this means ~$15K buffer. Small but essential.

4. **Revenue stream balance**: Actively invest in subscription and B2B tool revenue. If brand revenue grows faster than other streams, that's a warning sign, not a success metric. The target is <50% from any single stream.

---

## Pattern Across All Scenarios

Every scenario follows the same structure:

1. A brand requests or signals a preference that would increase their ROI
2. Accommodating the preference is individually reasonable and immediately profitable
3. The accommodation slightly erodes a core platform principle (quality, separation, authenticity, independence)
4. The erosion is individually small but compounds over time
5. The long-term result is a platform that serves brands more than users

**The defense is always structural, not intentional.** Good intentions don't prevent drift. Contractual commitments, monitored metrics, and architectural constraints do.
