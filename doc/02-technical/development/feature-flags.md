# Feature Flags

Feature flags are stored in DynamoDB and cached in-process for 5 minutes.

## DynamoDB key

```
pk:    "config:feature-toggles"
sk:    "all"
value: JSON string — { "flag-name": true/false }
```

## Managing flags

```bash
./scripts/ops/feature-flags.sh dev list              # list all flags
./scripts/ops/feature-flags.sh dev enable border-safety-mode
./scripts/ops/feature-flags.sh dev disable border-safety-mode
```

## Using flags in handler code

```typescript
import { getFeatureFlag } from "../lib/feature-flags";

const isEnabled = await getFeatureFlag(env, "border-safety-mode");
if (isEnabled) { ... }
```

## Cache

The `feature-flags.ts` module caches the full flag set from DynamoDB with a 5-minute TTL. A flag change takes effect within 5 minutes without a deploy.
