# 04 · What moves from skybber to trellis, and how

This is the actionable part. The inventory in
[`02-current-state.md`](02-current-state.md) shows the platform boundary is
already clean, so "migration" is mostly **build-in-core** + **relocate-docs**,
with very little code actually moving. Every artifact sorts into one of four
buckets.

## The four buckets

### Bucket A — already in core: do nothing

Circles, proximity discovery, relationship scoring + decay, entity-relationship
CRUD, `PostRadius`, sentiment-display, and the presence/location *placeholder*
schema fields. All generic, all in `apps/api/src/lib/**` and `prisma/schema.prisma`.
No action. Listed only so nobody "migrates" what's already here.

### Bucket B — build new, directly in trellis core

| To build | Builds on | Surface for verticals |
|---|---|---|
| **Gathering** entity + RSVP state machine + capacity | location subsystem (`where`), `PostRadius` (visibility) | extension `metadataSchema` + `terminology` registers domain gathering kinds |
| **Presence** handlers (set/clear/query "open to meet") | `stealthMode`/`showOnlineStatus` placeholder fields; DynamoDB TTL | extension supplies activity vocabulary |
| **"Met in person"** graph edge + weight + recommendation input | `scoring-engine.ts`, graph | — (generic) |
| **Outcome-based ranking input** (attendance / met-IRL → feed) | `feed-handler.ts`, scoring | — (generic) |
| **Quiet hours / session-awareness / "you're caught up"** | feed + notification path | per-vertical defaults via config |

These are **net-new code in trellis**, not moved from skybber (skybber has only
design stubs). Tests land in `apps/api/test/` per the project's test pattern.

### Bucket C — relocate / reconcile generic design docs

These are trellis-generic but currently live in skybber's doc tree. The platform
should own its own design rationale.

| Doc | Today | Action |
|---|---|---|
| `plans/003-safer-social-design/` (feed friction, quiet hours, "you're caught up", session limits) | skybber only | **Relocate** to trellis (`doc/02-technical/` or `plans/redesign/`); neutralize any dog examples to placeholders; leave a one-line pointer stub in skybber. |
| `doc/02-technical/architecture/14-graph-and-circles.md` | **duplicated** in skybber *and* trellis | **Reconcile**, don't re-copy. Trellis copy is canonical; skybber keeps a pointer + any dog-specific addenda. The drift between the two copies is exactly the duplication this rule prevents. |
| `doc/.../DATA_MODEL.md` (generic Entity + extension pattern) | skybber | Confirm trellis has the canonical version; if skybber's is richer, fold the generic parts back and leave a pointer. |

**Mechanism for a doc relocation (do this, not a blind copy):**
1. Copy the generic content into the trellis doc tree.
2. Replace any dog/pet examples with neutral placeholders (the doc must read as
   platform docs, not dog docs).
3. In skybber, replace the original with a **one-line pointer** to the trellis
   canonical doc (+ any genuinely dog-specific addendum). Do **not** leave a
   full duplicate — silent duplication is how the two `14-` docs drifted.

### Bucket D — stays vertical: must NOT move

Dog relationship types (`PACK_MATE`, `WALK_BUDDY`, …), the dog discovery-facet
instance, breed signal provider, life-stage, dog metadata schema + terminology,
the "dog shows / adoption days" event framing. These stay in
`skybber/extensions/dogs/**`. When extracting the gathering kernel (bucket B),
**leave the domain framing behind** — it re-attaches via the extension API.

## How code actually crosses the boundary

Skybber consumes trellis as a **published npm package** (`@de-otio/trellis` from
npmjs.org) — *not* a path dependency, submodule, or vendored copy. So a core
change reaches skybber only through the release flow already documented in
`CLAUDE.md`:

```
land code in trellis (apps/api) ──► tag v<x.y.z> ──► publish.yml publishes
@de-otio/trellis to npm ──► skybber bumps its @de-otio/trellis dependency and
deploys from its own repo
```

Two consequences specific to the IRL primitives:

1. **No end-to-end verification in trellis.** Per the deployment-status note,
   trellis isn't deployed standalone; gatherings/presence get exercised end-to-end
   only in skybber's environment after the dependency bump. Plan a skybber-side
   verification pass for each primitive.
2. **Vertical-facing surfaces require an extension-api bump, coordinated with
   skybber.** For verticals to register gathering kinds, presence vocabulary, or
   consume the "met" edge, `@de-otio/trellis-extension-api` gains new types/hooks.
   That is a breaking-change axis: coordinate the bump with skybber (the only
   consumer), per the extension-api coordination note. Caret on `0.x` only
   allows patch — a minor bump to extension-api needs skybber's constraint
   widened in lock-step (Release Checklist).

## Ordered plan

Cheapest-first, each step independently shippable:

1. **Reconcile docs (bucket C).** No code. Relocate `003-safer-social-design`
   to trellis, reconcile the duplicated `14-graph-and-circles.md`, leave skybber
   pointers. Cheap, and it makes the platform own the rationale before any code
   lands.
2. **Build Gathering + Presence in core (bucket B).** Both stand on existing
   substrate (location subsystem, `PostRadius`, placeholder fields, DynamoDB
   TTL). Ship behind a feature flag; no vertical wiring yet.
3. **Extension-api surface (coordinated bump).** Add the types/hooks for
   verticals to register gathering kinds + presence vocab. Coordinate the
   extension-api version bump with skybber.
4. **"Met in person" edge + outcome-based ranking input (bucket B).** The
   research-heavy step (verification approach — see [`05`](05-open-questions-and-sizing.md));
   ship the edge + weight first, ranking input second.
5. **Skybber re-frames its event stub onto the core primitive.** The dog event
   concept becomes terminology + metadata over the core Gathering; the stub doc
   becomes a thin vertical addendum.

## One-line summary of "what moves"

Almost no code moves. **Two primitives get built in core; the generic
healthy-by-design + circles design docs get relocated out of skybber into
trellis; the dog framing stays put** and re-attaches through the extension API.
