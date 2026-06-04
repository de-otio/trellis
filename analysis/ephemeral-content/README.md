# Ephemeral Content for Social Platforms

## Feature Analysis: User-Controlled Content Sunset

This analysis covers how to give users a practical "off-switch" for old content using access control, with encryption as a deferred enhancement. It is a domain-agnostic core-platform design; a consuming application wires it to its own content models, media pipeline, and client UI.

## Decision Log

- **Encryption deferred** -- Access control (visibility flags + query filters) delivers the full feature against the identified threat model. Encryption can be layered on later if needed. See [Encryption vs Access Control](13-encryption-vs-access-control.md) for the full analysis.
- **Owner-retained access adopted** -- Sunset hides content from others but the author keeps access via a private Archive view. See [Owner-Retained Access](10-owner-retained-access.md).

## Documents

### Core Design

1. [Problem Statement](01-problem-statement.md) -- The "forever" problem and core user need
2. [Proposed Solution](02-proposed-solution.md) -- Access-control-based content sunset
3. [Threat Model](03-threat-model.md) -- What this addresses and accepted risks
4. [Strategic Compromises](05-strategic-compromises.md) -- Design trade-offs and rationale
5. [Supporting Infrastructure](06-supporting-infrastructure.md) -- Cache control and UX requirements
6. [Implementation](07-implementation.md) -- Data model, queries, media, and auto-sunset
7. [Open Questions](08-open-questions.md) -- Unresolved design decisions
8. [Ephemeral Comments](09-ephemeral-comments.md) -- Comments on other users' content with independent sunset control

### Research and Background

9. [Prior Art](04-prior-art.md) -- Ephemerizer, Vanish, proxy re-encryption, and more
10. [References](99-references.md) -- Academic and industry sources
11. [Owner-Retained Access](10-owner-retained-access.md) -- Investigation: owner access + ephemerality
12. [Media Strategy](media-strategy/) -- How sunset works for photos and videos (4 approaches evaluated)
13. [Encryption vs Access Control](13-encryption-vs-access-control.md) -- Why encryption is deferred

### Archived (Encryption-Era Analysis)

These documents were written when encryption was the proposed approach. They are retained for context but no longer reflect the current design.

- [key-granularity/](key-granularity/) -- DEK granularity analysis (superseded by access-control approach)
