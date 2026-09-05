---
title: Reference
description: Precise specifications — APIs, data formats, and the extension API.
sidebar: Reference
order: 4
---

# Reference

Exact, lookup-oriented material: the data-portability format, the media,
profile, and [events](./events-api.md) APIs, the
[synthetic-content provenance API](./provenance-api.md), the user-side
remedies — [blocks](./blocks-api.md) and
[content reports](./content-reports-api.md) (the DSA Art. 16 notice-and-action
path) — [media moderation configuration](./media-moderation-config.md), the
identity-federation data model, the extension API, and the glossary. How the
feed is ordered, and why counts never influence it, is a concept page:
[Feed ordering](../concepts/feed-ordering.md).

**On the OpenAPI document.** `GET /openapi.json` (and the committed snapshot
`apps/api/openapi.snapshot.json`) covers the **public `/api/v1` mount only** —
routes flagged `publicSpec` that declare `scopes`, served behind the
authenticate → scope → validate dispatcher. The legacy `/api/*` routes the
first-party client uses are deliberately absent from the spec, because
emitting them would put paths in the document that carry none of the mount's
enforcement. Those routes are documented here, in the reference pages, not in
the spec.
