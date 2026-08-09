---
title: Client Compatibility
description: How Trellis keeps shipped client binaries working — additive-only API evolution, the version-policy endpoint, and the forced-upgrade backstop.
sidebar: Client Compatibility
order: 15
---

# Client Compatibility

A deployed API can be migrated. A shipped mobile binary cannot — it is a
tolerant or intolerant reader, frozen at install time, updated only when a
user chooses to (the app-store long tail runs for months). This guide covers
the mechanisms that keep old clients working while the API evolves, and the
one mechanism that lets you eventually stop supporting them.

## The additive-only rules

The default regime for every change to a response or request shape consumed
by a client already in the field:

- **never remove or rename a response field**;
- **never change a field's type or semantics**;
- **never make an optional request field required, and never add a new
  required request field**;
- a removal or rename goes through **deprecation + client-version
  telemetry** — which requires the telemetry to exist in the first place
  (see [Version policy and forced upgrade](#version-policy-and-forced-upgrade)
  below). Without it, there is no way to know whether it is safe to retire
  a field: some fraction of installed clients may still read it.

This is enforced mechanically, not just by convention: the OpenAPI snapshot
gate (`apps/api/openapi.snapshot.json` + `check-openapi-additivity.mjs`, run
in CI as `openapi-gate.yml`) fails a pull request that removes a path,
method, or parameter — and, as the generator's schema output gets richer,
will also fail on a removed response field, a changed field type, a newly
required request field, or a removed enum value. See that script's own
comments for the current generator limitation (it does not yet emit full
response/enum/required detail, so those four rules are unit-tested against
synthetic documents today and become live as the generator gains that
detail).

## Tolerant reader (the client's half of the bargain)

The additive-only rules only protect a client that behaves like a
[tolerant reader](https://martinfowler.com/bliki/TolerantReader.html):
ignore unknown fields, apply a default for an absent optional field, and
never `switch` exhaustively over a server-controlled enum without a fallback
case. A client that hard-fails on an unrecognized enum value turns "the
server added a value" into a crash. This is primarily a client-side
concern (see the consuming Flutter app's own tolerant-reader checklist), but
it is the other half of the contract this guide documents.

## Version policy and forced upgrade

`GET /api/app/version-policy` is the mechanism a client uses to decide, on
launch, whether it is still supported.

- **Unauthenticated, session-free** — no cookie, no Bearer token, no CSRF
  check.
- **No database or KV read** — the whole response is built from four
  optional environment variables. This is deliberately cheaper than
  `GET /api/feature-flags`, which does hit the database.
- **Cacheable**: `Cache-Control: public, max-age=300`.
- **CORS**: served with `Access-Control-Allow-Origin: *` and no
  `Access-Control-Allow-Credentials` — the body is public, credential-free
  data, and reflecting an origin with credentials on would be a
  cache-poisoning shape for a response every client polls.

Response shape (every field nullable — `null` means "policy unset", i.e. the
mechanism is dormant):

```json
{
  "minimumVersion": "1.0.0",
  "recommendedVersion": "1.2.0",
  "storeUrls": {
    "android": "https://play.google.com/…",
    "ios": "https://apps.apple.com/…"
  }
}
```

### Configuration: the four `CLIENT_*` environment variables

| Variable | Purpose |
|---|---|
| `CLIENT_MIN_SUPPORTED_VERSION` | Oldest client version the server still accepts. Below it, both the policy endpoint's `minimumVersion` and the 426 backstop (below) treat the client as unsupported. |
| `CLIENT_RECOMMENDED_VERSION` | Version the client should nudge the user toward. Never enforced server-side — display-only. |
| `CLIENT_STORE_URL_ANDROID` | Android store URL surfaced in `storeUrls.android`. |
| `CLIENT_STORE_URL_IOS` | iOS store URL surfaced in `storeUrls.ios`. |

All four are **optional and runtime configuration**, per the
threshold-secrecy rule (an operational threshold is an env var with a
default, never a compiled constant — the npm tarball is public, so a
hard-coded minimum version would be a published one). **Unset means
dormant**: the endpoint returns `null` for that field, and an unset
`CLIENT_MIN_SUPPORTED_VERSION` makes the 426 backstop a permanent no-op.

Both version variables are validated at boot (`env-schema.ts`) against the
same bounded semver rule the request path uses (`lib/client-version.ts`):
`^(\d{1,4})\.(\d{1,4})\.(\d{1,4})([+-].*)?$`, input length-capped at 64
characters before the regex ever runs. A malformed value **fails the boot**
rather than degrading silently — the whole point of this mechanism is to be
trustworthy, so a typo'd version string must be caught before it ships, not
discovered as "the forced-upgrade screen never shows up."

The two store-URL variables have an additional rule, enforced at boot as
well: **the value must be an `https:` URL whose host is exactly
`play.google.com` or `apps.apple.com`.** A forced-upgrade screen is the one
place in the app where a user is told "there is nowhere else to go but this
link" — an operator typo or a compromised env var must never be able to
point that link at an arbitrary origin. A value that fails either check
(wrong scheme, wrong host, unparseable) is rejected at boot in the same way
an unparseable version is.

### Request headers

Every client request should carry:

- `X-Client-Version: <x.y.z>` — the running app version.
- `X-Client-Platform: android|ios|web` — anything else collapses to `other`
  server-side; the header value is never trusted verbatim beyond that closed
  vocabulary.

Both headers are attacker-controlled input from the server's point of view:
they are length-capped and parsed with the same bounded regex before any
comparison, never logged raw, and never used as a raw metrics dimension (the
metric dimension is re-serialized from the *parsed* triple, so a client
cannot inflate the metrics backend's cardinality by sending arbitrary
version strings — capped at 100 distinct values per process, overflow
bucketed to `other`).

### The 426 backstop

The forced-upgrade mechanism is primarily a **client** concern: the app
fetches the version policy on launch and blocks itself before making any
other call. The server-side 426 middleware is the backstop for the case
where that client-side check didn't run — an old build predating the
policy code, or a client serving a stale cached policy.

- Fires **only** when `CLIENT_MIN_SUPPORTED_VERSION` is set **and**
  `X-Client-Version` is present **and** parses **and** the parsed version is
  strictly older than the minimum. An equal version is allowed (a client
  running exactly the floor is not locked out). Absent or unparseable
  headers pass through untouched — federation peers, health probes, curl,
  and agents are never blocked.
- **Never intercepts `OPTIONS`.** A browser whose preflight fails sees an
  opaque network error, so an outdated web client could never even learn
  that it's outdated.
- Exempt paths: `/api/app/version-policy`, `/.well-known/*`, the public
  ActivityPub object surface (`/users/*`, `/groups/*`, `/posts/*`,
  `/messages/*`, `/audiences/*`, `/entities/*`), and `/health`.
- Response body — a `StructuredError`, **no URL**:

  ```json
  {
    "error": "UPGRADE_REQUIRED",
    "message": "This app version is no longer supported.",
    "remediation": "Update the app to the latest version from your device's official app store, then retry."
  }
  ```

  A client must never navigate to a link supplied by an error response body.
  The store link a client opens on a 426 is either its own compiled deep
  link or the allow-listed `storeUrls` from the version-policy endpoint —
  never anything carried in the 426 body itself.
- Log hygiene: the raw `X-Client-Version` header value is never logged —
  only the decision token (e.g. `parsed` / `invalid`), never the header
  itself.
- The middleware returns **either** a 426 **or** `next()` — never a 2xx of
  its own. It authenticates nothing and can bypass nothing.

## CORS: headers a client sends must be allow-listed

Browsers preflight any non-simple request header. `X-Client-Version` and
`X-Client-Platform` are sent on every call by a client that implements this
contract, so both are part of the `Access-Control-Allow-Headers` list served
by every CORS-handling site in the API
(`CORS_ALLOWED_REQUEST_HEADERS` in `lib/cors-handler.ts`, and the
preflight/response paths in `lib/middleware.ts`). If you add a new
client-sent header in the future, it must go on that same allow-list at
every site — a header the client sends but the allow-list omits fails the
*entire* request for the web build only, which is exactly the kind of gap
that ships unnoticed from a mobile-first test pass. **Never widen the list
to `*`**: these responses are served with
`Access-Control-Allow-Credentials: true`, and a wildcard is invalid (and
silently ignored) in credentialed mode.

## The `platform` feature-flags block

`GET /api/feature-flags` additionally serves a `platform` block: one boolean
per platform-level feature toggle (`posts`, `comments`, `friends`,
`sentiments`, `feeds`, `map`, `events`, `collections`,
`email_subscriptions`, `year_in_review`, `entity_profiles`). See
[Feature Flags](feature-flags.md) for the full contract, including the
**global-only** limitation (this endpoint is unauthenticated and carries no
tenant context, so per-tenant overrides are never reflected here — they
continue to act server-side at the point of enforcement).

## The alias-for-one-release standing rule

For any cross-repo rename at either boundary this guide covers (an HTTP
field/endpoint the client consumes, or an exported npm symbol the vertical
consumes): **add the new name as an alias alongside the old one, ship one
full release with both present, let the consumer move to the new name, and
only then remove the old name in a later release.** This is expand-contract
applied to the API/npm surface rather than to a database column, and it is
the standing rule now — not a per-plan judgment call. A rename that lands
and removes the old name in the same release is a breaking change to
whatever consumer hasn't picked up that release yet, exactly like a bare
`RENAME COLUMN` in a migration (see [Migrations](migrations.md)).

## The npm boundary (trellis ↔ vertical extensions)

The platform↔vertical boundary is a TypeScript library boundary, with its
own version of the mechanisms above:

- **A public-type snapshot for both packages** —
  `packages/extension-api/etc/public-api.snapshot.d.ts` and
  `apps/api/etc/public-api.snapshot.d.ts` — diff-gated in CI
  (`api-snapshot-gate.yml`). Any diff fails the build until the snapshot is
  regenerated (`npm run api-snapshot:update`) in the same change, so a
  breaking type change is visible in the diff, not discovered downstream.
- **`extensionApiVersion` checked at startup.** An extension may declare
  `extensionApiVersion` (normally `EXTENSION_API_VERSION` imported from
  `@de-otio/trellis-extension-api`, so a rebuild keeps it truthful). Core
  compares it against its own `EXTENSION_API_VERSION` at boot:
  - absent → one warning, never fatal;
  - a differing **major** (or, while the extension API is still `0.x`, a
    differing **minor** — 0.x minors are breaking) → **fails startup**,
    naming both versions;
  - anything else (patch drift, or a differing minor once the API reaches
    `1.x`) → logged only.
  - a declared but unparseable value → a clean boot-time validation
    failure, never a deep throw.
- **Constraint lockstep (extension-api package only).**
  `check-extension-api-version.mjs` (also gated in `api-snapshot-gate.yml`)
  compares `packages/extension-api/src/extension.ts`'s
  `EXTENSION_API_VERSION` const against `packages/extension-api/package.json`'s
  own `version` field, failing the build if they drift apart — this keeps the
  runtime version string truthful to what's published to npm. It does **not**
  check `apps/api`'s caret-range dependency on
  `@de-otio/trellis-extension-api`; gating that range against the same
  source of truth is a possible follow-up, not something this script does
  today.
