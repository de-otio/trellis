# `.claude/` — shared agent roster

This directory is the **shared, committed** Claude Code configuration for this
repo. It is reviewable as a normal diff, and it is deliberately narrow.

## What is here

| Path | Committed? | Purpose |
|---|---|---|
| `settings.json` | yes | Shared project permissions (read allowlist, secret-read denials, `ask` on destructive/publishing commands). |
| `agents/*.md` | yes | Sub-agent definitions available to anyone working in this repo. |
| `settings.local.json` | **no** — gitignored | Personal/machine-specific preferences. Never commit. |
| `.cc-writes/`, `worktrees/`, `projects/` | **no** — gitignored | Local session scratch state. |

## Roster

| Agent | Use it for |
|---|---|
| `doc-sweeper` | Multi-file documentation sweeps — returns distilled findings instead of dumping files into the caller's context. |
| `security-reviewer` | Adversarial review of designs and code: auth bypass, crypto, race conditions, abuse at scale. |
| `security-best-practices` | Reference checklist for a repo whose code is public and machine-scannable. |
| `test-critic` | Adversarial review of an existing test suite — finds bugs the tests would *not* catch. |

## Security rules for anything added here

Files in this directory are executed as instructions by an agent working in
this repo, so additions are held to three gates:

1. **Every file is read in full before it is committed.** No blind copying from
   another machine or repo.
2. **No MCP server entry pointing outside the `de-otio` org.** Committed agent
   definitions may reference first-party MCP tools only; a third-party MCP
   server belongs in an individual's untracked `.mcp.json`, not here.
3. **No hook that executes on open** — no `postCreateCommand` or equivalent
   `SessionStart`-style command. Nothing in this directory may run code merely
   because someone opened the repo.

Anything that fails a gate is rejected or stripped, and the reason is stated in
the pull request that proposes it.

## Provenance

The agent definitions are synced from a personal Claude Code toolkit repo
(MIT-licensed). They are copied verbatim; changes made here should be mirrored
back upstream rather than silently diverging.
