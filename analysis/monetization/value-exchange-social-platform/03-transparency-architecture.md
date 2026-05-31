# Transparency Architecture

Transparency is what makes or breaks the concept. If users feel deceived — even once — the entire value proposition collapses. The platform must be radically transparent by design, not as a marketing claim.

---

## Design Principles

### Visible Labeling

Every value action is clearly marked in all contexts where it appears.

- Example label: *"This review was part of [username]'s platform contribution. They chose Brand X freely."*
- Labels are non-removable and rendered by the platform, not the user
- Consistent visual language (icon, color, badge) across all action types
- Labels persist when content is shared or embedded externally

### User Dashboard

Each user has a personal dashboard showing:

- **Contribution history** — every value action they've completed
- **Value generated** — what business value their contributions created (e.g., "Your review was viewed 340 times")
- **Who received it** — which brands benefited from their actions
- **Access balance** — how much platform access they've earned
- **Data footprint** — exactly what data was shared, with whom, and when

### No Dark Patterns

- No hidden data flows between the social layer and the brand layer
- No buried opt-ins or pre-checked consent boxes
- No deceptive framing (e.g., disguising a value action as a social post)
- No asymmetric defaults (the less-commercial option should always be the default)

### Full Intent and Awareness

Users always know:

- What action they're performing
- Why they're performing it (platform access, specific benefit)
- Who benefits from it (which brand, what they'll do with the data)
- What happens if they don't do it (they can pay instead, or lose access after grace period)

---

## Transparency Metrics

Track and publish:

- **Labeling coverage** — % of brand-related content correctly labeled (target: 100%)
- **User comprehension** — survey-based measure of whether users understand the value exchange
- **Dark pattern audits** — regular UX audits by independent reviewers
- **Transparency report** — quarterly public report on brand relationships, data flows, and platform economics

---

## Architectural Separation

The "contribution" space and the "social" space must be architecturally distinct:

- Separate feeds / sections in the UI
- Brand-contribution content does not appear in the social feed unless the user explicitly shares it
- Social connections and brand interactions use separate data models
- No algorithmic blending of social and commercial content

---

## Open Questions

- How do we handle screenshots or external sharing that strips the labeling context?
- Should the transparency dashboard be public (visible to other users) or private?
- How transparent should we be about platform economics (e.g., showing the exact brand payment per action)?
- What's the right balance between transparency and information overload?
