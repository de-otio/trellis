# Gap: ActivityPub as the Scraping Front Door

## The gap

For the fusion platforms in
[01 §1](./01-threat-landscape.md#1-scraping--osint-harvesting), public
ActivityPub collections are free OSINT — the social graph of a dissident is
precisely what gets fused with mobile-network data. Today:

- `GET /users/:username/followers` and `/following` are **public, unauthenticated,
  paginated collections** (`apps/api/src/lib/activitypub/listeners/actor.ts`).
- There is **no authorized-fetch mode** — HTTP signatures are verified on
  inbound POSTs (`apps/api/src/lib/activitypub/listeners/http-signatures.ts`)
  but GETs on actor/collection endpoints are open.
- There is **no instance deny/allow-list** — no defederation capability.
- The per-actor inbound rate limit (60/min) exists but the custom
  abuse-detection hook is unimplemented
  (`apps/api/src/lib/activitypub/services/abuse-prevention.ts`), and the
  rate-limit window is in-memory per-process, not distributed.

## Why this is cheap to fix now

ActivityPub is **feature-flagged off by default**
(`config.features.activityPub`). No vertical has it enabled in production.
That means the fix is not a migration — it's a set of **enablement
preconditions** written down before anyone flips the flag.

## Proposed enablement preconditions

Before any vertical enables `features.activityPub`, the following must be in
place. This list should be copied into
[`architecture/07-activitypub.md`](../architecture/07-activitypub.md) as
enablement criteria.

1. **Authorized fetch** (a.k.a. secure mode): require valid HTTP signatures
   on GETs to actor documents and collections, not only on inbox POSTs.
   Fedify supports this. Effect: scraping requires a real, identifiable
   federated actor — revocable and blockable — instead of anonymous HTTP.
2. **Follower/following-list visibility setting**: per-user control over
   whether the followers/following collections enumerate members or return
   only `totalItems`. Mainstream fediverse servers (Mastodon) offer this;
   it's the single highest-value control for the graph-harvesting threat.
3. **Instance deny/allow-list**: per-environment (and eventually per-tenant)
   defederation. The abuse-prevention service's unimplemented hook is the
   natural seam.
4. **Distributed rate limiting** for federation endpoints: move the
   per-actor window from in-memory to the existing DynamoDB token-bucket
   infrastructure (`apps/api/src/lib/rate-limit.ts`) so limits hold across
   Fargate tasks.

## Residual exposure

Federation is, by design, data sharing with servers trellis doesn't control;
authorized fetch and visibility settings reduce bulk harvesting but cannot
prevent a hostile federated server from retaining what it legitimately
receives. That residual risk belongs in any vertical's decision to enable
federation at all — which is exactly why it's a flag, not a default.

## Fedify authorized-fetch findings (2026-06-04)

Spike for [P6](../../../plans/surveillance-hardening-phase0/06-activitypub-preconditions.md),
resolving the one technical unknown: **does the pinned Fedify support authorized
fetch (signature-required-on-GET / "secure mode") natively, and if so, can we use
it as-is?**

**Pinned version:** `@fedify/fedify@1.10.6` (`package-lock.json`,
`node_modules/@fedify/fedify`).

### Answer: Yes natively — but NOT usable as-wired here. Authorized fetch must still be hand-rolled.

Two facts that together produce a qualified "yes, but":

**1. Fedify supports authorized fetch natively, via per-dispatcher `.authorize()`
— not a federation-level boolean.** There is **no** `authorizedFetch: true` /
`secureMode` flag on `createFederation` / `FederationOptions`. The only
signature-related options in `FederationOptions` govern *inbound POST*
verification: `signatureTimeWindow` and `skipSignatureVerification`
(`node_modules/@fedify/fedify/dist/context-C6n2yrj0.d.ts`). Authorized fetch is
instead implemented per-dispatcher:

- `ActorCallbackSetters.authorize(predicate)` — `context-C6n2yrj0.d.ts:1310`
- `CollectionCallbackSetters.authorize(predicate)` — `context-C6n2yrj0.d.ts:1357`
- `ObjectCallbackSetters.authorize(predicate)` — `context-C6n2yrj0.d.ts:1322`

The predicate type (`AuthorizePredicate`, `context-C6n2yrj0.d.ts:246`) receives
`(context, identifier, signedKey, signedKeyOwner)` and returns `boolean`. The
underlying primitives `RequestContext.getSignedKey()` /
`getSignedKeyOwner()` are documented as the "authorized fetch (also known as
secure mode)" mechanism (`context-C6n2yrj0.d.ts:1965–2024`), present **since
Fedify 0.7.0** (the two-arg `getSignedKey(options)` overload since 1.5.0). All of
this exists in our pinned 1.10.6. Confirmed against the Fedify docs
(`https://fedify.dev/manual/access-control`): authorized fetch is a per-dispatcher
`authorize()` callback introduced in 0.7.0, with an "instance actor" pattern
recommended to avoid authentication loops.

**2. This codebase does not serve actor/collection GETs through Fedify's
dispatcher pipeline, so `.authorize()` never fires for them.** The
followers/following/actor endpoints are **plain `Route[]` handlers**
(`apps/api/src/lib/routes/activitypub/collections.ts`,
`.../actor.ts`), registered in the app's own router (`apps/api/src/lib/app.ts`)
with `middleware: [corsMiddleware()]`. Fedify is used only for **serialization**
(`respondWithObject`, `OrderedCollection`) and **key management** (the
`dispatchers/*` classes) — **not** for request routing via `federation.fetch()`.
Fedify's native `.authorize()` only runs inside the `federation.fetch()` dispatch
path, which these routes bypass. So the native control is real but inapplicable to
the endpoints we actually expose without first re-routing them through Fedify.

**Conclusion:** authorized-fetch-on-GET will be **hand-rolled middleware** here
regardless of Fedify's native support — either (a) a GET-signature guard added to
the existing route handlers, or (b) a larger refactor to route actor/collection
GETs through `federation.fetch()` so `.authorize()` applies. (a) is far cheaper
and is the recommended seam.

### Custom middleware seam (option (a), recommended)

The verification machinery already exists and is **directly reusable** — no new
crypto:

- `apps/api/src/lib/activitypub/http-signatures.ts` —
  `HttpSignatureService.verifyRequest(request, env): Promise<boolean>` is a
  complete, self-contained RSA-SHA256 HTTP-signature verifier over a web
  `Request` (parses the `Signature` header, fetches the signer's public key —
  local or remote, honoring standalone mode — reconstructs and verifies the
  signature string). It already works for any method, including GET.
- `apps/api/src/lib/activitypub/listeners/http-signatures.ts` —
  `verifyHttpSignature(request, env)` is the dispatcher-keyed variant.

**Interception point:** add an `authorizedFetchMiddleware()` to the `middleware`
array of the GET routes under `apps/api/src/lib/routes/activitypub/`
(`collections.ts`, `actor.ts`, `outbox.ts`). The middleware calls
`HttpSignatureService.verifyRequest`; on failure it returns the reduced response
(401, or `totalItems`-only collection / `publicKey`-stripped actor). The
follower/following visibility setting (precondition 2) layers on top: even a
*valid* signature yields only `totalItems` unless the target user has opted into
member enumeration. The instance deny/allow-list (precondition 3) is a check on
the signer's origin host in the same middleware, with the abuse-prevention
service's unimplemented hook
(`apps/api/src/lib/activitypub/services/abuse-prevention.ts`) as its home.
Distributed rate limiting (precondition 4) reuses
`apps/api/src/lib/rate-limit.ts`.

### Estimate for Phase 2 AP-hardening: **M**

Rationale: no native drop-in (rules out S), but the signature-verification core
is already written and reusable, and the seam is a middleware addition to a small
number of existing route handlers (rules out L). The four preconditions are
mostly independent and individually small — authorized-fetch middleware (reuses
`verifyRequest`), a per-user visibility column + branch in the collection
handlers, a deny/allow-list table + origin check, and porting the rate-limit
window to the existing distributed token bucket. The one item that could push
toward L — re-routing all GETs through `federation.fetch()` to get native
`.authorize()` — is **not** required; the hand-rolled middleware avoids it.
