# 02 · Citation workflow & validation

## Citing in a design doc

Inline, Pandoc-style:

```md
The mental-health framing is empirically shaky [@goodattention2026-social-media-bans];
age verification is itself a privacy harm [@eff-age-verification; @ohchr2026-age-verification].
```

- `[@key]` and `[@key1; @key2]` for multiple; `[@key, p. 8]` for a locator.
- The key is human-meaningful, so the prose stays readable un-rendered.
- **Optional rendering:** a Pandoc/Quarto pass can turn `[@key]` into numbered
  references + an auto-generated "References" section for any doc that wants a
  formatted bibliography. Internal design docs don't need rendering — the key +
  the central list is enough.

## `bibcheck` — the verification engine (mandatory, blocking)

`bibcheck` (installed globally, v0.1.1 — "Humanities-aware citation verification
for CSL-JSON bibliographies") is the load-bearing anti-hallucination control. It
reads our canonical **CSL-JSON natively** — no BibTeX export needed — and is
config-driven via a repo-root `bibcheck.toml`.

`bibcheck check` is billed as the **CI build-gate** and runs five checks:

| Check | What it catches |
|---|---|
| `existence` | The source isn't real — verified against bibliographic databases. **The primary anti-hallucination check.** |
| `canonical` | The cited URL/edition isn't the authoritative one |
| `linkage` | Cite-key ↔ entry mismatches (a `[@key]` with no entry, or vice-versa) |
| `phrases` | Phrase-denylist lint (banned/suspect phrasings) |
| `worklist` | Generates the queue of entries needing **manual** review |

Output formats: `json`, `markdown`, `sarif`, `text`. Use **`sarif`** in CI so
findings surface as inline GitHub code-scanning annotations. `bibcheck doctor`
verifies config + connectivity (onboarding); results are cached (`--no-cache` to
bypass).

**Mandatory and blocking — not "if present."** AI-assisted research routinely
produces plausible fabrications (invented papers, real authors on papers they
never wrote, well-formed-but-nonexistent DOIs), and the public bibliography
**ships to npm**. `bibcheck check` failing = the build fails.

## Verification is recomputed, never hand-stored

`bibcheck` *produces a report*; it does not write a verdict back into each entry.
So **"verified" is the output of `bibcheck check` at CI/build time, not a stored
boolean.** This is deliberate: a committed `verified: true` is itself an
unverifiable claim that can silently go stale (dead URL, retraction) — exactly
the failure mode we're guarding against. The build and release re-run the check;
the report is the source of truth.

- **`linkage` and `phrases` are bibcheck's**, so our own linter does **not**
  reimplement dangling-key or phrase checks (see below).
- **Manual cases** (pre-DOI / primary / policy grey-literature `bibcheck` can't
  auto-verify) land on its **`worklist`** → escalate to the `reference-librarian`
  agent → record acceptance in `bibcheck.toml` (an audited allow-list), not a
  free-text "trust me" field on the entry.
- **Quotation accuracy** (a quoted passage matches the source text) is a
  worklist/manual activity via the librarian — `phrases` is a denylist lint, not
  a quote-matcher. Don't claim automated quote-matching the tool doesn't do.

## The repo linter — the thin layer `bibcheck` doesn't own

`scripts/check-citations.ts` (deterministic, offline, fast) covers only the
**publication-scope** concerns specific to us — everything else defers to
`bibcheck`:

1. **Schema** — validate `sources.json` against the Zod/CSL schema (malformed
   entries, unknown `type`).
2. **Public-scope gate** — every `creditScope: "public"` entry must carry the
   render fields (`author`/`title`/`issued` + `URL`|`DOI`) and pass a
   **customer-marker scan** against the repo's `repo-aegis` deny set (a
   confidentiality control specific to *our* publication surface, beyond
   `bibcheck`'s generic `phrases`).
3. **Public-requires-passing** — cross-reference the latest `bibcheck` report:
   **fail if any `public` entry has an unresolved `existence`/`canonical`
   finding.** This is the join that makes "only verified ships" enforceable
   offline at packaging time.
4. **Orphan report** (warn) — entries cited nowhere; suppress with
   `x-trellis.keepUnused: true` for credited-but-uncited works.

(Dangling `[@key]` ↔ entry is **bibcheck `linkage`**; we don't duplicate it.)

## CI lane

Add a `citations` job (sibling to lint/test):

```
1. bibcheck check --format sarif --output bibcheck.sarif   # REQUIRED build-gate
   #    existence/canonical/linkage/phrases/worklist; fails on any finding
2. tsx scripts/check-citations.ts --bibcheck-report bibcheck.sarif
   #    REQUIRED: schema + public-scope gate + public-requires-passing + orphans
3. upload bibcheck.sarif to code scanning                  # inline annotations
```

- Step 1 is the only network step (existence/canonical reach out); step 2 is
  offline and reads step 1's report.
- **Publish/release** runs `bibcheck check` at the **tagged ref** — the credits
  artifact ships from that ref, so verification must hold there (mirrors the
  release-checklist discipline in `CLAUDE.md`).
- **Scheduled weekly re-run** of `bibcheck check` catches link rot / retractions:
  a source that was real last month but is now dead flips `existence`/`canonical`
  to a finding → build fails → fix or de-scope.

## Adding a source — the friction budget

Mechanical, not hand-judged:

1. Append one CSL-JSON object to `sources.json` (`id`, `type`, `addedBy`;
   `creditScope` defaults to `internal`).
2. Cite it with `[@id]`.
3. Run `bibcheck check` locally (or let CI). Resolve findings; `worklist` items
   route to the `reference-librarian` agent and, once cleared, are accepted in
   `bibcheck.toml`.
4. Only once it passes `bibcheck` may you set `creditScope: "public"`. CI blocks
   any `public` entry with an unresolved finding, so nothing unverified reaches
   `main` or the npm tarball.

A tiny `scripts/add-source.ts` that scaffolds an entry from a DOI/URL and then
runs `bibcheck check` on it is a recommended nicety.
