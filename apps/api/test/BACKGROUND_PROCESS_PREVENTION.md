# Preventing Background Test Processes

## Problem

AI agents (like Cursor's AI) sometimes run test commands in the background during debugging and forget about them. This results in many 4GB+ Node.js processes running simultaneously, exhausting system memory.

## Solution: Workspace Rule

A workspace rule has been created at `.cursor/rules/no-background-tests.mdc` that:

- **Prevents** AI agents from running tests with `is_background: true`
- **Enforces** that all test commands run in foreground
- **Applies automatically** to all AI agent interactions

## Manual Cleanup

If you find orphaned test processes:

### Quick Check

```bash
# See all test processes
ps aux | grep -E "(vitest|jest|node.*test)" | grep -v grep
```

### Kill All Test Processes

```bash
# Using the helper script
npm run test:kill

# Or manually
pkill -f vitest
```

### Check Memory Usage

```bash
# See memory usage of Node processes
ps aux | grep node | awk '{print $2, $6/1024 "MB", $11}'
```

## Prevention Checklist

Before running tests, check:

- [ ] No existing test processes running (`ps aux | grep vitest`)
- [ ] Kill any orphaned processes if found
- [ ] Run tests in foreground (never background)
- [ ] Monitor memory usage during test runs

## Why Tests Should Never Run in Background

1. **Memory Consumption**: Each Vitest worker can use 4GB+ RAM
2. **Process Accumulation**: Background processes are forgotten and accumulate
3. **Resource Exhaustion**: Multiple 4GB processes quickly exhaust system memory
4. **Debugging Difficulty**: Background processes are hard to track and kill
5. **No User Control**: User can't see output or interrupt background processes

## What to Do Instead

### ✅ Correct: Foreground Execution

```bash
npm test              # Runs in foreground, user can Ctrl+C
npm run test:watch    # Runs in foreground, user can Ctrl+C
npm run test:coverage # Runs in foreground, user can Ctrl+C
```

### ❌ Wrong: Background Execution

```bash
# NEVER do this:
npm test &            # Background - BAD
nohup npm test &      # Background - BAD
```

## For AI Agents

When using `run_terminal_cmd` tool:

- **Always** set `is_background: false` for test commands
- **Never** set `is_background: true` for any test-related command
- **Always** wait for test completion before proceeding
- **Never** start new tests if previous ones are still running

## Related Files

- `.cursor/rules/no-background-tests.mdc` - Workspace rule (always applied)
- `scripts/kill-test-processes.sh` - Helper script to kill orphaned processes
- `test/MEMORY_USAGE_FIX.md` - Memory optimization fixes
