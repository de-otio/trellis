# Bibliography & credits — design

**Date:** 2026-06-02
**Status:** Design — not yet built.
**Why now:** A lot of research is flowing into Trellis's design (attention
economy, safer-social, location/surveillance, identity). Citations are accruing
ad hoc across `analysis/` and `plans/` in inconsistent formats, with no central
list and no way to surface acknowledgements in the product.

## The problem, concretely

- **~14 doc files** already carry citation-ish markers (`**Source:**` headers,
  footnotes, `(Author, 2026)`, bare DOIs) — every one in its own format, with no
  stable keys and no single list.
- The repo's external links **split into two kinds** that must not be conflated:
  - **Scholarly / research sources** worth a bibliography and credits — DOIs
    (`doi.org/10.1371/...`, `10.51685/jqd.2026.005`), arXiv, Citizen Lab, the
    Watzl / GoodAttention attention-ethics work, the safer-social studies.
  - **Incidental technical references** — AWS docs, RFCs, infra URLs. These are
    *not* bibliography and must never reach a credits page.
- There is **no bibliography infrastructure** today (no `.bib`, no CSL, no
  loader) and **no in-app credits surface**.

## Goals

1. **One machine-readable source of truth** for the bibliography, consumed by
   *both* the design docs and the app — so they can never drift.
2. **Stable citation keys** usable inline in markdown, with **automated
   validation** (no dangling cites; schema-checked entries).
3. **A data-driven in-app "credits" page** derived from the same store, plus
   contributors and third-party open-source attributions.
4. **No hallucinated sources, ever.** Every source is verified real and
   accurately represented by **`bibcheck`** before it can be cited as done or
   shipped. This is a hard, blocking requirement — see below.
5. **Low friction** to add a source (verification is automated, not manual
   gatekeeping).

## The non-negotiable constraint: the credits page is a publication surface

`@de-otio/trellis` is **published to npm**. Anything bundled for the credits
endpoint **ships publicly**, regardless of this repo's current private
visibility. Therefore:

- Every bibliography entry has an explicit **`creditScope`** that **defaults to
  `internal`** (fail-closed). Only entries *explicitly* marked `public` are
  bundled into the published artifact and served by the credits endpoint.
- The same global confidentiality rule that governs the repo governs the
  bibliography: a customer-identifying source may exist as an `internal` entry
  only — it must **never** be marked `public`, and the validator enforces that
  `public` entries carry no customer markers.

This constraint shapes the whole design (see [`03`](03-app-credits-page.md)).

## Sources must be real — `bibcheck` is a hard gate, not an option

Much of this research is gathered with AI assistance, which can produce
**plausible-looking but fabricated** citations — invented papers, real authors
on papers they never wrote, correct-format-but-nonexistent DOIs, quotes that
don't appear in the source. A hallucinated citation that we then **publish** (in
the npm package, on the credits page) is the worst case: we are publicly
attesting to a source that does not exist. That is unacceptable, so:

- **`bibcheck check` is mandatory and blocking**, not "when available." It reads
  our CSL-JSON natively and is billed as a CI build-gate; a failing check fails
  the build and the release.
- **`creditScope: public` ⇒ passes `bibcheck check`.** A source can be
  bundled/shown **only if `bibcheck` raises no `existence`/`canonical` finding
  against it.** No exceptions — the credits page is, by construction, the set of
  sources `bibcheck` passes.
- **Verification is recomputed, never hand-stored.** There is no `verified: true`
  field to trust — the build and release re-run `bibcheck`, so a source that has
  since rotted or been retracted flips to a finding and fails the build. (A
  stored flag would be exactly the unverifiable claim we're guarding against.)
- **Hard human-judgment cases** (pre-DOI, primary, policy grey-literature)
  surface on `bibcheck`'s `worklist` and pair with the `reference-librarian`
  agent; once cleared they're accepted via an audited `bibcheck.toml` allow-list.
- **`bibcheck` is a CI/release dependency** (now installed globally on the
  maintainer's machine). CI installs and runs it; nothing unverified reaches
  `main` or the npm tarball regardless of any individual laptop.

Mechanics in [`02`](02-citation-workflow-and-validation.md); the schema in
[`01`](01-bibliography-format-and-schema.md); the ship-gate in
[`03`](03-app-credits-page.md).

## Decisions (summary)

| Decision | Choice | Rationale |
|---|---|---|
| Canonical format | **CSL-JSON** | JSON-native (the app bundles/serves it with no parser), a recognised standard, Zod-validatable, and **read natively by `bibcheck`** — no export step |
| Cite key = entry `id` | `lastnameYYYY-slug` (orgs: `kosa2024`, `ohchr2026-age-verification`) | Human-meaningful, greppable, stable |
| In-doc syntax | Pandoc-style `[@key]` | Standard, unambiguous, trivially lintable |
| Home of the store | `apps/api/src/data/bibliography/` | Must live inside the published package to feed the runtime credits endpoint; may graduate to `packages/bibliography` if extensions need to import it programmatically |
| Scoping | `creditScope` defaults to `internal` | The publication-surface constraint above |
| Validation | **mandatory blocking `bibcheck check`** + a thin repo linter | `bibcheck` owns existence/canonical/linkage/phrases/worklist; the linter owns only our publication-scope gate (public-requires-passing, render fields, customer-marker scan) |
| Ship gate | `creditScope: public` **requires passing `bibcheck check`** | Anti-hallucination: only sources `bibcheck` passes can bundle/ship; recomputed every build, never a stored flag |

## Topic map

| File | Covers |
|---|---|
| [`01-bibliography-format-and-schema.md`](01-bibliography-format-and-schema.md) | CSL-JSON + the `x-trellis` extension, key convention, what qualifies as a source, where the store lives, migration of existing citations |
| [`02-citation-workflow-and-validation.md`](02-citation-workflow-and-validation.md) | `[@key]` in docs, the citation linter, `bibcheck` pairing, CI lane, orphan handling |
| [`03-app-credits-page.md`](03-app-credits-page.md) | The `/api/credits` endpoint, build-time generated artifact, scope enforcement, contributors, OSS attributions, extension + tenant contributions |
