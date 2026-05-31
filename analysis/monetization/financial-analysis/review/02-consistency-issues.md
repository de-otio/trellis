# Consistency Issues

Internal contradictions, orphaned concepts, and unresolved splits across the monetization document set.

---

## Issue 1: Unresolved Conceptual Split (High Severity)

### The Problem

The docs contain two fundamentally different earning models that are presented as an "evolution" but never clearly reconciled:

| | Docs 01-06: Value Exchange | Doc 11: Universal Micro-Influencer |
|---|---|---|
| Who earns | Users who opt in and perform defined actions | Every adult user, automatically |
| Entry | Explicit opt-in per brand | Auto-enrolled, opt-out available |
| Value source | Submitted actions (reviews, Q&A, surveys) | Ambient activity (any post featuring a product) |
| Cap | Weekly cap on actions | No cap mentioned for ambient |
| Mental model | "I contribute for access/income" | "I use the app and earn from it" |

The financial model quietly blends both: Stream 2 (explicit actions, 46% of revenue) and Stream 3 (ambient attribution, 15% of revenue). But the conceptual docs don't explain that these are two complementary layers of a single system.

### Impact

A reader of docs 01-06 alone gets one story. A reader of doc 11 gets a different one. Neither explains the composite model that the financial analysis actually projects.

### Fix Needed

A short "model evolution" document in `value-exchange-social-platform/` that states:
- The model has two layers: voluntary explicit actions (primary, launched Phase 2) and ambient attribution (secondary, launched Phase 4)
- Docs 01-06 describe Layer 1; doc 11 describes the vision for Layer 2
- The financial analysis in `financial-analysis/` models both layers together
- Layer 2 (ambient) is deferred and optional — the model is viable without it

---

## Issue 2: Social Recognition Feature Never Designed (Medium Severity)

### The Problem

`financial-analysis/02-revenue-model.md` states that 20% voluntary participation is credible because of "three simultaneous incentives: cash, feature unlock, **social recognition**."

Social recognition for contributors is never designed:
- Not in `value-exchange-social-platform/04-gamification.md` (focuses on credits, badges, tiers)
- Not in `value-exchange-social-platform/07-ux-architecture.md` (no UX treatment)
- Not in `financial-analysis/implementation/` (no API endpoints)

### Impact

A key assumption supporting the model's most important variable (participation rate) depends on a feature that exists only as a phrase in one document.

### Fix Needed

Either:
- Design the social recognition feature (contributor profiles, visible contribution badges, community recognition)
- Or remove it as an assumption and re-evaluate whether 20% is still credible with only two incentives (cash + feature unlock). Cashback platforms achieve 20-40% with cash alone, so the assumption may still hold.

---

## Issue 3: Annual Pricing Orphaned (Low Severity)

### The Problem

`financial-analysis/02-revenue-model.md` mentions "$59.99/year ($5.00/month effective) provides a ~28% discount and reduces churn."

This is never modeled:
- All projections in `04-financial-projections.md` use $6.99/month
- All ARPPU calculations in `03-unit-economics.md` use $6.99
- All churn models assume monthly subscription

### Impact

If annual pricing is offered (it should be — it reduces churn by 30-50%), the blended ARPPU will be lower than projected. Not a crisis, but the projections are slightly optimistic.

### Fix Needed

Either model annual pricing in projections (add a % annual vs. monthly split) or remove the mention and add it as a future pricing optimization.

---

## Issue 4: Earnings Spectrum Mismatch (Low Severity)

### The Problem

Doc 11 (universal micro-influencer) describes an earnings spectrum:
- Casual user: $0.50-2/month
- Active member: $2-15/month
- Popular creator: $15-100/month
- Major influencer: $100-1,000+/month

The financial model in `02-revenue-model.md` calculates earnings differently:
- Platform earns $1.40-10.00 per contributor/month (based on actions × payment × take rate)

These don't directly correspond because doc 11 includes ambient earnings and reach-based income, while doc 02 is purely action-based.

### Impact

Illustrative, not structural. But creates confusion about what users should actually expect to earn.

### Fix Needed

Note in doc 11 that the earnings spectrum is aspirational (including Phase 4 ambient attribution) and that initial earnings will follow the action-based model in the financial analysis.

---

## Issue 5: Superseded Doc Still Findable (Low Severity)

### The Problem

`value-exchange-social-platform/06-revenue-model.md` describes the original two-stream model (access credits, not cash). It has a "superseded" note at the top, but:
- It still describes "access credits" not "real money"
- It still shows only 2 revenue streams, not 4
- A reader navigating the value-exchange directory will find it and may not notice the small note

### Fix Needed

The superseded note is sufficient. No further action needed, but the "model evolution" document (Issue 1 fix) would help orient readers.
