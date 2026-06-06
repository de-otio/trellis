---
title: Contributing to the docs
description: How Trellis documentation is organized and authored.
sidebar: Contributing
order: 99
---

# Contributing to the docs

These are the rules for the `docs/` folder. The project website publishes
**exactly this folder** at each release tag and derives its navigation from the
folder structure, so the layout here *is* the site nav.

## Principles

- **Single source of truth.** Each fact has one canonical home; everything else
  links to it. Do not restate the same thing in two places — link instead.
- **`docs/` is opt-in and public.** A document is published *only* because it
  was deliberately placed in `docs/`. Internal design notes, plans, scope docs,
  and threat-model gap analyses do **not** belong here — they are kept in a
  separate private repository.
- **README is a pointer.** The repository root `README.md` is a thin pointer
  into `docs/`. It is not a second documentation home; do not duplicate docs
  content there.
- **Write for users, not as a design archive.** Describe shipped behaviour.
  Strip MVP scope, phase plans, decision logs, and roadmap framing — those are
  internal.

## Conventions

- **Diátaxis sections.** Place each page under the section that matches its
  purpose: `getting-started/`, `guides/`, `concepts/`, `reference/`,
  `security-and-privacy/`.
- **Frontmatter drives ordering** — not filename number prefixes. Every page
  starts with YAML frontmatter:

  ```yaml
  ---
  title: Human-readable page title
  description: One sentence shown in listings and search.
  sidebar: Short nav label        # optional; defaults to title
  order: 10                       # optional; orders siblings within a section
  ---
  ```

- **kebab-case filenames.** Use `configure-an-idp.md`, not `03-OnboardingFlows.md`
  or `SCREAMING_CASE.md`. Drop numeric prefixes; let frontmatter `order` sort.
- **No hand-maintained file indexes.** Navigation derives from the folder and
  frontmatter. Do not write "Document Index" lists — they rot.
- **Portable Markdown.** Keep pages renderable as plain Markdown (they must read
  correctly on GitHub too). Mermaid fenced code blocks are fine — the site
  renders them to static SVG at build. No site-only components.
- **Fix relative links** when moving a page so they resolve within `docs/`.
