# Generic Core Analysis

Assessment of how well the Trellis architecture supports the goal of a reusable
social-network core with swappable domain extensions.

## Files

### Pre-implementation analysis (01-08)

| File | Topic |
|------|-------|
| [01-current-state.md](01-current-state.md) | Where we started: what's generic, what's coupled |
| [02-schema-assessment.md](02-schema-assessment.md) | Database schema coupling analysis |
| [03-api-coupling.md](03-api-coupling.md) | API layer: routes, handlers, and domain leakage |
| [04-flutter-coupling.md](04-flutter-coupling.md) | Flutter frontend coupling |
| [05-what-already-works.md](05-what-already-works.md) | Abstractions already in place |
| [06-gaps.md](06-gaps.md) | 8 gaps identified — 6 closed, 2 partially closed |
| [07-extension-architecture.md](07-extension-architecture.md) | Proposed extension architecture |
| [08-migration-sequence.md](08-migration-sequence.md) | Recommended order of changes |

### Post-implementation analysis (09-12)

| File | Topic |
|------|-------|
| [09-remaining-coupling.md](09-remaining-coupling.md) | What moved vs what stays in core, and why |
| [10-extension-route-handlers.md](10-extension-route-handlers.md) | Core-wrapped handler pattern for extension routes |
| [11-activitypub-assessment.md](11-activitypub-assessment.md) | AP architecture review: 10 findings, priority order |
| [12-status-and-remaining-work.md](12-status-and-remaining-work.md) | Current status of all gaps + new items |

## Current Status

6 of 8 original gaps are **closed**. 2 are **partially closed** (domain logic
extraction, AP file renaming). The extension boundary, loading mechanism, metadata
validation, lifecycle hooks, follow targetType cleanup, and extension-scoped
configuration are all implemented and tested.

5 new items were identified during implementation. The highest-priority remaining
work is converging AP actor serialization on the Fedify dispatcher and implementing
the core-wrapped extension route handler pattern.

See [12-status-and-remaining-work.md](12-status-and-remaining-work.md) for the
full breakdown and recommended priorities.
