# The Project Itself as a Target

Files 01–07 treat trellis deployments as the thing under threat. This file
adds the working assumption the project operates under:

> **Threat-actor organizations monitor public projects. A platform core
> that openly ships anti-surveillance countermeasures should assume it is
> on their radar as an adversary — and a target for malicious activity —
> from the moment it is visible.**

The vendors in [01](./01-threat-landscape.md) run OSINT operations as their
core business; noticing a hostile open-source project is free for them.

## What is actually visible today

The GitHub repo is currently **private**, but visibility is not binary:

- The npm packages (`@de-otio/trellis`, `@de-otio/trellis-extension-api`)
  are **public**, and the published tarball ships `dist/` (readable compiled
  JS), the **full Prisma schema and migrations**, and `src/lambda`
  (`apps/api/package.json` `files` field + `prepack`).
- Therefore: the API surface, route patterns, rate-limit values, pagination
  caps, and any future detection logic that lands in code are **already
  inspectable by anyone**, repo visibility notwithstanding.
- `doc/` (including this threat model) is *not* published to npm and stays
  private while the repo does.

Two consequences: the "we're private" comfort is mostly an illusion for
*code*, and going public later changes less than it appears to — except for
the contribution and history surface, handled below.

## Design principle: no defense depends on code secrecy

Kerckhoffs's principle, applied: every defense in this threat model must
survive the adversary reading its implementation. Concretely:

- **Signal *types* may be public; operational *thresholds* may not be in
  code.** Detection thresholds, velocity limits, and friction settings live
  in runtime configuration (feature toggles / env — the E4 per-tenant
  toggle scoping in [08](./08-implementation-roadmap.md) is the mechanism),
  never as compiled-in constants. An adversary may know *that* synchronized
  follow cascades are flagged; they must not be able to read *at what rate*
  a given deployment flags them.
- **Evasion cost must come from economics, not obscurity** — friction,
  account aging, corroboration of independent signals
  ([03](./03-coordinated-inauthentic-behavior.md),
  [06](./06-registration-friction.md)) — because the algorithm itself is
  public.
- This is also why publishing this threat model (if/when the repo goes
  public) is acceptable: it documents *what* is defended, not the deployed
  parameters.

## Attack surface as a target

### 1. Release pipeline / supply chain

Current posture is **good**: npm Trusted Publishing via OIDC (no long-lived
token to steal), tag↔version verification before publish, least-privilege
workflow permissions (`contents: read`, `id-token: write`), lockfile-based
`npm ci` (`.github/workflows/publish.yml`).

Gaps:

- Actions pinned by major tag (`actions/checkout@v6`), not by commit SHA —
  a compromised action tag executes in the publish workflow.
- No automated dependency monitoring (no `dependabot.yml`); upstream
  dependency compromise is the most realistic vector for injecting code
  into every consuming vertical.
- No `--provenance` (requires a public source repo; add the day the repo
  goes public — sigstore attestation lets consumers verify the tarball was
  built from this repo by this workflow).

### 2. Malicious contribution (the XZ-utils pattern)

The long-game infiltration precedent: a patient, helpful contributor
earning commit trust over years, then landing a subtle backdoor in a
security-relevant project. Low risk while the repo is private; becomes the
**primary new risk the day it goes public**. Mitigations belong in the
go-public gate (below): CODEOWNERS on security-sensitive paths (detection,
moderation, audit, crypto, ActivityPub, release workflow), required review,
heightened scrutiny for new dependencies and for changes that *weaken*
detection or add outbound data flows.

### 3. Maintainer targeting

The avatar social-engineering threat in [01 §3](./01-threat-landscape.md)
applies to the project's maintainers, not just platform users: a plausible
"contributor" or "security researcher" building rapport is the same
playbook. With Trusted Publishing there is no npm OTP step — **GitHub
account compromise plus tag-push rights equals publish capability.** That
makes maintainer account hygiene (hardware-key 2FA on GitHub and npm) and
tag/branch protection part of the supply chain, and skepticism toward
unsolicited collaboration part of the operating posture.

### 4. Deployment reconnaissance

Public code means every consuming vertical's deployment has a **known API
surface on day one** — routes, defaults, error shapes are read from the
package, not probed. Implications: shipped defaults must be safe
(strengthens the default-on stance in
[06](./06-registration-friction.md) and the federation preconditions in
[05](./05-activitypub-exposure.md)), and deployment-specific topology,
account IDs, and parameters must never appear in this repo.

### 5. Adversarial vulnerability scanning

Public code is continuously scanned — by researchers and adversaries alike,
increasingly AI-powered. The project needs a disclosure channel
(SECURITY.md) and a fast patch-release path *before* the code is public, so
the first report has somewhere to go other than a public issue.

## The go-public gate

The repo may be opened deliberately or leak effectively (forks, vendored
copies). Before flipping visibility — treat as blocking, like the federation
preconditions in 05. The checklist now lives in one authoritative place:
**[doc/02-technical/development/go-public-gate.md](../development/go-public-gate.md)**.
This doc supplies the rationale (deployment reconnaissance, above); that doc
supplies the actionable gate.

Independent of the gate, two items were worth doing **now** (cheap, and the
npm tarball is already public): SHA-pin the publish workflow's actions, and
enable Dependabot — both done 2026-06-04. See
[08 §E8](./08-implementation-roadmap.md#e8-public-exposure-hardening-enables-this-file).
