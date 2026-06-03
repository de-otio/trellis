# 01 · Bibliography format & schema

## Canonical format: CSL-JSON

The single source of truth is a **CSL-JSON** array (Citation Style Language). It
is a recognised bibliography standard, it is JSON (so the published app bundles
and serves it with zero parsing dependency), it validates cleanly against a Zod
schema, and **`bibcheck` reads it natively** (no export step). It still converts
to BibTeX for Pandoc / academic tooling when that's wanted.

```jsonc
// apps/api/src/data/bibliography/sources.json
[
  {
    "id": "goodattention2026-social-media-bans",     // == the cite key
    "type": "report",
    "title": "Social Media Bans and the Ethics of Attention",
    "author": [{ "literal": "GoodAttention / Salient Solutions Research Groups" }],
    "issued": { "date-parts": [[2026]] },
    "publisher": "University of Oslo",
    "URL": "https://www.hf.uio.no/ifikk/.../goodattention_final-social-media-bans.pdf",
    "x-trellis": {
      "creditScope": "public",
      "addedBy": "core",
      "influences": [
        "analysis/safer-social-design/09-attention-regulation-and-age-limits/"
      ]
    }
  }
]
```

CSL types cover everything in the corpus: `article-journal` (the DOI papers),
`paper-conference`, `report` (policy briefs), `webpage` (news), `book`,
`legislation` (KOSA, EU DSA/DMA, UK OSA), `manuscript` (the cited unpublished
work).

## The `x-trellis` extension object

CSL-JSON tolerates extra properties; we namespace ours under `x-trellis` so
standard tools ignore them:

```ts
interface XTrellis {
  creditScope: "public" | "internal";   // DEFAULT internal (fail-closed)
  addedBy: "core" | string;              // "core" or an extension id (e.g. "dog")
  influences?: string[];                 // repo paths this source shaped (back-links)
  keepUnused?: boolean;                  // credited-but-uncited (suppress orphan warning)
  attribution?: {                        // for licence-bound sources (rare)
    required: boolean;
    notice?: string;                     // exact text to reproduce on the credits page
  };
}
```

### Verification is *not* a stored field — it's `bibcheck`'s output

Deliberately, there is **no `verified: true` boolean on the entry.** Verification
is whatever `bibcheck check` reports at CI/build time, recomputed every run. A
committed "verified" flag is itself an unverifiable claim that silently goes
stale (dead URL, retraction) — the exact failure mode we're guarding against. So:

- "Is this source real / accurately cited?" ⇒ **run `bibcheck`**, don't read a
  field. The build and release re-run it; the report is the source of truth.
- The only entry-level handle on verification is the **ship gate**:
  `creditScope: "public"` is allowed only when the entry passes `bibcheck`
  (enforced by CI cross-referencing the report — see
  [`02`](02-citation-workflow-and-validation.md)).
- Sources `bibcheck` can't auto-verify surface on its **`worklist`** → handled by
  the `reference-librarian` agent → acceptance recorded in `bibcheck.toml` (an
  audited allow-list), not a free-text field here.

This keeps the schema small and pushes the anti-hallucination guarantee onto the
tool that can actually enforce it, every time.

- **`creditScope`** is the publication gate (see [README](README.md) and
  [`03`](03-app-credits-page.md)). Absent ⇒ treated as `internal`.
- **`addedBy`** lets a vertical extension own its own entries (skybber's
  safer-social sources are `addedBy: "dog"`), so the merged credits page is
  complete per active extension without core hard-coding vertical research.
- **`influences`** is the optional reverse index — "which design decisions does
  this source underpin" — handy for audits and for the doc linter's orphan
  report.

A Zod schema (`bibliography-schema.ts`) validates the CSL core fields we rely on
plus `x-trellis`; CI rejects malformed entries.

## Citation key convention

The CSL `id` **is** the cite key:

- People: `lastnameYYYY-slug` → `watzl2026-attention-ethics`,
  `nagata2026-minor-accounts`.
- Orgs / standards / regs: `org-or-shortnameYYYY` → `kosa2024`,
  `ohchr2026-age-verification`, `eff-age-verification`, `eu-dsa`.
- Collisions get a trailing letter (`smith2025a`).

Keys are stable once published in a doc; renames are a find-replace + a linter
pass.

## What qualifies as a "source" (and what doesn't)

**In scope** (goes in `sources.json`): scholarly papers, books, policy briefs,
standards/regulations, primary documents, and substantive articles that *shaped a
design decision*.

**Out of scope** (never in the bibliography): AWS/vendor documentation, RFCs,
SDK references, infra URLs, and other incidental technical links. These stay as
plain inline links in the docs. Rule of thumb: *if it influenced a decision and
you'd credit it, it's a source; if it's "how to configure X," it's a link.*

## Where the store lives

```
bibcheck.toml             # repo root — bibcheck config (points at sources.json + doc globs)
apps/api/src/data/bibliography/
  sources.json            # CSL-JSON — canonical bibliography (core); bibcheck reads this natively
  contributors.json       # people/orgs who contributed to Trellis (see 03)
  bibliography-schema.ts  # Zod schema for both
  credits.generated.json  # BUILD OUTPUT — public-scoped, pre-rendered (see 03)
```

`bibcheck.toml` lives at the repo root (its default config path) and tells
`bibcheck` where `sources.json` is and which doc globs to scan for `[@key]`
linkage. Its exact key schema is confirmed via `bibcheck doctor`; it also holds
the audited allow-list of manually-accepted (worklist-cleared) sources.

- It lives **inside the published `apps/api` package** because the runtime
  credits endpoint must bundle it; add the dir to the package `files` whitelist
  — but note **only `credits.generated.json` (public-scoped) is what ships**, not
  the raw `sources.json` (which contains `internal` entries). The build emits the
  public subset; the raw file is `files`-excluded or stripped. (See
  [`03`](03-app-credits-page.md) for the exact build boundary — this is the
  publication-surface control.)
- Docs across the repo reference sources **by key only** (`[@key]`); they do not
  import the file, so the doc tree and the package stay decoupled.
- **Graduation path:** if extensions need to import bibliography data
  programmatically (not just contribute via `registerExtension`), promote the dir
  to a `packages/bibliography` workspace package. Not needed for the MVP.

## Migration of existing citations

Do **not** rewrite all ~14 cited docs at once:

1. **Seed** `sources.json` with the high-value scholarly sources already present
   (the attention-ethics set, the safer-social studies, the DOI/arXiv papers),
   each with a key and `creditScope`.
2. **Add keys opportunistically** — when a doc is next touched, convert its
   inline `**Source:**`/footnote citations to `[@key]`. The existing prose stays
   readable in the meantime; the linter only enforces keys that *are* present.
3. The `analysis/safer-social-design/09-.../` set is the natural first batch (it
   already has clean `**Source:**` blocks).
