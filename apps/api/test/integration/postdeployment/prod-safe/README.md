# Prod-Safe Postdeployment Tests

Tests in this directory are permitted to run against the production environment.

## Rules — all four must hold for a test to live here

1. Uses `requireEnvironment(['dev', 'prod'])` instead of `requireDevEnvironment()`
2. Never creates, updates, or deletes any data (reads only)
3. Has a `// PROD-SAFE: read-only` comment at the top of the file
4. Has been reviewed and explicitly approved as read-only

## Candidate tests from the parent directory

The following tests are likely read-only and could be promoted here after review:

- `database-schema.test.ts` — reads schema metadata only
- `feature-toggles.test.ts` — reads toggle state (verify no writes before promoting)

## How to move a test here

1. Audit for any `POST`, `PUT`, `PATCH`, `DELETE` calls or direct DB writes — there must be none
2. Replace `requireDevEnvironment()` with `requireEnvironment(['dev', 'prod'])` in `beforeAll`
3. Add `// PROD-SAFE: read-only` as the first line of the file
4. Update this README with the promoted test

## Template

```typescript
// PROD-SAFE: read-only
import { describe, it, expect, beforeAll } from 'vitest';
import { requireEnvironment } from '../../../utils/test-environment-guard';

describe('Feature: <name> (read-only)', () => {
  beforeAll(() => {
    requireEnvironment(['dev', 'prod']);
  });

  it('should <verify something without writing>', async () => {
    // read-only assertions only
  });
});
```
