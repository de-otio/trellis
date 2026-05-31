# Impact on Existing References — Completed

All renames below have been applied.

## Package Renames (Phase 2)

| Before | After |
|--------|-------|
| `@trellis/extension-api` | `@trellis/extension-api` |
| `@trellis/crypto` | `@trellis/crypto` |
| `@trellis/api` | `@trellis/api` |
| `@trellis/infra` | `@trellis/infra` |
| `trellis-monorepo` | `trellis-monorepo` |
| `TrellisExtension` | `TrellisExtension` |

**Unchanged:** `@trellis/ext-dogs` (belongs to Trellis vertical)

## Infrastructure Parameterization (Phase 3)

| Before (hardcoded) | After (parameterized) |
|--------------------|-----------------------|
| `/trellis/{stage}/...` SSM paths | `ssmPath(config.appName, stage, key)` |
| `{stage}-trellis` DynamoDB table | `${stage}-${config.appName}` |
| `Trellis-{stage}-Api` stack names | `stackPrefix(config)-Api` |
| `trellis-{stage}-*` resource names | `resourceName(config, suffix)` |
| `trellis-{stage}` ECS cluster | `${config.appName}-${stage}` |
| `/trellis/{stage}/api` log groups | `/${config.appName}/${stage}/api` |

**Config default:** `appName: "trellis"` — existing behavior preserved.

## Unchanged (Product Identity)

| Reference | Reason |
|-----------|--------|
| `example.com` / `dev.example.com` | Product domain |
| `@test.example.com` | Test email domain |
| `trellis://auth/callback` | Deep link URI scheme |
| `richard.myers@example.com` | Alert email |
| `trellis_dev` / `trellis_test` Postgres | Local dev convenience |
| Legal docs (terms, privacy) | Product content |
