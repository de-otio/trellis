# Separation Phases

The separation has **5 phases**. Phases 1-3 happen in the current monorepo
before any repo split. Phase 4 is the actual split. Phase 5 is cleanup.

## Phase 1: Complete the Remaining Extraction Work — DONE

All extraction items from `../12-status-and-remaining-work.md` are closed:

- [x] AP actor serialization converged on Fedify dispatcher
- [x] Feed/recommendation strategy delegation wired
- [x] Inbox rate limiting + entity WebFinger implemented
- [x] Flutter physical file move completed
- [x] Life-stage computation delegated via `TrellisExtension.computeLifeStage`
- [x] Extension registry made programmatic (`registerExtension()`)

## Phase 2: Decouple npm Scopes — DONE

Completed 2026-04-05.

- [x] `@trellis/extension-api` → `@trellis/extension-api`
- [x] `@trellis/crypto` → `@trellis/crypto`
- [x] `@trellis/api` → `@trellis/api`
- [x] `@trellis/infra` → `@trellis/infra`
- [x] `TrellisExtension` → `TrellisExtension` (TS + Dart)
- [x] `@trellis/ext-dogs` kept as vertical package name

## Phase 3: Parameterize Remaining Trellis References — DONE

Completed 2026-04-06.

- [x] `appName: string` added to `StageConfig` (default `"trellis"`)
- [x] `ssmPath(appName, stage, key)` — central SSM path function parameterized
- [x] `resourceName(config, suffix)` — helper for `{appName}-{stage}-{suffix}`
- [x] `stackPrefix(config)` — helper for `{AppName}-{stage}` CloudFormation names
- [x] All 11 CDK stacks updated
- [x] All CI workflows use `APP_NAME` env var
- [x] All deploy/ops scripts use `APP_NAME="${APP_NAME:-trellis}"`
- [x] Lambda tools read log group from env var
- [x] Grafana dashboard JSON templates use `${APP_NAME}` placeholder
- [x] `cdk.context.json` deleted (regenerated on next synth)
- [x] Core has zero imports from any extension package

## Phase 4: Split the Repositories

### Approach: Extract core into new repo (Option A)

1. Create private GitHub repo for Trellis
2. Use `git filter-repo` to create a clean copy with only core paths,
   preserving full git history for those files
3. In the Trellis repo, remove core source and add Trellis as npm dependencies
4. Trellis becomes a thin app shell: `server.ts` imports Trellis core, registers
   the dogs extension, and deploys

### Mechanical steps

```bash
# 1. Create filtered clone with core paths only
git clone trellis trellis-extract
cd trellis-extract
git filter-repo \
  --path packages/ \
  --path prisma/ \
  --path apps/api/ \
  --path infra/ \
  --path scripts/ \
  --path CLAUDE.md \
  --path package.json \
  --path tsconfig.json

# 2. Push to new private repo
git remote add origin git@github.com:[org]/trellis.git
git push -u origin main

# 3. Set up CodeArtifact publishing
# (configure .npmrc to publish @trellis/* to the CodeArtifact domain)

# 4. In trellis repo, configure CodeArtifact as registry for @trellis scope
echo "@trellis:registry=https://[domain]-[account].d.codeartifact.[region].amazonaws.com/npm/[repo]/" >> .npmrc

# 5. Install core as dependency
npm install @trellis/api @trellis/extension-api @trellis/crypto
```

### What stays in Trellis repo

- `extensions/dogs/` — the `@trellis/ext-dogs` package
- `apps/flutter/` — the dog-focused Flutter app
- `server.ts` — entry point that wires Trellis + dogs extension
- Deploy config overriding `appName: "trellis"`, domain, etc.

## Phase 5: Post-Split Cleanup

- [ ] Set up CodeArtifact domain and npm repository for `@trellis/*` packages
- [ ] Configure CI/CD in Trellis repo (publish to CodeArtifact on merge)
- [ ] Configure CI/CD in Trellis repo (pull from CodeArtifact, deploy)
- [ ] Trellis repo gets its own CLAUDE.md, README
- [ ] Trellis ships an example extension to demonstrate the pattern
- [ ] Trellis's `package.json` lists `@trellis/*` with semver ranges
- [ ] Verify Trellis deploys cleanly with Trellis as external dependency

## Ready to Split

All prerequisites are met (as of 2026-04-06):

1. All extraction items closed (Phase 1)
2. npm scope rename done (Phase 2)
3. Infrastructure parameterized (Phase 3)
4. `extensions/dogs/` has zero direct imports from `apps/api/src/lib/`
5. Core has zero imports from any extension package
6. Extension registry is programmatic (no static extension imports in core)
7. All 5681 tests pass across all workspaces

The split is now a mechanical `git filter-repo` operation, not an architectural
change.
