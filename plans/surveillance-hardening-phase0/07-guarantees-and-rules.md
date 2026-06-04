# P7 — Documentation Guarantees & Review Rules

**Recommended model:** Sonnet
**Effort:** ~1 day
**Blocks:** nothing — pure review leverage; do last so it can reference P1–P6 reality
**Branch:** `feat/P7-guarantees-and-rules` off `main`

## Goal

Turn the properties trellis already has (and the rules Phase 0 introduces)
into **written commitments that reviews enforce**: the tracker-free
guarantee, the client-metadata storage rule, the threshold-secrecy rule,
and the go-public gate.

## Design reference

- [`02-current-posture.md`](../../doc/02-technical/surveillance-threat-model/02-current-posture.md) — tracker-free guarantee text
- [`07-data-minimization.md`](../../doc/02-technical/surveillance-threat-model/07-data-minimization.md) — client-metadata rule
- [`09-public-project-exposure.md`](../../doc/02-technical/surveillance-threat-model/09-public-project-exposure.md) — threshold secrecy + go-public gate
- [`08-implementation-roadmap.md §E7/E8`](../../doc/02-technical/surveillance-threat-model/08-implementation-roadmap.md)

## Scope

### In scope

1. **Tracker-free extension guarantee** → extension developer docs:
   `packages/extension-api/README.md` **does not exist yet — create it**
   (plus the Extension Development section of `CLAUDE.md`): extensions
   must not introduce third-party trackers, analytics SDKs, or ad-network
   integrations into server-side request handling. Stated as an extension
   review criterion.
   - Release implication: for npm consumers to see it, the README must be
     in the package tarball (npm includes README by default) **and** a
     new `@de-otio/trellis-extension-api` version must ship
     (`extension-api-v<x.y.z>` tag flow per the `CLAUDE.md` release
     checklist). Don't cut a release for docs alone — ride the next
     extension-api release; until then the criterion is met for
     source-tree readers.
2. **Client-metadata storage rule** → `CLAUDE.md` Development Best
   Practices: client metadata (IP/UA/device identifiers) is stored only
   through a path enforcing anonymization or an explicit retention bound;
   ad-hoc storage alongside domain data is a review blocker. Reference the
   two sanctioned paths (audit composer; SecurityEvent with
   `retentionUntil`).
3. **Threshold-secrecy rule** → `CLAUDE.md` Development Best Practices:
   operational security parameters (rate limits beyond defaults, detection
   thresholds, sampling rates) are runtime config, never compiled-in
   constants — the npm tarball is public.
4. **Go-public gate** → `doc/02-technical/development/` (or
   `00-getting-started/`, match existing structure): the checklist from
   [09 §go-public gate](../../doc/02-technical/surveillance-threat-model/09-public-project-exposure.md#the-go-public-gate)
   as a standalone gate doc, referenced from the threat model rather than
   duplicated — single source, two pointers.
5. **Roadmap bookkeeping**: mark E6/E7/E8 done in
   `08-implementation-roadmap.md`; mark Phase 0 complete if P1–P6 are
   merged.

### Out of scope

- Any enforcement *tooling* (lint rules, CI checks for tracker imports) —
  worthwhile, but a separate proposal; this stage ships the written rules
  reviews point at.
- Executing the go-public gate items (they run if/when visibility flips).

## Acceptance criteria

- [ ] Each of the four rules exists in exactly **one** authoritative place,
      with pointers from the threat-model docs (no near-duplicate texts
      that can drift).
- [ ] `CLAUDE.md` additions are concise (these are agent instructions —
      a rule per bullet, not an essay).
- [ ] Extension docs change is visible to a vertical developer reading
      `packages/extension-api/` without following links into `doc/`.
- [ ] Roadmap statuses updated.

## Test requirements

None (docs). Run a marker grep over every file written in this stage for
internal hostnames/account identifiers before the PR — these docs discuss
security posture and will eventually be public.

## Files to add/modify

| File | Action |
|---|---|
| `packages/extension-api/README.md` | **new** (guarantee; package has no README today) |
| `CLAUDE.md` | modify (two best-practice rules + extension criterion pointer) |
| `doc/02-technical/development/go-public-gate.md` (location per existing structure) | new |
| `doc/02-technical/surveillance-threat-model/08-implementation-roadmap.md` | modify (statuses) |
| `doc/02-technical/surveillance-threat-model/02-current-posture.md`, `07-…`, `09-…` | modify (replace inline rule text with pointers where the authoritative copy moved) |

## Security considerations

The rules themselves are the consideration. One subtlety: phrase the
guarantees as **properties of the core API surface**, not promises about
what verticals do client-side — overpromising in public docs creates
reputational attack surface ([09 §deployment reconnaissance](../../doc/02-technical/surveillance-threat-model/09-public-project-exposure.md)).

## Rollback plan

Docs-only; revert freely.

## Open questions

- Exact home for the go-public gate doc — pick whatever
  `doc/02-technical/development/` actually contains (don't invent a new
  folder if one fits).

## Definition of done

All acceptance criteria checked; merged to `main`. Phase 0 done-definition
(plan README) can be evaluated.
