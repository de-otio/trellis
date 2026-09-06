# Release checklist

> Migrated verbatim from the repository's former `CLAUDE.md` (2026-09-06).
> Cutting a release is a **human** action: agents do not push tags.

Trellis ships via npm. Three tag-triggered publish flows exist
(`.github/workflows/publish.yml`):

- `extension-api-v<x.y.z>` → publishes `@de-otio/trellis-extension-api`
- `extension-testkit-v<x.y.z>` → publishes `@de-otio/trellis-extension-testkit`
- `v<x.y.z>` → publishes `@de-otio/trellis` (the api package)

The `v` prefix is a prefix of the other two, so the workflow matches
longest-first. Adding a fourth series means adding its arm **above** `v*`.

Before tagging:

- [ ] Tests + lint pass on `main`
- [ ] `packages/extension-api/package.json` and `apps/api/package.json` versions
      match the tags you are about to push
- [ ] If extension-api is bumped, `apps/api`'s
      `@de-otio/trellis-extension-api` constraint accepts the new version (an
      npm caret on `0.x` only allows patch)
- [ ] `package-lock.json` is updated to match

**A `peerDependencies` range may only name a version that is already
published.** npm resolves peer ranges against the registry even for a workspace
package, so a floor with no matching version fails `npm ci` at the repo root
with `ETARGET` and takes every CI job down with it. Version numbers live in the
release commit, so during development the newest core is the _last published_
one — which means a package here can never express "I need the release that is
about to happen" through its peer range.

The testkit hits this whenever it starts calling a core member no release
exports yet — as it did at birth, needing `shutdownTrellis`,
`classifyApiVersion` and `EXTENSION_API_VERSION`, none of which existed in a
published core before `0.25.0-alpha.8`. So its peer range names the newest
published core and its `MINIMUM_CORE_VERSION` constant names the real
requirement, running ahead until the release that closes the gap.
`assertCoreShape()` enforces the constant at load time by reading the module.
Do not "reconcile" the two by raising the range ahead of a release — that is the
change that broke CI — and do not lower the constant; `smoke-pack.sh` fails if
the constant ever falls _below_ the range floor.

The two are equal today. That is the resting state, not an invariant: the check
is deliberately directional, because demanding equality would forbid the bump
that opens the gap legitimately and put you back in `ETARGET`.

**Ordering constraint for the testkit.** Publish core first, then the testkit.
An install against an older core resolves cleanly and fails at boot; the error
names what is missing, but a good error is not a substitute for the right order.

After tagging, watch the workflow run and confirm the version is on npm with
`npm view <pkg> versions --json --registry=https://registry.npmjs.org`.
`npm view` lags the registry by a minute or so; a `curl` of the registry URL is
the faster confirmation.
