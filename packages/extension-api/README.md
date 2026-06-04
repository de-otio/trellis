# @de-otio/trellis-extension-api

Shared types for building **Trellis** extensions: `TrellisExtension`, `Route`,
the strategy/hook interfaces, and the `ExtensionContext` your extension
receives at registration.

Trellis is a generic multi-tenant social-network platform core. Vertical
applications extend it by registering a `TrellisExtension` at startup to add
domain-specific routes, metadata schemas, and terminology. See the extension
section of the consuming app's `CLAUDE.md` and the `TrellisExtension` interface
in `src/extension.ts` for the full surface.

## Tracker-free guarantee (extension review criterion)

Trellis ships **no third-party trackers, analytics SDKs, or ad-network
integrations** in its server-side request handling. That is a property of the
core, and extensions are part of the trust boundary — so it is also a
**review criterion for every extension**:

> An extension **must not** introduce third-party trackers, analytics SDKs, or
> ad-network integrations into server-side request handling. Client metadata
> (IP, User-Agent, device identifiers) may be stored only through a path that
> enforces anonymization or an explicit retention bound — never logged or
> persisted ad hoc alongside domain data.

Why this is a hard rule, not a preference: a single tracking pixel or
analytics beacon added by an extension re-introduces exactly the third-party
data flows the platform is designed to avoid, and does so inside the
server-side path where users cannot block it. Extensions that need telemetry
must use the host's sanctioned, retention-bound audit/event paths. Extension
review **blocks** on a violation.

This is a guarantee about the **core API surface and server-side handling** —
not a promise about what a vertical chooses to embed in its own client
applications. The canonical statements of the underlying rules live in the
consuming app's `CLAUDE.md` (client-metadata storage; threshold secrecy) and in
`doc/02-technical/surveillance-threat-model/`.
