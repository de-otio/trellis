# The go-public gate

**Status: blocking.** Treat this like the ActivityPub enablement preconditions
in
[surveillance-threat-model/05](../surveillance-threat-model/05-activitypub-exposure.md):
the repository's visibility **must not** be flipped from private to public
until every item below is satisfied. The repo may also be opened *effectively*
— by forks or vendored copies — so the npm tarball already being public does
not exempt these.

This is the single authoritative copy of the gate. The threat-model rationale
for why each item matters is in
[surveillance-threat-model/09 §deployment reconnaissance](../surveillance-threat-model/09-public-project-exposure.md).

## Checklist

- [ ] `SECURITY.md` with a private disclosure channel and a response
      expectation (so the first report has somewhere to go other than a public
      issue).
- [ ] CODEOWNERS + required review on security-sensitive paths (detection,
      thresholds, retention, auth) and `.github/workflows/`.
- [ ] Branch protection on `main`; tag protection on `v*` / `extension-api-v*`
      (those tags trigger publish).
- [ ] Actions pinned by commit SHA in all workflows. *(Done 2026-06-04, E8.)*
- [ ] Secret scanning + push protection enabled.
- [ ] `--provenance` added to `npm publish` (requires the public source repo;
      see `CLAUDE.md` npm Trusted Publishing notes).
- [ ] History audit: no customer/engagement names, internal hostnames, or
      account IDs anywhere in git history.
- [ ] Hardware-key 2FA verified on all maintainer GitHub + npm accounts.

Two items are worth doing **now**, independent of the gate (cheap, and the npm
tarball is already public): SHA-pin the publish workflow's actions and enable
Dependabot — both completed 2026-06-04 (E8).
