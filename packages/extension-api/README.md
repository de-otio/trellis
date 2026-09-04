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
(does not merely warn about) any raw `routes` entry that declares no
`authMiddleware`/`csrfMiddleware`, so an unauthenticated raw route cannot boot.
That check bounds *who can call* the route; it does not sandbox *what the
handler can do* once called. Raw routes are also blocked from shadowing
reserved core prefixes (`/api/auth`, `/api/admin`, `/.well-known`, …).

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
