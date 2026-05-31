# Industry Precedent

What happened when other platforms faced the same structural tension between revenue source dependency and editorial independence.

---

## The YouTube Adpocalypse (2017, 2019)

### What Happened

YouTube's creator ecosystem nominally serves creators and viewers. But advertisers are the primary revenue source (~80% of Google's revenue comes from advertising). In 2017, major advertisers (P&G, Coca-Cola, Verizon) discovered their ads were running alongside extremist and hateful content.

### The Response

YouTube demonetized millions of videos, changed recommendation algorithms, altered content policies, and created a "brand safety" tier system — all driven by advertiser pressure, not user or creator needs. Creators who made family-friendly content were caught in blanket demonetization. The algorithm shifted toward "advertiser-safe" content, suppressing edgy but legitimate content.

### The Structural Lesson

YouTube had no mechanism to resist advertiser pressure because advertisers were ~100% of its revenue. When advertisers said "fix this or we pull our budgets," YouTube had no alternative revenue to fall back on. The result was content policy driven by advertiser comfort, not viewer or creator value.

### Relevance to Trellis

Trellis's brand revenue is 46% of total, not 100%. This is meaningfully different — losing all brand revenue would hurt but not kill the platform (other streams cover costs at scale). However, 46% is still enough to create significant pressure, especially in Year 2 when brand count is low.

**Key takeaway**: Revenue diversification is the single most important structural defense against this dynamic. Trellis must actively maintain the 4-stream balance rather than letting brand revenue grow unchecked.

---

## The Yelp Review Manipulation Allegations

### What Happened

Yelp has faced persistent allegations (which it denies) that businesses can influence their review visibility through advertising relationships. The specific claims: businesses that advertise on Yelp see negative reviews suppressed; businesses that don't advertise see negative reviews promoted. Yelp commissioned an independent study (Harvard Business School, 2011) that found no evidence of manipulation.

### The Structural Lesson

Whether Yelp actually manipulates reviews is irrelevant to the structural lesson. The *perception* of manipulation exists because Yelp's revenue comes from the same businesses whose reviews it curates. The structural conflict creates suspicion even when behavior is ethical. Yelp cannot prove a negative — any time a negative review is filtered by its quality algorithm, some business owners believe it was advertising-related.

### Relevance to Trellis

Trellis's value-exchange model has the same structural conflict: brands pay the platform, and the platform curates content about those brands (reviews, Q&A, recommendations). Even if quality standards are applied fairly, the perception of brand favoritism is inevitable.

**Key takeaway**: Transparency is the only defense against perception problems. Trellis must publish its quality scoring methodology, make filtering decisions auditable, and show users exactly which content was filtered and why. The transparency dashboard already planned for users should extend to showing "X of your reviews were below quality threshold" with the specific scores.

---

## The Facebook News Feed Algorithm (Ongoing)

### What Happened

Facebook's News Feed algorithm was originally designed to show users content they'd find interesting. Over time, it was optimized to maximize engagement (time on platform), which maximized ad impressions, which maximized revenue. The result: the algorithm promoted outrage, misinformation, and divisive content because that content generated the most engagement.

### The Structural Lesson

Facebook didn't set out to promote misinformation. The algorithm optimized for the metric that correlated with revenue (engagement = ad impressions = revenue). No human decided "show more outrage" — the structural incentive did it automatically.

### Relevance to Trellis

Trellis's value-exchange model doesn't have the same engagement = revenue dynamic (value actions have a weekly cap, and revenue is per-action not per-impression). But if ambient attribution (Phase 4) is implemented, a similar dynamic could emerge: content that generates more brand impressions is more valuable, creating an incentive to surface brand-adjacent content in the social feed.

**Key takeaway**: The architectural separation of social and contribution spaces is a critical structural defense. It prevents the feed algorithm from optimizing for brand value. This separation must be absolute — the social feed algorithm must never have access to brand interaction data.

---

## Patreon's Creator-Platform Tension (2017-2023)

### What Happened

Patreon takes 5-12% of creator revenue as a platform fee. In 2017, Patreon changed its fee structure to shift transaction costs from creators to patrons, causing patron backlash and creator churn. In 2023, Patreon launched new tools that some creators felt prioritized Patreon's growth over creator needs (e.g., features that gave Patreon more visibility into creator audiences).

### The Structural Lesson

Even platforms designed to serve creators gradually prioritize platform revenue over creator interests. The take-rate model creates a structural incentive to maximize transaction volume, which can conflict with creator preferences for quality over quantity.

### Relevance to Trellis

Trellis's 35% take rate on brand payments creates a similar incentive: more value actions = more platform revenue. This could lead to:
- Lowering quality thresholds to increase completed actions
- Adding more low-effort action types (quick ratings, one-click endorsements)
- Pressuring users to complete more actions

**Key takeaway**: The weekly action cap is a structural defense. It limits the platform's revenue extraction per user regardless of how many brands are available. The cap should be treated as a commitment, not a variable to optimize.

---

## The Brave Browser Model (Positive Example)

### What Happened

Brave blocks third-party tracking and ads by default, then offers opt-in Brave Ads where users earn BAT tokens for viewing privacy-respecting ads. Advertisers pay for attention, but users control the exchange entirely: opt-in, choose frequency, can cash out or donate.

### The Structural Lesson

Brave maintained its privacy-first positioning while building an advertising business because:
1. User control is absolute (opt-in, adjustable, opt-out anytime)
2. No data is shared with advertisers (matching happens locally)
3. The business model doesn't require surveillance
4. Revenue from ads is supplementary, not primary (Brave also earns from search deals)

### Relevance to Trellis

Brave is the closest structural analogue to Trellis's value-exchange model. Both:
- Replace traditional advertising with user-controlled commercial participation
- Pay users for their attention/contribution
- Maintain independence through user control and revenue diversification
- Make transparency a product feature, not just a policy

**Key takeaway**: Brave demonstrates that a user-controlled, transparent commercial exchange can coexist with a privacy/independence-first brand. The key is that user control must be genuine and the platform must accept lower revenue as the cost of maintaining principles.

---

## Synthesis

| Platform | Revenue Dependency | Outcome | Lesson for Trellis |
|---|---|---|---|
| YouTube | 100% advertisers | Content policy driven by advertiser comfort | Diversify revenue; never let one stream exceed 50% |
| Yelp | ~100% businesses | Perception of manipulation (regardless of reality) | Publish quality scoring; make filtering auditable |
| Facebook | 100% ad impressions | Algorithm optimized for engagement, not user value | Keep social feed algorithm isolated from brand data |
| Patreon | Take rate on transactions | Platform incentives drift from creator interests | Weekly action cap limits revenue extraction; treat as commitment |
| Brave | Supplementary ad revenue | Privacy-first brand maintained alongside ad business | Accept lower revenue as cost of maintaining principles |
