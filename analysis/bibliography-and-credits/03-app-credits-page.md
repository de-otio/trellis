# 03 · The in-app credits page

## What the page shows

A data-driven acknowledgements page, four sections, all derived from the same
store so they never drift from the design docs:

1. **Research** — the bibliography entries that shaped the product, formatted as
   citations (with links). *Public-scoped only.*
2. **Contributors** — people/orgs who contributed to Trellis (researchers,
   advisors, designers), distinct from the *authors of cited sources*.
3. **Open source** — third-party libraries and their licences.
4. **Per-extension / per-tenant** — credits contributed by the active vertical
   extension and (optionally) the tenant.

## Endpoint

`GET /api/credits` — public, unauthenticated, heavily cacheable (it changes only
on deploy + on the active extension set). Follows the project's handler/route
conventions; wrapped with security headers; no per-user data.

Response is the **pre-rendered generated artifact** merged with **live extension
contributions** at request time:

```jsonc
{
  "research": [
    { "key": "goodattention2026-social-media-bans",
      "citation": "GoodAttention / Salient Solutions (2026). Social Media Bans and the Ethics of Attention. University of Oslo.",
      "url": "https://…" }
  ],
  "contributors": [ { "name": "…", "role": "research", "affiliation": "…", "url": "…" } ],
  "openSource": [ { "name": "fedify", "version": "…", "license": "MIT", "url": "…" } ],
  "extensions": [ { "id": "dog", "research": [ … ], "contributors": [ … ] } ]
}
```

## Build-time generation — the publication boundary

The runtime endpoint must **not** read raw `sources.json` (it contains
`internal` entries). Instead, a build step is the single place the public subset
is computed:

```
build: scripts/gen-credits.ts   (runs AFTER `bibcheck check` in the same job)
  reads  sources.json + contributors.json + the bibcheck report
  keeps  ONLY entries with creditScope == "public"
                       AND no unresolved bibcheck existence/canonical finding
  FAILS the build if any public entry has an open bibcheck finding
  re-runs the customer-marker scan on that subset (defence in depth)
  renders each CSL entry to a citation string (CSL processor / citation-js)
  writes apps/api/src/data/bibliography/credits.generated.json
```

Because the gate is "passes the **current** `bibcheck` report" (not a stored
flag), **a hallucinated or stale source can never reach the credits artifact** —
the build refuses to emit it, and the release re-runs `bibcheck` at the tagged
ref ([`02`](02-citation-workflow-and-validation.md)). The shipped credits page
is, by construction, exactly the set of public sources `bibcheck` passes at
build time.

- Only `credits.generated.json` is included in the published package `files`;
  `sources.json` / `contributors.json` are **excluded from the package** (or
  stripped), so `internal` material cannot ship even by accident. This is the
  enforcement point for the publication-surface constraint from the
  [README](README.md).
- Rendering at **build** (not runtime) keeps the endpoint a static-JSON serve —
  no heavy citeproc dependency in the running service, and a **reproducible
  build** (same `sources.json` ⇒ same artifact), per the project's
  reproducible-build default.

## Scope enforcement (defence in depth)

Two rules compound here — "only public ships" *and* "only verified ships" —
enforced at four layers so no single mistake leaks an internal source or a
fabricated one:

1. **Authoring** — `creditScope` defaults to `internal`; you must explicitly opt
   an entry into `public`.
2. **Verification (`bibcheck check`)** — the required build-gate; a `public`
   entry with an open `existence`/`canonical` finding fails the build. Manual
   (worklist) cases are cleared via the audited `bibcheck.toml` allow-list.
3. **Lint/CI** — `check-citations.ts` ([`02`](02-citation-workflow-and-validation.md))
   fails the build if a `public` entry has an open bibcheck finding, carries a
   customer marker, or is missing render fields.
4. **Packaging** — `gen-credits` emits only `public` entries that pass the
   current bibcheck report; only that generated artifact is in `files`; the raw
   store never enters the npm tarball.

## Contributors model

`contributors.json` is separate data from the bibliography — it credits people
who built/advised Trellis, not authors of sources we merely cite:

```ts
interface Contributor {
  id: string;
  name: string;
  role: "research" | "advisor" | "design" | "engineering" | "other";
  affiliation?: string;
  url?: string;
  creditScope: "public" | "internal";   // same default-internal gate
}
```

(Authors of cited works are surfaced through the **research** section via the
bibliography — we don't duplicate them here.)

## Open-source attributions

The "Open source" section is **generated, never hand-maintained**:

- A build step runs an SPDX/licence extractor (e.g. `license-checker` or
  `oss-attribution-generator`) over the production dependency tree and writes
  `oss-attributions.generated.json` (name, version, SPDX licence, repo URL,
  licence text where the licence requires reproduction).
- `gen-credits.ts` folds this into the artifact. This also satisfies licences
  (MIT/BSD/Apache) that *require* attribution — a real compliance need, not just
  a nicety.

## Extension & tenant contributions

Verticals do their own research; the credits page must reflect the active
extension:

- Extend the `TrellisExtension` interface (`packages/extension-api`) with an
  optional `credits` contribution:
  ```ts
  credits?: {
    research?: CslJsonEntry[];      // entries (addedBy auto-set to the extension id)
    contributors?: Contributor[];
  };
  ```
- At startup `registerExtension()` merges the extension's `public`-scoped credits
  into the served artifact under `extensions[]`. Same scope gate applies — an
  extension cannot publish an `internal` entry.
- **Tenant (optional, later):** a tenant could add its own short acknowledgements
  via tenant config; multi-tenant aware, but out of MVP scope. Note it so the
  response shape leaves room (`tenant?: { … }`).

## Open questions

- **Citation style** for the rendered `citation` string — a compact house style
  vs a standard (APA/Chicago). Pick one CSL style; trivial to change since the
  store is CSL-JSON.
- **Localisation** — the credits page is largely proper nouns + citations;
  decide whether section headings flow through the app's i18n.
- **`bibcheck` in the publish workflow** — **resolved: it gates the release.**
  Because the credits artifact ships from the tagged ref, verification must hold
  *at that ref*, not just on `main`. The network dependency is handled by
  installing `bibcheck` in the release job (it is a required CI dependency, not
  optional). Remaining sub-question: acceptable staleness window for a
  previously-`verified` source at release time (proposal: re-verify entries older
  than the weekly schedule's interval as part of the publish job).
- **Where contributors come from** — manual `contributors.json` vs deriving
  engineering contributors from git history (leaning manual + curated; git
  history is noisy and a confidentiality surface).
