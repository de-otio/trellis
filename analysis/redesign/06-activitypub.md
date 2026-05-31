# 06 — ActivityPub Compatibility

How circles and posting radius interact with the ActivityPub federation protocol.

---

## The Tension

ActivityPub assumes a **follow/inbox model**:
- Actors have followers collections and following collections
- A Follow activity is binary — you follow someone or you don't
- Posts are delivered to inboxes based on `to`/`cc`/`bto`/`bcc` addressing
- There's no concept of "relationship depth" or "posting radius" in the protocol

Trellis's circles model breaks these assumptions:
- Relationships have graduated depth, not binary state
- Content visibility is determined by posting radius × relationship score
- There's no direct mapping from "tier 0 inner circle" to an ActivityPub audience collection

---

## Current ActivityPub State in Trellis

- **Status**: Disabled by default, enabled per environment via `config.features.activityPub`
- **Implementation**: Fedify library, basic activities (Create, Like, Follow, Undo, Accept)
- **Models**: `Activity`, `Friendship`, Actor fields on `User` and `Entity`
- **Routes**: 8 route files in `routes/activitypub/`

The federation layer is functional but not battle-tested. No remote instances are connected.

---

## Options

### Option A: Defer Federation

**Rationale**: ActivityPub compatibility is a constraint that could compromise the circles model. Since federation isn't live and the feature is behind a flag, defer it until the circles model is validated.

**Pros**:
- Simplifies the redesign — no need to solve the mapping problem now
- Focuses effort on the core interaction model
- Federation can be designed from scratch once circles are proven

**Cons**:
- ActivityPub code rots if not maintained alongside the redesign
- Loses the interoperability story (Mastodon, Bluesky bridge, etc.)

### Option B: Bridge Layer

**Rationale**: Maintain federation by translating between circles/radius and ActivityPub's follow/inbox model at the boundary.

**How it works**:

1. **Inbound Follow → Relationship**: When a remote actor sends a Follow activity, create a `Relationship` with `connectionMethod: 'federation'` and an initial score in the community tier (0.3). The local user can adjust the score later.

2. **Outbound Relationship → Follow**: When a local user creates a relationship with a remote actor, send a Follow activity. ActivityPub doesn't know about scores — it just sees a follow.

3. **Posting Radius → Audience Addressing**: Map radius levels to ActivityPub addressing:

| Radius | ActivityPub Mapping |
|--------|-------------------|
| WHISPER | `bto`: explicit list of inner circle actors (private delivery) |
| NORMAL | `to`: followers collection (ActivityPub treats all followers equally) |
| LOUD | `to`: followers collection + `cc`: public (discoverable) |
| SHOUT | `to`: public collection |

4. **Inbound Posts → Circle Placement**: When a remote actor's post arrives in the local user's inbox, place it in the circle tier that matches the local user's relationship score with that actor. The remote actor has no say in tier placement.

**Pros**:
- Federation continues to work
- Remote actors see a familiar follow/unfollow model
- Local users get the full circles experience even with federated content

**Cons**:
- WHISPER is problematic — delivering to an explicit list of actors means the server must enumerate inner circle members for every whisper post. This doesn't scale well and leaks social graph information to remote servers.
- Lossy translation — remote followers don't know they're in the author's "community" tier vs. "inner circle." They just see the post (or don't).
- Ongoing maintenance burden to keep the bridge in sync with circles model changes

### Option C: Custom ActivityPub Extension

**Rationale**: Propose a custom ActivityPub extension for relationship depth, so compatible servers can support the full circles model.

This is technically possible (ActivityPub is extensible via JSON-LD contexts) but practically a dead end — no other server would implement it, and the Trellis user base is zero.

**Recommendation**: Don't pursue this unless/until Trellis has meaningful federation traffic.

---

## Recommendation

**Option A (defer) is the pragmatic choice.** Reasons:

1. Federation is disabled by default and behind a feature flag — no users are affected
2. The circles model is the core bet. Constraining it to fit ActivityPub before it's validated is premature optimization for interoperability
3. The bridge layer (Option B) is buildable later if federation becomes a priority
4. The ActivityPub models (`Activity`, actor fields on `User`/`Entity`) can remain in the schema dormant — they don't conflict with circles

### What to do now

- **Keep** the `Activity` model and actor fields on `User`/`Entity` — they're inert when federation is disabled
- **Remove** the `Friendship` model — it's an ActivityPub concept that's subsumed by `Relationship`
- **Keep** the feature flag (`config.features.activityPub`) — it gates all federation code
- **Don't delete** the federation routes — just leave them behind the flag
- **Document** the bridge layer design (Option B) so it can be built when needed

### What to do later (when federation matters)

Build Option B (bridge layer) with these constraints:
- WHISPER posts are **not federated**. They're local-only. This avoids the social graph leak problem.
- NORMAL and above are federated using the mapping table above.
- Inbound follows create community-tier relationships by default.
- Score adjustments for federated relationships work the same as local ones.

---

## Schema Impact

If deferring federation:

| Model | Action |
|-------|--------|
| `Activity` | Keep (inert) |
| `Friendship` | Remove (replaced by `Relationship`) |
| `Group` (ActivityPub groups) | Keep (groups are orthogonal to circles) |
| `GroupMember` | Keep |
| Actor fields on `User`/`Entity` | Keep (inert when flag is off) |
| Federation routes | Keep behind feature flag |
