# Legal and Regulatory Considerations

The value-exchange model sits at the intersection of advertising law, consumer protection, data privacy, and labor law. Getting this wrong doesn't just risk fines — it destroys the trust that the entire model depends on.

---

## FTC Endorsement Guidelines (US)

### Requirements

The FTC requires that **material connections** between endorsers and brands are clearly disclosed. Value actions are unambiguously material connections.

- Every value action shared publicly must include a clear, conspicuous disclosure
- Disclosure must be in the same medium as the endorsement (not buried in a profile or T&C)
- Platform is responsible for ensuring compliance, not just the user
- FTC has specifically targeted platforms that facilitate undisclosed endorsements

### Compliance Approach

- Platform-level labeling (users cannot remove or obscure disclosures)
- Standardized disclosure language reviewed by legal counsel
- Automated monitoring: flag any value-action content that appears without proper labeling
- Regular FTC guideline review (guidelines are updated periodically)

### Risk Level: **Medium**

The model is designed for transparency, which aligns with FTC intent. But any technical failure that strips labels creates liability.

---

## GDPR and EU Data Protection

### Data Flows to Analyze

- User profile data shared with brands (what, when, how much)
- Value action content (reviews, survey responses) — is this personal data?
- Brand interaction history and preferences
- Quality scores and contribution metrics

### Requirements

- **Lawful basis**: Consent for value actions (explicit opt-in per brand). Legitimate interest may apply for platform operations.
- **Data minimization**: Share only what's necessary with brands. Aggregate where possible.
- **Right to erasure**: User can delete value actions and have associated data removed from brand deliverables (where technically feasible).
- **Data portability**: User can export all contribution data.
- **Transparency**: Privacy policy must clearly explain all data flows in plain language.

### DACH-Specific Considerations

- German courts interpret GDPR strictly — err on the side of more consent, not less
- Austrian data protection authority is active in enforcement
- Swiss FADP (Federal Act on Data Protection) has similar but not identical requirements

### Risk Level: **High**

The model involves explicit data exchange with third parties. GDPR compliance must be built into the architecture, not bolted on.

---

## Labor Law Considerations

### The Question

Are value actions "work"? If users are performing tasks in exchange for access (which has monetary value), some jurisdictions might classify this as labor.

### Analysis

- Value actions are voluntary and can be replaced with a monetary payment
- Users set their own schedule and choose their own actions
- There is no employer-employee relationship
- The access credit is not cash compensation

### Precedent

- Loyalty program models (earn points for actions) have generally not been classified as labor
- Platform economy labor cases (Uber, DoorDash) are distinguishable — those involve directed work with time pressure
- The opt-out (pay instead) is the strongest defense against labor classification

### Risk Level: **Low-Medium**

Unlikely to be classified as labor, but the landscape is evolving. The weekly cap and voluntary nature are important safeguards.

---

## Consumer Protection

### Unfair Commercial Practices (EU)

- Value actions must not be misleading to consumers who see them
- The labeling system must meet the standard of "average consumer" understanding
- Aggressive commercial practices (pressure to complete actions) are prohibited

### Advertising Standards

- Some jurisdictions require specific disclosures for user-generated commercial content
- Industry self-regulatory bodies (e.g., ASA in UK, Werberat in Germany) may set additional standards
- Platform should proactively engage with relevant bodies

---

## Tax Implications

### For the Platform

- Brand payments are taxable revenue
- User access credits are likely not tax-deductible expenses (they're access to the platform, not compensation)
- VAT applies to brand payments in the EU

### For Users

- Access credits are likely not taxable income (they're a discount on a service, not earnings)
- If users receive cash payouts (e.g., power user program), those would be taxable
- Tax treatment varies by jurisdiction — need legal opinions per market

---

## Compliance Roadmap

| Priority | Action | Timeline |
|---|---|---|
| P0 | Legal review of value-action labeling against FTC guidelines | Before launch |
| P0 | GDPR data flow mapping and consent architecture | Before launch |
| P0 | Privacy policy and terms of service drafting | Before launch |
| P1 | Labor law opinion in target markets (DE, AT, CH, US) | Before launch |
| P1 | Tax treatment opinion for user credits | Before launch |
| P2 | Engagement with advertising self-regulatory bodies | Within 6 months |
| P2 | Consumer protection review per target market | Within 6 months |

---

## Open Questions

- Should we proactively seek FTC/regulatory guidance before launch (safe harbor approach)?
- How do we handle jurisdictions where the model might be illegal or heavily restricted?
- What's our liability if a user's value action is factually incorrect and harms consumers?
- Should we establish an independent ethics board to oversee the model?
