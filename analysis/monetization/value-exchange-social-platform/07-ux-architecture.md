# UX Architecture and Interaction Design

The UX must make the value exchange feel natural and fair, not transactional or exploitative. The core challenge is designing two distinct spaces — social and contribution — that coexist without contaminating each other.

---

## Dual-Space Architecture

### Social Space

The primary experience. This is where users interact with their dog-fan community.

- Feed of posts, photos, stories from followed users
- Discovery features (explore, trending, nearby)
- Direct messaging and group features
- Profile pages, followers, following
- **No brand content unless explicitly shared by users**

### Contribution Space

A separate section where users perform value actions.

- Accessed via a dedicated tab or section (not embedded in the social feed)
- Shows available value actions from brands the user has opted into
- Clear display of credit earned and access balance
- Action completion flow with quality prompts

### The Boundary

- Visually distinct: different color scheme, layout, or navigation treatment
- Contribution content only crosses into the social feed when a user explicitly shares it
- When shared socially, it carries its transparency label (see [03-transparency-architecture.md](03-transparency-architecture.md))
- The social feed algorithm has no knowledge of brand interaction data

---

## Key User Flows

### Onboarding

1. Sign up as a social user (normal social onboarding)
2. After initial engagement, introduce the value-exchange concept
3. User chooses: subscribe monthly OR explore value actions
4. If value actions: browse available brands, opt into ones they genuinely like
5. Complete first value action with guided walkthrough

### Performing a Value Action

1. Navigate to Contribution Space
2. See available actions from opted-in brands (sorted by relevance, not urgency)
3. Select an action (e.g., "Review your experience with [Product]")
4. Complete the structured input (guided prompts, not freeform)
5. See credit earned immediately
6. Optional: share the contribution to your social feed (with label)
7. Return to social space

### Checking Your Balance

1. Dashboard shows: credits earned, access expiry date, contribution history
2. Clear visual: "You're covered through [date]"
3. If running low: gentle nudge with available actions (not urgent notifications)
4. Never locked out abruptly — grace period with clear communication

---

## Design Principles

- **Social-first**: The social experience must be excellent on its own. Value actions are the payment method, not the product.
- **Contribution as a choice, not a chore**: The Contribution Space should feel like a brief, optional detour, not a tollbooth.
- **No urgency mechanics**: No countdown timers, no "act now" prompts, no scarcity framing.
- **Progressive disclosure**: New users see the social product first. The value-exchange layer is introduced gradually.

---

## Open Questions

- Should the Contribution Space be a separate app/tab, or an overlay within the main app?
- How do we handle the UX when a user's access is about to expire and they haven't contributed?
- What's the right information density for the Contribution Space — minimal (like a to-do list) or rich (like a marketplace)?
- How do we design the "share to social feed" flow so it feels natural, not performative?
