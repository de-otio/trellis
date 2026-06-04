# P6 — ActivityPub Enablement Preconditions + Authorized-Fetch Spike

**Recommended model:** Sonnet
**Effort:** ~1 day
**Blocks:** nothing in code — gates any future `features.activityPub` enablement
**Branch:** `feat/P6-activitypub-preconditions` off `main` (independent of P1)

## Goal

Two deliverables, no production code:

1. The four federation-hardening preconditions become **blocking enablement
   criteria** in the architecture docs.
2. A research spike answers the one technical unknown — does Fedify support
   authorized fetch (signature-required-on-GET) natively? — so Phase 2's
   AP-hardening estimate is grounded.

## Design reference

- [`05-activitypub-exposure.md`](../../doc/02-technical/surveillance-threat-model/05-activitypub-exposure.md) — the four preconditions + rationale
- [`08-implementation-roadmap.md §E6`](../../doc/02-technical/surveillance-threat-model/08-implementation-roadmap.md)

## Scope

### In scope

1. **Docs**: add an "Enablement preconditions (blocking)" section to
   [`doc/02-technical/architecture/07-activitypub.md`](../../doc/02-technical/architecture/07-activitypub.md):
   authorized fetch, follower/following-list visibility setting, instance
   deny/allow-list, distributed (not in-process) federation rate limiting.
   Phrase as a gate, mirroring the go-public gate pattern: the
   `features.activityPub` flag must not be enabled in any deployment until
   these exist.
2. **Spike** (timeboxed ~half day): against the Fedify version pinned in
   `package-lock.json` —
   - Does Fedify offer a first-class authorized-fetch/secure-mode option
     for actor/collection GETs (check `Federation` builder options, docs,
     and source if needed)?
   - If yes: which option, which Fedify version introduced it, and does
     our currently pinned version have it?
   - If no: sketch the custom middleware seam (where in
     `apps/api/src/lib/routes/activitypub/` GETs would be intercepted;
     inbound-POST signature verification already exists at
     `apps/api/src/lib/activitypub/http-signatures.ts` +
     `apps/api/src/lib/activitypub/listeners/http-signatures.ts` —
     estimate reuse).
   - Estimate (S/M/L) for Phase 2's AP-hardening stage either way.
3. **Spike write-up** appended to
   [`05-activitypub-exposure.md`](../../doc/02-technical/surveillance-threat-model/05-activitypub-exposure.md)
   as a dated "Fedify authorized-fetch findings" section.

### Out of scope

- Implementing any of the four preconditions (Phase 2, triggered by a
  vertical wanting federation).
- Changing Fedify versions.
- Standalone-mode behavior (`standalone-mode.ts`) — unrelated toggle.

## Acceptance criteria

- [ ] `07-activitypub.md` contains the blocking-preconditions section, each
      item linking back to the threat-model rationale.
- [ ] Spike findings section answers the yes/no question with evidence
      (option name + docs/source link, or a definitive "not supported as
      of vX.Y").
- [ ] Phase 2 AP-hardening line in the roadmap updated with the S/M/L
      estimate from the spike.

## Test requirements

None (docs + research). The spike may include a throwaway local probe
(e.g., unsigned GET against a dev instance with a candidate option
enabled) — throwaway code is not committed.

## Files to add/modify

| File | Action |
|---|---|
| `doc/02-technical/architecture/07-activitypub.md` | modify (preconditions section) |
| `doc/02-technical/surveillance-threat-model/05-activitypub-exposure.md` | modify (spike findings) |
| `doc/02-technical/surveillance-threat-model/08-implementation-roadmap.md` | modify (Phase 2 estimate) |

## Security considerations

The docs change *is* the security control: it converts "nobody happens to
have enabled federation" into "federation cannot be enabled without these
controls." Make the language unambiguous — "must", not "should".

## Rollback plan

Docs-only; revert freely.

## Open questions

The spike *is* the open question, by design.

## Definition of done

All acceptance criteria checked; merged to `main`.
