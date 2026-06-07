# Test Coverage

## Thresholds

All metrics enforced at **80%** in `apps/api/vitest.config.ts`:

```
lines: 80, functions: 80, branches: 80, statements: 80
```

## Running Coverage

```bash
npm run test:coverage                      # full coverage report
cd apps/api && npx vitest run --coverage   # from apps/api directory
```

Reports are generated in `apps/api/coverage/` (HTML, lcov, JSON).

## Current Status

| Metric | Value |
|--------|-------|
| Statements | 81.75% |
| Branches | 84.88% |
| Functions | 90.95% |
| Lines | 81.75% |

## Coverage Scope

- Includes: `src/**/*.ts`
- Excludes: `src/**/*.test.ts`, `src/**/*.d.ts`
- Provider: V8

## Improving Coverage

Focus on files with the most uncovered lines:

```bash
cd apps/api && npx vitest run --coverage 2>&1 | grep -E '^\s+src.*\.ts' | sort -t'|' -k5 -n | head -20
```

High-impact targets:
- Handler files (`src/lib/*-handler.ts`) — largest source files
- Route files (`src/lib/routes/*.ts`) — many untested branches
- Adapter files (`src/lib/kv/`, `src/lib/storage/`, `src/lib/queue/`)

For a prioritized list of coverage gaps and per-module requirements, see [Strategy](strategy.md).
