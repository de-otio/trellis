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
