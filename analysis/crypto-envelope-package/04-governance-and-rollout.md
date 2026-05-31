# Governance and Rollout

## License and repo

| | Decision | Rationale |
|---|---|---|
| License | MIT | Matches `@de-otio/agent-safety-pack`, `@de-otio/chaoskb`, and every other public de-otio package. Maximum reuse; minimum friction. |
| Repo | `github.com/deotio/crypto-envelope` | Public. Matches the pattern of agent-safety-pack being on github.com/de-otio. |
| npm scope | `@de-otio/` | Scoped; matches sibling packages. Org-registered on npmjs.com. |
| Required files | `README.md`, `LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` | Matches agent-safety-pack's file layout. SECURITY.md is non-optional for a crypto library. |

## Publishing

Follow [dot-notes/doc/supply-chain-attack-mitigations.md](../../../dot-notes/doc/supply-chain-attack-mitigations.md) exactly — this is de-otio's own published supply-chain guidance, and a crypto library is the single most load-bearing place to apply it.

- `npm publish --provenance` — Sigstore-signed SLSA attestation on every release
- **Trusted Publishing** (OIDC-bound github.com/deotio/crypto-envelope → `@de-otio/crypto-envelope`). No stored npm tokens. Even if a maintainer account is compromised, the attacker cannot publish.
- **2FA required** on every maintainer account.
- **Scoped package only** — no unscoped alias, no vanity name, nothing to typosquat against.
- Every release signed; `npm audit signatures` passes in CI.
- Pin GitHub Actions by commit SHA, not tag. (tj-actions/changed-files attack in March 2025 exploited tag-based pinning.)

## Semver and wire-format policy

The standard semver rules, plus one extra commitment:

- **Wire format v1 is frozen at v1.0.0.** Any v1.x release must be able to decrypt any envelope produced by any prior v1.x release. A change to the envelope bytes is a v2 format → new package major (v2.0.0). No exceptions.
- **New algorithms are additive.** Adding a new `alg` or `kid` value to the registry is a minor-version bump. Decrypt-support for the new algorithm ships first; encrypt-support ships a release later so that consumers opt in.
- **Removal is hard.** Dropping decrypt support for a deployed algorithm is a major bump, telegraphed at least 12 months in advance, with a clear migration path.
- **`/primitives` entry point has a weaker stability contract.** Documented explicitly as such. Breaking changes still require a major bump but we reserve the right to reshape them more aggressively.

## Test vectors as a published artifact

The envelope spec in chaoskb (`doc/design/envelope-spec.md`) already calls for test vectors. The public package ships them as **three complementary artifacts**:

1. **`test-vectors.json`** in the repo — canonical set, machine-readable, covering every `alg` / `kid` combination and key edge cases (zero-length plaintext, max-length, AAD variations, failure cases).
2. **`npm package export** — consumers can `import { testVectors } from '@de-otio/crypto-envelope/test-vectors'` and run them against their own implementation. Especially useful for the future Dart/Flutter port.
3. **Published spec doc** — envelope-spec.md copied to a public docs site or pinned in the repo. Other-language ports reference this as the source of truth.

Adopting age-encryption's discipline here. It's what makes a crypto library trustable by implementers outside de-otio.

## SECURITY.md + disclosure posture

The package is published for transparency and reference, not as a supported product (see the maintenance posture in [`README.md`](README.md)). The disclosure posture reflects that reality — a real process, not an SLA.

At minimum:

- A `security@de-otio.org` email with PGP key on file
- Commitment to **respond honestly** — an acknowledgement when a report arrives, an honest assessment of whether and when it can be addressed, and no pretending that a small maintainer team has large-team response capacity.
- Coordinated disclosure: 90 days default, negotiable, earlier if actively exploited. If de-otio cannot fix the issue in time, the report is disclosed anyway with a mitigation the consumer can apply (pin to a specific version, switch algorithms, migrate off).
- Public CVE issuance via GitHub's security advisory tooling when warranted.
- A policy on what "severe enough to yank a release" looks like: exploitable with public code, or breaks confidentiality/integrity claims in the threat model.
- List of known-bad versions in CHANGELOG + npm deprecation when appropriate.

**Not promising:** a 72-hour acknowledgement SLA, dedicated on-call rotation, paid-support tiers, or in-house crypto auditors on retainer. Overclaiming disclosure capacity is itself a security anti-pattern — it gives reporters false expectations and produces worse outcomes than honest communication.

Publishing a crypto library without *any* disclosure process would be irresponsible; publishing one with a pretend-SLA would be worse. The middle ground is to be clear about what the maintainers can and cannot do, and to structure the codebase and release cadence so that honest best-effort response is enough.

## Automated security pipeline (required from day one)

The honest maintenance posture ([`README.md`](README.md)) explicitly does not promise dedicated security engineering capacity. That makes automated review load-bearing — it's how a small-maintainer crypto library maintains a credible quality bar without over-promising human hours.

The reference integration is the **anthropic-defense** pipeline ([`~/Downloads/anthropic-defense/`](../../../../Downloads/anthropic-defense/), 2026-04-12 — this location is temporary; move the contents into `dot-notes` or into the new repo's `.github/` directory before it gets lost). It ships six copy-paste GitHub Actions workflows powered by Claude, plus a `CLAUDE.md` with persistent security-review instructions:

| Workflow | Trigger | Role |
|---|---|---|
| `security-review.yml` | Every PR | AI reviews the diff for vulnerabilities, posts inline comments. First line of defence against a subtle crypto bug slipping into a merge. |
| `weekly-security-audit.yml` | Monday 07:00 UTC + manual | Full-codebase deep audit, creates a GitHub Issue. Catches things that only show up in whole-repo context (e.g. key derivation inconsistencies across files). |
| `claude-agent.yml` | `@claude` mention in PRs/issues | Interactive security assistant — lets a reviewer ask "is this constant-time?" or "does this path touch the commitment key?" without needing a human cryptographer on call. |
| `dependency-scan.yml` | PRs touching lockfiles + weekly | `npm audit` with AI triage of findings. Prevents a vulnerable transitive dep from landing via a routine bump. |
| `secrets-scan.yml` | Every PR + push to main | gitleaks + grep for hardcoded credentials. A crypto library cannot ship with an accidental test key in plaintext. |
| `CLAUDE.md` | Always in repo root | Persistent instructions scoping Claude's review to crypto-specific concerns (nonce handling, constant-time operations, key separation, AAD binding). |

**What this costs.** Per the anthropic-defense README, ~$2–25/month total for a 50-PR/month project depending on model choice (Sonnet for PR reviews is the low end; Opus for weekly audits is the high end). Two orders of magnitude cheaper than a formal external audit, and runs continuously rather than being a point-in-time snapshot.

**What it does not replace.** Automated review is not a substitute for the deterministic quality bar — the test vectors, the typestate API, the safe-by-construction rules in [`03-package-design.md`](03-package-design.md), the verify-after-encrypt pattern. It's a second layer that catches what the first layer missed. Same composition-of-defences stance as `@de-otio/agent-safety-pack` (deterministic pattern matching first, LLM evaluation second).

**Integration work for the new repo.** Copy the six workflow files into `.github/workflows/`, copy `CLAUDE.md` to the repo root, add `ANTHROPIC_API_KEY` as a repository secret, tune the `CLAUDE.md` system prompt for crypto-specific review concerns (nonce reuse, constant-time comparisons, key separation, AAD, commitment verification — the list from [`05-mistakes-prevented.md`](05-mistakes-prevented.md) is the natural seed). Estimated 30 minutes of setup. This is Phase 0 work — must be in place before the v0.x internal-use phase begins, not a later addition.

---

## Phased roadmap

| Phase | Version | What | Gate |
|---|---|---|---|
| 1 | **v0.1–v0.x** (internal only) | Extract from chaoskb, consumed by chaoskb + trellis. `"private": true`. Breaking changes permitted freely. | Chaoskb + trellis both run on it for 1–2 months without issue. |
| 2 | **v0.9 pre-release** | Remove `"private": true`, publish to npm under a `-rc` tag. Pin docs + spec. Solicit outside review from any crypto-aware reader who's willing — no obligation to land a formal audit. | Honest readme reflecting maintenance posture; no critical findings from informal review still outstanding. |
| 3 | **v1.0.0** (public) | Freeze wire format. Publish test vectors. Announce quietly — a "this exists" post in communities where it may be useful, not a marketing push. | Clean v0.9 run for 2–4 weeks. |
| 4 | **v1.x** | Additive-only. New algorithms, new tiers, new platform adapters (SSH, WebAuthn). Bugfixes. Never breaks decrypt of prior envelopes. | Ongoing — as long as chaoskb, trellis, or other internal projects depend on the package. |
| 5 | **v2.0** (if it happens) | Wire-format upgrade — e.g. post-quantum KEM for key wrap, new AAD binding, etc. Announced at least a year in advance. | Only if genuinely needed by an internal project. No fashion-driven upgrades. |

Realistic calendar guess, only as rough sizing:

- Phase 1: ~1 month (mostly mechanical extraction + both consumers swapping over)
- Phase 2: ~2–4 weeks (polish, docs, informal outside reads)
- Phase 3: the public-flip event itself, one day
- Phase 4: indefinite — for as long as internal projects rely on it
- Phase 5: years out, not scheduled; may never happen

The roadmap implicitly assumes the package remains useful to de-otio projects. If that stops being true (e.g. the underlying primitives shift enough that a fresh start makes more sense, or de-otio pivots away from the encrypted-data-by-default apps that consume the package), the package is archived with a clear notice — not abandoned quietly.

## Risks

| Risk | Mitigation |
|---|---|
| **Disclosure load.** A public crypto library attracts reports — some valuable, some noise. Can consume significant maintainer time. | Clear SECURITY.md with scope; use GitHub's security advisory system to triage in public; rely on the @de-otio brand lineup to share on-call rotation if more than one maintainer. Don't publish until there's a realistic plan for who responds to a 2am PGP-signed email. |
| **Scope creep.** "Can you add this algorithm / this protocol / this platform" is endless. | The [what-this-is-not section of 02-de-otio-alignment.md](02-de-otio-alignment.md#what-this-package-is-not) is the first line of defense. A published scope statement in the README is the second. |
| **Audit cost / pressure.** Formal external audits run $30–80k for a library this size. De-otio is a small org and will not be commissioning one on its own timetable. | Don't gate any phase on a paid audit. Informal external reads from crypto-aware readers are the actual quality bar. If a downstream consumer (internal or external) wants to fund a formal audit, cooperate — but the package's value proposition does not depend on one, and the maintenance posture explicitly does not promise one. |
| **Export control.** Encryption software is export-controlled in the US under EAR. | Open-source and published via GitHub generally falls under license exception TSU (publicly available). File a one-time self-classification (no license required for unrestricted open-source encryption). Counsel can confirm; this is a well-trodden path. |
| **Breaking changes pressure.** Pull requests / issues that would silently break wire compatibility. | Clear contributor guide: wire format is sacred, v1.x is additive-only, any wire-breaking change is a v2 proposal that goes through a separate process (RFC-style). |
| **Competing implementation emerges upstream.** @noble or similar may ship a competing envelope lib. | Fine. The market tolerates multiple good libraries. The advantage de-otio starts with is the chaoskb + trellis anchor-tenant status + the Lebensfreude / agent-first angle. If @noble later ships one and it's better, migrate and deprecate. Not a threat. |

## Migration plan for chaoskb and trellis

Sequenced to minimize risk:

1. **Extract.** Lift `chaoskb/src/crypto/` files (per [03-package-design.md](03-package-design.md#what-comes-along-from-chaoskb)) into the new repo. Keep API compatible so chaoskb's call sites don't change.
2. **Publish v0.1.0 privately** to dot/npm CodeArtifact.
3. **Chaoskb migrates first.** Delete `src/crypto/`; add `@de-otio/crypto-envelope@^0.1.0` dependency; run the full test suite. Chaoskb is the canary.
4. **Trellis migrates second.** Replace `@trellis/crypto` with a re-export shim over `@de-otio/crypto-envelope`. Re-run trellis's test suite. Both consumers stable for 1–2 months.
5. **v0.9 and external read.** Flip `private: false`, publish to npm under an `-rc` tag, publish spec + test vectors, ask 2–3 external readers. Incorporate findings.
6. **v1.0 public release.** Announce on GitHub, on the de-otio website, in relevant communities (local-first, indie hackers, r/selfhosted as appropriate — not a marketing blast, more a "this exists now" post).
7. **Retire `@trellis/crypto`.** Once v1.0 is stable, remove the re-export shim and update trellis call sites to import `@de-otio/crypto-envelope` directly.

Total timeline from go-decision to public GA: **3–6 months** depending on how much time goes to external review and audit prep.
