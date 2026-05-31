# Tensions and Risks

Every model has failure modes. These are the ones most likely to undermine the value-exchange concept, along with mitigation strategies.

---

## Brand Pressure Drift

**Risk**: Over time, brands pressure for higher-volume, lower-quality actions. The platform gradually becomes "do tasks for corporations" rather than a genuine social space.

**Signals**:
- Brands requesting more actions per user per week
- Average action quality scores declining
- Users describing the platform as "work" in feedback

**Mitigation**:
- Hard cap on value actions per user per week (enforced at platform level, not brand level)
- Minimum quality threshold — actions below the threshold don't count for brand or user
- Editorial guardrails: platform defines what action types exist, not brands
- Contractual limits on brand influence over action design
- Regular user sentiment surveys with published results

---

## Feed Contamination

**Risk**: If brand-contribution content mixes into users' social feeds, it erodes trust even with labeling. Users start to feel that every post might be commercially motivated.

**Signals**:
- Users reporting that their social feed feels "ad-heavy"
- Declining engagement with non-commercial social content
- Trust survey scores dropping

**Mitigation**:
- Architectural separation: contribution space and social space are distinct sections
- Brand content never appears in the social feed unless a user explicitly chooses to share it
- Separate data pipelines — the social algorithm never sees brand interaction data
- Regular UX audits to ensure the boundary remains clear

---

## Adoption Chicken-and-Egg

**Risk**: Brands won't pay without users; users won't join without a functioning social layer. The platform can't bootstrap either side independently.

**Mitigation strategies** (see also [10-go-to-market.md](10-go-to-market.md)):
- **Seed with paid users**: Launch with a small subscription fee, building the social layer first. Add value-exchange later as an alternative to paying.
- **Founding brand partnerships**: Pre-negotiate with a small number of brands willing to take the risk in exchange for exclusivity or favorable terms.
- **Community-first approach**: Build the dog-fan social community with Trellis's existing user base before introducing the value-exchange layer.

---

## Quality Degradation

**Risk**: Users game the system with low-effort contributions to earn credits as fast as possible.

**Signals**:
- Average review length or helpfulness ratings declining
- High volume of actions flagged as low quality
- Brands reporting declining value from contributions

**Mitigation**:
- Quality scoring with minimum thresholds
- Peer review / helpfulness voting on contributions
- Diminishing credit returns for rapid-fire submissions
- Human review sampling for calibration

---

## User Perception of Exploitation

**Risk**: Despite transparency, users may still feel exploited — "I'm doing free labor for corporations."

**Mitigation**:
- Clear framing: users are exchanging value, not donating labor
- Visible, understandable economics: show what the brand pays, what the platform keeps, what the user earns
- Always offer a paid alternative — the existence of a price tag proves the exchange is fair
- User control: users choose brands, action types, and frequency. Nothing is assigned.

---

## Regulatory Risk

**Risk**: Regulators classify value actions as undisclosed advertising or paid endorsements, triggering FTC/GDPR violations.

**Mitigation**: See [09-legal-and-regulatory.md](09-legal-and-regulatory.md) for detailed analysis.

---

## Open Questions

- What's our "red line" — at what point do we refuse brand money to protect the model?
- How do we handle a brand that's popular with users but ethically problematic?
- What happens if the value-exchange model doesn't generate enough revenue — do we add ads, or accept slower growth?
- How do we prevent brands from creating fake user accounts to generate favorable value actions?
