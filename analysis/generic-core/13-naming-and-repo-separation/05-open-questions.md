# Open Questions

## Resolved

1. **Core name** — **Trellis**. Decided 2026-04-05.

2. **npm scope** — `@trellis/*`, private packages published to **AWS CodeArtifact**.
   Decided 2026-04-05.

3. **Licensing** — Private initially. May open-source later. No license decision
   needed until then.

## Still Open

4. **Monorepo vs. polyrepo for Trellis** — After the core is extracted, does
   Trellis keep its Flutter app + extension in one repo, or split those too?
   Current leaning: single repo (small team, shared deploy).

5. **Core API surface** — Should Trellis export a programmatic API (import and
   configure in code) or be a standalone deployable (clone and configure via
   files)? The current architecture leans toward the latter — `server.ts` is
   the entry point, and verticals override config and register extensions.

6. **CodeArtifact setup** — Which AWS account hosts the CodeArtifact domain?
   Same account as Trellis dev, or a separate "shared" account? Need to decide
   before Phase 4.
