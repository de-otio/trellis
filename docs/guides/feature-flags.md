---
title: Feature Flags
description: How to manage and use runtime feature flags in Trellis.
sidebar: Feature Flags
order: 20
---

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
./scripts/ops/feature-flags.sh dev list
./scripts/ops/feature-flags.sh dev enable <flag-name>
./scripts/ops/feature-flags.sh dev disable <flag-name>
```

## Using flags in handler code

```typescript
import { getFeatureFlag } from "../lib/feature-flags";

const isEnabled = await getFeatureFlag(env, "flag-name");
if (isEnabled) { ... }
```

## Cache behaviour

The `feature-flags.ts` module caches the full flag set from DynamoDB with a 5-minute TTL. A flag change takes effect within 5 minutes without a redeploy.
