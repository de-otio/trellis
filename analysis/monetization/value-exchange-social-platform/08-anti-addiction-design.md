# Anti-Addiction Design Principles and Metrics

If the platform claims to be non-addictive, it must prove it — with measurable commitments, not just marketing language. This document defines what "non-addictive" means in practice and how to enforce it.

---

## Principles

### 1. Respect Time

- Default session time reminders (opt-out, not opt-in)
- No infinite scroll — feeds have natural endpoints ("You're all caught up")
- No autoplay on videos or stories
- Show time-spent statistics in user dashboard

### 2. Respect Attention

- Notifications are batched and opt-in by default
- No notification sounds or badges for social engagement metrics (likes, follows)
- No "someone viewed your profile" or similar curiosity-gap notifications
- Email digests instead of push notifications where possible

### 3. Respect Autonomy

- No algorithmic feed by default — chronological is the default sort
- Users can opt into algorithmic sorting, but the choice is always visible and reversible
- No A/B testing of engagement-maximizing features without disclosure
- Users can export all their data at any time

### 4. Respect Absence

- No streaks, no "you missed X" messages on return
- No penalty for inactivity (value action credits don't expire rapidly)
- The app never implies the user is missing out
- Re-engagement emails are limited to 1/month maximum

---

## Anti-Addiction Metrics

Track and publish quarterly:

| Metric | Target | Why |
|---|---|---|
| Average daily session time | < 30 min | Users shouldn't spend excessive time |
| % of users with > 2 hours/day | < 5% | Flag potential compulsive use |
| Notification opt-in rate | < 50% | If most users want notifications, they're too enticing |
| Average time to close app after value action | < 5 min | Users should leave after contributing |
| User-reported "feel good about time spent" | > 70% | Subjective wellbeing check |
| Monthly active users who took a 7+ day break | > 30% | Healthy usage includes breaks |

### Red Lines

If any of these metrics are breached for 2+ consecutive quarters, trigger an automatic product review:

- Average session time exceeds 45 minutes
- More than 10% of users exceed 2 hours/day
- User wellbeing score drops below 50%
- Notification opt-in rate exceeds 70%

---

## Design Commitments

- **No dark patterns** — verified by annual independent UX audit
- **No variable reward schedules** — every action has a predictable outcome
- **No social comparison defaults** — follower counts visible only on own profile by default
- **Public transparency report** — quarterly, covering all anti-addiction metrics
- **User advisory board** — regular input from users specifically on wellbeing and addiction concerns

---

## Tension: Engagement vs. Anti-Addiction

The business needs engaged users. The mission demands non-addictive design. These are in tension.

Resolution: Define "healthy engagement" as the target, not "maximum engagement." A user who visits 3-4 times per week for 15 minutes each time, completes a value action monthly, and reports positive sentiment is more valuable than a user who spends 3 hours daily but feels bad about it.

Healthy engagement metrics should be the KPIs, not raw DAU/MAU or time-on-platform.

---

## Open Questions

- Should we cap daily usage time at a hard limit, or just nudge?
- How do we handle users who genuinely want to spend more time (e.g., active community contributors)?
- Should anti-addiction metrics be contractually binding (e.g., in terms of service)?
- How do we prevent future leadership from rolling back these commitments under growth pressure?
