# Surveillance Threat Model

**Status:** threat analysis — gap items are roadmap candidates, not committed work
**Created:** 2026-06-04
**Owner:** Richard
**Companions:** [`architecture/09-security.md`](../architecture/09-security.md) (security architecture), [`architecture/07-activitypub.md`](../architecture/07-activitypub.md) (federation), [`architecture/14-graph-and-circles.md`](../architecture/14-graph-and-circles.md) (graph backend)

## What this is

How the commercial surveillance industry extracts data from social platforms,
and what that implies for trellis as a multi-tenant social-network platform
core. Informed by reporting on ISS World Europe 2026 (the surveillance-industry
trade fair) and Meta's 2021 surveillance-for-hire enforcement action.

The threat actors here are not classical attackers. They are vendors selling
"lawful intelligence" platforms to police, intelligence agencies, and — through
the same sales channels — authoritarian regimes. Their products are exhibited
openly, and the extraction channels they use are well documented. A platform
core that powers verticals serving at-risk users (any community, anywhere)
should treat these channels as part of its baseline threat model.

## The four extraction channels

| # | Channel | In one line |
|---|---------|-------------|
| 1 | Scraping / OSINT harvesting | Public profile + social-graph data is free feedstock for AI fusion platforms |
| 2 | ADINT (purchased ad/tracker data) | Data brokers and ad networks sell behavioral data straight into surveillance products |
| 3 | Avatar infiltration | AI-agent-driven fake accounts run social engineering inside the platform |
| 4 | Legal compulsion | Storage jurisdiction decides which states can compel the data |

See [01-threat-landscape.md](./01-threat-landscape.md) for the full picture
with named vendors and precedents.

Beyond data extraction from deployments, **the project itself is assumed to
be a target**: threat-actor orgs monitor public projects, and a platform
core that openly ships anti-surveillance countermeasures gets flagged as an
adversary. The npm packages are already public even while the repo is
private. See [09-public-project-exposure.md](./09-public-project-exposure.md).

## File index

| # | File | Contents |
|---|------|----------|
| | [README.md](./README.md) | This file |
| 1 | [01-threat-landscape.md](./01-threat-landscape.md) | The four extraction channels, named vendors, the Cobwebs precedent |
| 2 | [02-current-posture.md](./02-current-posture.md) | What trellis already does well — and which of those should become stated guarantees |
| 3 | [03-coordinated-inauthentic-behavior.md](./03-coordinated-inauthentic-behavior.md) | Gap: avatar/botnet detection on the graph backend |
| 4 | [04-account-reporting.md](./04-account-reporting.md) | Gap: account-level reporting (only link reports exist) |
| 5 | [05-activitypub-exposure.md](./05-activitypub-exposure.md) | Gap: federation as the scraping front door; enablement preconditions |
| 6 | [06-registration-friction.md](./06-registration-friction.md) | Gap: signup friction in an AI account-farm world |
| 7 | [07-data-minimization.md](./07-data-minimization.md) | Client-metadata storage rule (verified paths) + tenant data residency |
| 8 | [08-implementation-roadmap.md](./08-implementation-roadmap.md) | Phased roadmap; Phase 0 enablers that must land now to make later phases possible |
| 9 | [09-public-project-exposure.md](./09-public-project-exposure.md) | The project itself as a target: no-secrecy design rule, supply chain, maintainer targeting, go-public gate |

## Priority

See [08-implementation-roadmap.md](./08-implementation-roadmap.md). The
short version: the detection features (03) are post-MVP, but they can only
see data that was recorded — so the **Phase 0 schema seams (raw interaction
events, signup metadata, generalized Report model, per-tenant toggles) must
land now**; history not captured cannot be backfilled.

## Quick read path

In 10 minutes: README → 01 → 03 → 08. The remaining files are
self-contained gap analyses, each with file pointers into the codebase.

## Sources

- Erich Moechel, ["ISS World Europe: Ein Eurovision-Contest für Diktatoren"](https://www.golem.de/news/iss-world-europe-ein-eurovision-contest-fuer-diktatoren-2606-209289.html), Golem.de, 2026-06-02.
- Meta, ["Taking Action Against the Surveillance-For-Hire Industry"](https://about.fb.com/news/2021/12/taking-action-against-surveillance-for-hire/), 2021-12 (Cobwebs ban, avatar/social-engineering details).
