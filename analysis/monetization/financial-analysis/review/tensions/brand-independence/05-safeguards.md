# Safeguards

What's already designed, what's missing, and what must be added.

---

## Already Designed

These safeguards exist in the current monetization analysis:

### 1. Revenue Diversification (4 Streams)

Brand payments are <50% of total revenue. Three other streams (subscriptions, ambient, B2B tools) provide a floor if brand revenue underperforms. The model survives a 30% brand revenue shortfall at all stages.

**Strength**: Structural. Can't be eroded by individual decisions.
**Weakness**: Only holds if all 4 streams are actively invested in. If subscription or B2B tool development is deprioritized because brand revenue is growing, diversification weakens.

### 2. Concentration Target

No single brand >25% of revenue (Year 2), declining to <10% (Year 5). This is documented in the financial analysis risk section.

**Strength**: Clear, measurable target.
**Weakness**: It's a target, not an enforcement mechanism. Needs automated monitoring and alerts.

### 3. Platform Defines Action Types

Brands cannot propose new action types. The platform determines what forms of value action exist (review, Q&A, survey, recommendation, photo).

**Strength**: Prevents brands from designing actions that serve their interests over user interests.
**Weakness**: Not contractually binding. Could be eroded by informal accommodation ("we'll add this action type to keep Brand X happy").

### 4. Users Choose Brands

Users opt in to brands they like. Brands cannot buy user targeting, algorithmic placement, or promotional visibility.

**Strength**: User agency prevents brand capture of the distribution mechanism.
**Weakness**: "Suggested brands" or "recommended for you" features could be introduced later that subtly favor high-paying brands.

### 5. Platform-Wide Quality Thresholds

Quality scoring is applied identically to all content regardless of which brand it relates to. No per-brand or per-category exceptions.

**Strength**: Prevents brand pressure from lowering quality.
**Weakness**: The quality algorithm itself could be tuned in ways that indirectly favor certain brands (e.g., adjusting what "quality" means for different action types).

---

## Not Yet Designed (Gaps)

### Gap 1: Contractual Editorial Independence

Brand partnership agreements should include a clause stating the platform has sole discretion over:
- Quality standards and thresholds
- Action types and their design
- Content policies and moderation
- Algorithm design and feed curation
- Transparency and disclosure practices

Brands agree to this as a condition of participation. This makes editorial independence a contractual obligation, not just an internal policy that can be quietly changed.

**Priority**: Must be in place before any brand partnership agreement is signed (Phase 2).

### Gap 2: Action Type Neutrality

Currently, `Brand.actionConfig` defines per-type payment rates. This creates a mechanism for brands to indirectly steer user behavior by offering higher rates for preferred action types (e.g., $8 for recommendations, $2 for reviews).

The fix: Users choose which action to perform. The brand budget decrements at the type-specific rate, but the brand cannot set budget caps or allocation preferences across types. The mix is user-driven.

**Priority**: Must be designed into the `ValueAction` completion flow (Phase 2).

### Gap 3: Automated Concentration Alerts

The concentration targets exist as documented policy but have no enforcement mechanism. Need:
- Monthly automated check of single-brand and top-3 concentration
- Yellow alert at thresholds (see [04-quantified-risk.md](04-quantified-risk.md))
- Red alert triggers active diversification
- Dashboard visibility for the founder/team

**Priority**: Can be added in Phase 3 when brand count is growing, but monitoring should start in Phase 2.

### Gap 4: Structural Separation of Editorial and Revenue Decisions

In a solo-founder context, the same person makes editorial decisions (quality thresholds, action types, content policy) and revenue decisions (brand partnerships, pricing, retention). This is a structural conflict of interest.

The fix: Formalize the decision process. When a brand makes a request that touches editorial matters:
1. Document the request
2. Evaluate against platform principles (published, not ad hoc)
3. Document the decision and reasoning
4. Never make the decision in the context of a revenue conversation

This won't eliminate bias, but it creates an auditable process and forces deliberate consideration. As the team grows, the editorial function should be organizationally separate from brand sales.

**Priority**: Process should exist before first brand partnership (Phase 2). Organizational separation when team size justifies it (Year 3+).

### Gap 5: Brand Churn Resilience Fund

No cash reserve policy is documented. Need:
- Minimum cash reserve = 2 months of top-2-brand combined revenue
- Year 2: ~$15K buffer
- Year 3: ~$25K buffer
- Funded from operating surplus, not additional fundraising

**Priority**: Financial planning, not engineering. Should be part of the operating plan from Year 2.

### Gap 6: Transparency About Brand Relationships

The quarterly transparency report (committed to in anti-addiction design) should include brand partnership data:
- Number of active brand partners
- Aggregate brand revenue range (not exact, but enough to assess independence)
- Category diversity of brand partners
- Any brand requests that were declined and why (anonymized)

Users should be able to assess whether the platform is maintaining independence.

**Priority**: Include in the first transparency report (Year 2 Q2).

---

## Safeguard Effectiveness Assessment

| Safeguard | Type | Protects Against | Durability |
|---|---|---|---|
| Revenue diversification | Structural | Revenue dependency | High — requires active investment to maintain |
| Concentration targets | Policy | Single-brand leverage | Medium — needs enforcement mechanism |
| Platform defines actions | Policy | Brand influence on UX | Medium — needs contractual backing |
| Users choose brands | Structural | Brand capture of distribution | High — architectural |
| Quality thresholds | Policy | Quality erosion | Medium — algorithm could be tuned |
| Contractual independence | Contractual | All pressure scenarios | High — legally binding |
| Action type neutrality | Structural | Positive-content steering | High — built into completion flow |
| Concentration alerts | Operational | Creeping concentration | Medium — requires monitoring discipline |
| Editorial/revenue separation | Process | Conflict of interest | Low-Medium — depends on discipline |
| Churn resilience fund | Financial | Revenue shock | Medium — requires financial discipline |
| Brand transparency | Reputational | Perception of capture | Medium — requires honesty |

**The strongest safeguards are structural** (diversification, user choice, action neutrality). These can't be eroded by individual decisions. **The weakest are process-based** (editorial separation, monitoring discipline). These depend on consistent execution and can decay under pressure.

The recommended approach: build the structural safeguards into Phase 2 architecture, add contractual safeguards before first brand partnership, and implement operational safeguards as the brand portfolio grows.
