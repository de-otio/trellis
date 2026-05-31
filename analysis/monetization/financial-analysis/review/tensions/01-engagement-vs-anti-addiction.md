# Tension 1: Engagement Incentives vs. Anti-Addiction Design

**Risk level**: Low — but requires ongoing vigilance as the monetization system matures.

---

## The Structural Forces

The monetization model needs engaged users. Engaged users generate more value actions, more brand revenue, higher retention, and better unit economics. Every financial metric improves when users spend more time and attention on the platform.

Trellis's core identity is the opposite: "Designed for Wellbeing." The platform has measurable, public anti-addiction commitments including session time targets (<30 min average), red-line thresholds that trigger automatic product review, and a ban on variable reward schedules.

These forces are inherently in tension. The question is not whether the tension exists, but whether the safeguards are strong enough to prevent drift toward engagement maximization.

---

## Where the Monetization Model Creates Engagement Pressure

### Premium Unlock Progress

"You're 2 actions away from free premium this month" is a progress indicator. It's designed to be motivating, not punitive — no streaks, no "you missed X" messaging. But it is, structurally, an engagement mechanic. It gives users a reason to come back and complete actions before the month ends.

**How it could escalate**: Product pressure to lower the unlock threshold ("if we make it 2 actions instead of 4, more users will hit it, participation rates go up") or to add urgency ("only 3 days left to earn premium").

**Current safeguard**: The anti-addiction design doc bans countdown timers and urgency framing. But there's no explicit commitment about the unlock threshold — it could be lowered to the point where it becomes trivially easy, creating a different kind of engagement pressure ("complete one quick action to stay premium" every month becomes a micro-habit loop).

**Additional safeguard needed**: Set a minimum unlock threshold (e.g., at least 3 substantive actions/month) and commit to not lowering it below that floor. The floor ensures that premium unlock requires genuine contribution, not a trivial habit.

### Quality Badges and Contribution Tiers

The gamification doc describes Bronze/Silver/Gold tiers based on cumulative contribution quality, plus quality badges for consistently helpful content. These are cosmetic-only and have no decay.

**How it could escalate**: Adding tier decay ("you drop from Gold to Silver if you don't contribute this quarter") or functional benefits to tiers ("Gold contributors get featured in the brand directory").

**Current safeguard**: "No decay — once earned, a tier is kept." This is stated in the gamification doc. But functional benefits are not explicitly prohibited.

**Additional safeguard needed**: Explicitly state that tiers and badges never provide functional advantages (priority placement, algorithmic boosting, better brand matching). If tiers ever provide functional benefits, they become engagement drivers, not recognition.

### Notification Design for Value Actions

The platform commits to batched, opt-in notifications with no push for social engagement. But value-action reminders ("Brand X has a new action available") are a different category — they're transactional, not social.

**How it could escalate**: "Hey, you're 1 action away from premium — Brand X just posted a quick survey!" becomes a notification that's technically transactional but functionally an engagement nudge.

**Current safeguard**: The anti-addiction doc says notifications are "opt-in and batched." But it doesn't explicitly cover value-action notifications.

**Additional safeguard needed**: Value-action availability notifications must follow the same rules as social notifications: opt-in, batched (weekly summary at most), no urgency framing, no push notifications. The premium-unlock progress should only be visible when the user is in the Contribution Space, not surfaced via notifications.

---

## Why the Risk Is Currently Low

1. **Measurable commitments exist**: The anti-addiction metrics (average session <30 min, <5% of users >2 hours/day, wellbeing score >70%) are concrete and published. If the gamification layer triggers these thresholds, the platform is contractually obligated to review.

2. **No variable rewards**: Every action has a known, fixed credit value. There's no slot-machine mechanic. The "2 actions away" progress is deterministic, not variable.

3. **The unlock is monthly, not daily**: Premium unlock resets monthly, not daily. This means users visit the Contribution Space a few times per month, not every day. Monthly cadence is inherently less addictive than daily.

4. **The paid alternative exists**: Users who find the progress mechanic stressful can just pay $6.99/month. The existence of a paid opt-out prevents the gamification from feeling coercive.

5. **Contribution Space is architecturally separate**: The engagement pressure is confined to the Contribution Space. The social feed — where users spend most time — has no monetization mechanics.

---

## Escalation Scenarios

### Scenario A: "Engagement Creep" (Gradual)

Over 2-3 years, small changes accumulate: unlock threshold lowered from 4 to 2 actions, tier benefits added ("Gold contributors appear first in brand search"), value-action reminders become push notifications. No single change crosses a red line, but the cumulative effect transforms the Contribution Space into an engagement-optimized product.

**Prevention**: Annual independent UX audit (already committed to) must specifically evaluate the Contribution Space engagement pressure, not just the social feed. Add "Contribution Space engagement intensity" as a tracked metric.

### Scenario B: "Revenue Pressure" (Crisis-Driven)

A revenue shortfall (brand partner churn, lower-than-expected participation) creates pressure to boost engagement. The temptation is to add urgency, notifications, or streak-like mechanics to increase value-action completion rates.

**Prevention**: The anti-addiction red lines must be treated as constraints, not targets. If revenue is low, the answer is more brands or better premium features — not more aggressive engagement mechanics. This needs to be an explicit principle: "We will never solve a revenue problem by increasing engagement pressure."

### Scenario C: "Metric Manipulation" (Subtle)

The anti-addiction metrics use averages (<30 min average session time). Averages can be gamed: if most users spend 5 minutes but power users spend 3 hours, the average looks fine. The median might tell a different story.

**Prevention**: Track both mean and median session time. Report both in the transparency report. Add a distributional metric: "% of users with >60 min daily usage" alongside the average.

---

## Recommended Commitments

1. **Minimum premium unlock threshold**: At least 3 substantive actions/month. Cannot be lowered below this floor.
2. **No functional tier benefits**: Contribution tiers and badges are cosmetic only, forever.
3. **Value-action notifications follow social notification rules**: Opt-in, batched, no push, no urgency framing.
4. **Premium-unlock progress visible only in Contribution Space**: Never surfaced in the social feed, never in push notifications.
5. **Annual UX audit includes Contribution Space**: Evaluate engagement pressure specifically, not just social feed.
6. **Revenue problems are never solved by increasing engagement pressure**: Explicit principle, documented in the anti-addiction design.
7. **Track median session time alongside mean**: Prevent average-hiding-outliers manipulation.
