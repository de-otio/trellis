# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
pull requests, or discussions.**

Report privately through either channel:

1. **GitHub private vulnerability reporting** (preferred) — use the
   **"Report a vulnerability"** button under this repository's **Security** tab.
2. **Email** — <security@de-otio.org>.

Please include enough detail to reproduce: affected version or commit, a
description of the issue, reproduction steps or a proof of concept, and the
impact you foresee.

## What to expect

Trellis is maintained on a best-effort basis. We will acknowledge a valid
report and work on a fix, but we do **not** commit to fixed response or
remediation timelines, and there is **no bug-bounty program**. Please act in
good faith: give us reasonable time to address an issue before any public
disclosure, and avoid privacy violations, data destruction, or service
degradation while researching.

## Scope

This repository is the Trellis platform *core* (`@de-otio/trellis` and
`@de-otio/trellis-extension-api`). It is distributed as an npm library and is
**not** deployed as a standalone service from this repository, so findings
should concern the library code, its handlers, and its documented security
posture rather than any particular live deployment.

The [`doc/02-technical/surveillance-threat-model/`](doc/02-technical/surveillance-threat-model/)
tree describes the threat model the design targets; reports that sharpen or
contradict it are especially useful.

## Supported versions

Only the latest published version on the `main` branch receives security
fixes. Older versions are not patched.
