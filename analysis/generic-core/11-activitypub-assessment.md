# ActivityPub Implementation Assessment

## Architecture Overview

The AP implementation spans 43 files (~4,000 lines) built on Fedify, with three
actor types (User, Entity, Group), six activity types (Create, Follow, Like,
Announce, Accept, Reject + Undo), WebFinger discovery, HTTP signature verification,
and encrypted RSA key management.

## What's Good

**1. Fedify as the protocol layer.** Using a maintained federation framework
instead of hand-rolling ActivityPub is the right call. Fedify handles JSON-LD
context, HTTP signatures, content negotiation, and the W3C spec compliance details.

**2. Actor-per-model pattern.** Users, entities, and groups each have their own
actor URIs, key pairs, and inbox/outbox/followers URLs stored directly on the
Prisma model. This is clean — no intermediate actor table or polymorphic join.

**3. Encrypted private keys.** RSA private keys are AES-256-GCM encrypted at rest
with the encryption key from env. Public keys are stored plaintext (they're public).
Standard practice.

**4. Standalone mode.** Feature toggle to disable federation without removing the
code. Rejects all remote inbox activities when enabled. Clean degradation.

**5. The new generic URI scheme.** `/entities/{type}/{id}` is correct for a
multi-entity-type platform. The old `/dogs/{id}` pattern has been removed.

## Problems

### P1. Two actor serialization paths

There are two independent ways entities get serialized to Actor documents:

1. **`EntityProfileService.serializeActor()`** — hand-builds a JSON object with
   `@context`, `type`, `id`, `publicKey`, etc. Used by the route handler at
   `/entities/:entityType/:entityId`.

2. **`DogActorDispatcher.entityToActor()`** — builds a Fedify `Actor` object with
   `new URL(actorUri)` for id, inbox, outbox, etc. Used by the Fedify dispatcher
   system.

These can drift. If you add a field in one, you forget the other. The Fedify
dispatcher should be the single source of truth — it handles content negotiation
and JSON-LD serialization correctly. The route handler should use the dispatcher,
not a separate serialization method.

**Fix:** The `/entities/:entityType/:entityId` route should call
`DogActorDispatcher.getActor(uri)` and serialize via Fedify's
`respondWithObject()`, not `EntityProfileService.serializeActor()`.

### P2. Class naming doesn't match responsibility

- `DogProfileService` → renamed to `EntityProfileService` but the file is still
  `dog-profile-service.ts`
- `DogActorDispatcher` → handles any entity type but is named "Dog"
- Route file is `dog-profile.ts` → serves `/entities/:entityType/:entityId`

This causes confusion about what's generic vs. dog-specific.

**Fix:** Rename files:
- `dog-profile-service.ts` → `entity-profile-service.ts`
- `dispatchers/dog-actor.ts` → `dispatchers/entity-actor.ts`
- `routes/activitypub/dog-profile.ts` → `routes/activitypub/entity-profile.ts`

### P3. WebFinger only resolves users

The WebFinger handler (`webfinger/server.ts`) only looks up users by username.
There's no way to discover entity actors via WebFinger. For federation to work
with entities, remote servers need a way to discover them.

**Options:**
- `acct:entity:dog:clxyz123@example.com` — extend the acct format
- `https://example.com/entities/dog/clxyz123` — direct URI lookup (already works)
- WebFinger with resource type: `?resource=https://example.com/entities/dog/clxyz123`

The last option is standard — WebFinger supports any URI as a resource, not just
`acct:`. Add entity lookup when the resource is an `https:` URI matching the
entity actor pattern.

### P4. Followers query ignores targetType

`EntityProfileService.getFollowers()` now queries `where: { targetId: entityId }`
without filtering by `targetType`. If a user and an entity have the same ID (cuid
collision is near-impossible but conceptually wrong), this returns wrong results.

**Fix:** Add `targetType` filter:
```typescript
where: {
  targetId: entityId,
  targetType: { not: "user" },  // or pass the specific entityType
}
```

### P5. Abuse prevention is a stub

`abuse-prevention.ts` has the interface but all methods return `false` (no abuse
detected). The rate limits (60/min, 1000/hr) are defined but not enforced — the
comment says "delegates to Fedify" but Fedify doesn't do rate limiting.

**Fix:** Implement rate limiting. At minimum, use the existing `RateLimiter` class
(already in the codebase for API endpoints) for inbox requests. Per-actor rate
limiting is critical for federation — without it, a malicious remote server can
flood the inbox.

### P6. No Accept activity sent for Follow requests

When a remote Follow is received, `processFollow()` creates the Follow record but
doesn't send an `Accept` activity back. The ActivityPub spec requires Accept for
the follow to be confirmed. Without it, the remote server thinks the follow is
still pending.

The code has a comment: `// Should send Accept activity back (TODO: implement)`.

**Fix:** After creating the Follow, send Accept:
```typescript
const accept = new Accept({ actor: user.actorUri, object: activity });
await deliverActivity(accept, followerInboxUrl);
```

### P7. No Undo handling

`processUndo()` is a placeholder. If a remote user unfollows, the local server
ignores the Undo activity. The Follow relationship persists incorrectly.

**Fix:** Parse the inner object of the Undo. If it's a Follow, delete the
corresponding Follow record.

### P8. No activity signature on outgoing deliveries

`delivery-service.ts` calls `deliverActivityWithFedify` but it's unclear whether
outgoing HTTP requests are signed. Fedify should handle this if configured
correctly, but the configuration in `fedify/config.ts` is minimal — just base URL.
Verify that Fedify's `sendActivity` method uses the actor's key pair for signing.

### P9. Entity actor type is "Person"

`EntityProfileService.serializeActor()` sets `type: "Person"` for entity actors.
A dog profile is not a person. ActivityPub has no "Pet" or "Animal" type, but
`Service` or a custom type would be more semantically correct. Mastodon and
other servers will display entity actors as people.

This is a known compromise in the fediverse — most implementations use `Person`
for everything. Document the decision and consider `Service` if entities should
be clearly distinguishable from users.

### P10. `@context` inconsistency

`EntityProfileService.serializeActor()` uses:
```json
["https://www.w3.org/ns/activitystreams", "https://w3id.org/security/v1"]
```

But the Fedify dispatcher's `entityToActor()` uses Fedify's built-in context
handling, which may include additional namespaces. Two serialization paths =
two different contexts.

This is another reason to converge on a single serialization path (P1).

## Architecture Assessment

### What's production-ready

- WebFinger for users
- User actor documents (via Fedify dispatcher)
- HTTP signature verification on inbox
- Key pair generation and encrypted storage
- Follow relationship storage
- Feature-flagged enable/disable

### What's incomplete

- No Accept/Reject for incoming follows (P6)
- No Undo handling (P7)
- Abuse prevention is a stub (P5)
- Entity WebFinger discovery missing (P3)
- Announce and Reject activity handlers are placeholders
- DM delivery is implemented but DM federation (to remote servers) is unclear
- Group inbox processing exists but group federation flow is unclear

### What needs cleanup

- Two actor serialization paths (P1) — highest priority, causes correctness bugs
- File/class naming (P2) — confusing, low effort to fix
- Followers query (P4) — correctness issue, one-line fix

## Priority Order

1. **P1** — Converge on single actor serialization (use Fedify dispatcher from
   route handler). Prevents correctness drift and leverages Fedify's JSON-LD.
2. **P6** — Send Accept for incoming Follows. Required by the spec for basic
   federation to work.
3. **P7** — Handle Undo(Follow). Without this, unfollows don't federate.
4. **P5** — Implement inbox rate limiting. Security critical for production.
5. **P2** — Rename files. Low effort, high clarity.
6. **P4** — Add targetType filter. One-line correctness fix.
7. **P3** — Entity WebFinger. Needed when entities federate to other servers.
8. **P9, P10** — Actor type and context consistency. Cosmetic until federation
   is actively tested with real remote servers.
