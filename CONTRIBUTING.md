# Contributing to Trellis

Thank you for your interest in Trellis.

## External contributions are not being accepted right now

Trellis is **source-available** (AGPL-3.0-or-later; see [`LICENSE`](LICENSE) and
[`COMMERCIAL.md`](COMMERCIAL.md)), but it is currently developed as a closed
effort. **We are not accepting external pull requests at this time.**

Unsolicited pull requests will most likely be closed unmerged — please don't
invest effort in a PR expecting it to be reviewed or accepted. This is not a
reflection on the contribution; the project simply isn't set up to take on
external code review and PR management yet.

**This may change.** If the project opens to outside contributions later, this
document will be updated and the contribution process (including the
[Contributor License Agreement](CLA.md) that keeps the dual-licensing model
possible) will be activated.

## What is welcome

- **Security reports.** If you've found a vulnerability, please follow
  [`SECURITY.md`](SECURITY.md) rather than opening a public issue or PR.
- **Bug reports.** If you're using Trellis (for example via `@de-otio/trellis`)
  and hit a defect, a clear issue with reproduction steps is appreciated, even
  though we may not be able to respond quickly.

## Using Trellis

Trellis is a platform *core* meant to be extended by vertical applications via
the extension API ([`packages/extension-api`](packages/extension-api), MIT
licensed). Building an extension does **not** require contributing to this
repository — see the [README](README.md) for how to register an extension.
