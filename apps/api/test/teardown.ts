/**
 * Test Teardown
 *
 * Global test teardown to clean up resources after all tests.
 * This prevents memory leaks from accumulating Prisma clients and connection pools.
 * Also ensures any spawned child processes are properly cleaned up.
 */

// Track spawned processes for cleanup
const spawnedProcesses: Set<number> = new Set();

/**
 * Track a spawned process PID for cleanup
 */
export function trackProcess(pid: number): void {
  spawnedProcesses.add(pid);
}

/**
 * Clean up a specific process
 */
function cleanupProcess(pid: number): void {
  try {
    // Try to kill the process gracefully (SIGTERM)
    process.kill(pid, "SIGTERM");
    spawnedProcesses.delete(pid);
  } catch (error) {
    // Process may already be dead, ignore
    spawnedProcesses.delete(pid);
  }
}

/**
 * Clean up all tracked processes
 */
function cleanupAllProcesses(): void {
  for (const pid of spawnedProcesses) {
    try {
      // Force kill if still running (SIGKILL)
      process.kill(pid, "SIGKILL");
    } catch (error) {
      // Process may already be dead, ignore
    }
  }
  spawnedProcesses.clear();
}

export async function teardown() {
  try {
    // Note: Tests no longer use direct database connections.
    // All tests use API endpoints instead.
    // The cleanupTestPrismaClient function is deprecated but kept for backward compatibility.

    // Clear all database connection pools to free memory
    // This is critical: each test worker can accumulate pools if not cleaned up
    const { sharedDatabaseConnectionManager } = await import(
      "../src/lib/database-connection-manager.js"
    );
    sharedDatabaseConnectionManager.clearPools();

    // Clean up any spawned child processes
    cleanupAllProcesses();

    // Force garbage collection hint (if available)
    // Run Node with --expose-gc flag to enable this: node --expose-gc ...
    if (typeof global !== "undefined" && (global as any).gc) {
      (global as any).gc();
    }
  } catch (error) {
    // Ignore teardown errors - tests may have already cleaned up
    console.warn("[test/teardown] Teardown warning:", error);
  }
}
