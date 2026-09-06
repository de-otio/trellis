# @de-otio/trellis-extension-api

Shared types for building **Trellis** extensions: `TrellisExtension`, `Route`,
the strategy/hook interfaces, and the `ExtensionContext` an extension receives
at registration. Trellis is a generic multi-tenant social-network platform core;
vertical applications extend it by registering a `TrellisExtension` at startup
to add domain-specific routes, metadata schemas, and terminology.

## Reference

The canonical Extension API reference — the full `TrellisExtension` contract,
how a vertical registers an extension, and the review criteria (tracker-free /
anonymized client metadata, and AI Act Art. 50 synthetic-content provenance
disclosure) — lives in the Trellis docs:

**→ [Extension API reference](../../docs/reference/extension-api.md)**

## Install

```bash
npm install @de-otio/trellis-extension-api
```

```ts
import type { TrellisExtension } from "@de-otio/trellis-extension-api";
import { EXTENSION_API_VERSION } from "@de-otio/trellis-extension-api";
```

Declare `extensionApiVersion: EXTENSION_API_VERSION` on your `TrellisExtension`
so Trellis core checks compatibility for you at startup, instead of comparing
`EXTENSION_API_VERSION` by hand — see the
[`extensionApiVersion` reference](../../docs/reference/extension-api.md#extensionapiversion).

## 0.10.0 — the scoped surface

`0.10.0` is additive — an extension written against `0.9.2` compiles and
behaves identically — and, unlike the fields removed in `0.9.0`, **core reads
it**:

- **Per-route `scopes`** on an `extensionRoutes` entry is enforced by the route
  wrapper before your handler runs (absent = first-party only, `[]` = any
  authenticated caller, non-empty = every listed scope must be held).
- **`requestSchema`** is validated before the handler; a failing body is a
  structured `400` your handler never sees.
- **`publicSpec: true` + `scopes`** publishes the route into `/openapi.json` and
  mounts it under `/api/v1` behind the public dispatcher.
- **`ctx.events.emit(type, payload)` is required, not optional** — core always
  supplies it. It writes a tenant-bound row to core's domain-event outbox;
  nothing delivers events yet. On the extension-route path it needs the
  deployment's `TENANT_SCOPE_MODE` to be something other than `off`, or it
  throws rather than write a row scoped to nothing.
- A route with `auth: "none"` and a non-empty `scopes` **fails startup** —
  there is no principal to check the scopes against.

Still declaration only: the `scopes` and `events` *catalogs* on
`TrellisExtension` (consent copy and payload schemas nothing reads yet) and
`ExtensionSession.clientId`. The line-by-line account is in
[Extension API reference — Live since 0.10.0](../../docs/reference/extension-api.md#live-since-0100).

## Trust model — extensions are NOT sandboxed

Registering a `TrellisExtension` is a decision to trust that code at the same
level as Trellis core code. There is no isolation boundary. Read this before
loading an extension you did not write.

**Two ways to add routes, with very different exposure:**

| | `extensionRoutes` (**preferred**) | `routes` (raw, legacy) |
|---|---|---|
| Auth | enforced by core (`auth: "required"` by default) | **whatever the extension does — core does not check** |
| CSRF / CORS | applied by core | not applied |
| Security headers | applied by core | not applied |
| Rate limiting | applied by core for cross-tenant-capable extensions | not applied |
| Handler receives | a scoped `ExtensionContext` (tenant-scoped db, no secrets) | the **full core `Env`** |

The full core `Env` includes `SESSION_SECRET`, `SESSION_SALT`, `DATABASE_URL`,
every KV binding and every queue handle. A raw route can therefore mint session
cookies for arbitrary users, read or write any table across every tenant, and
reach any bound infrastructure — regardless of what its own handler advertises.

Core enforces one startup check on this path: `validateExtensions` **rejects**
(does not merely warn about) any raw `routes` entry that carries no core gate
middleware, so an unauthenticated raw route cannot boot. A gate is recognised
by **identity, not by name** — it must be `requireSessionMiddleware()` or
`csrfMiddleware()` imported from `@de-otio/trellis/dist/lib/middleware.js`. A
locally defined function does not qualify however it is spelled. That check
bounds *who can call* the
route; it does not sandbox *what the handler can do* once called. Raw routes
are also blocked from shadowing reserved core prefixes (`/api/auth`,
`/api/admin`, `/.well-known`, …).

**Guidance**

- Declare routes under `extensionRoutes` and let core wrap them. New extensions
  should have `routes: []`.
- Use raw `routes` only for a handler that genuinely needs core internals, and
  treat it as core code for review purposes.
- Operators: only load extensions you or your organisation control, and pin
  them by exact version. Extension code has no reduced privilege.
- Other extension surfaces (hooks, strategies, `crossTenantRead`) run in-process
  too. `crossTenantRead` is validated against a core allow-list at startup, but
  a hook is ordinary trusted code.
