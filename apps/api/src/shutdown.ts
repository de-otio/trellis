/**
 * Graceful shutdown of the process-wide resources core owns.
 *
 * Core opens two pools lazily and holds them in module state: the shared
 * database connection manager (Prisma clients + pg pools) and the shared graph
 * service. Neither had a public entry point, so every consumer that needed to
 * release them — a standalone test lane, a script, a worker that boots the app
 * out of process — reached into `dist/lib/…` for the internals:
 *
 * ```ts
 * // what a consumer had to write, and what this replaces
 * const { sharedDatabaseConnectionManager } = await import(
 *   "@de-otio/trellis/dist/lib/database-connection-manager.js");
 * await sharedDatabaseConnectionManager.shutdown();
 * ```
 *
 * That is a false-affordance of the same family the `exports` map closes: the
 * only way to do a supported thing was to import an unsupported path. It also
 * blocks curating `dist/**` behind named subpaths, because those deep
 * specifiers are load-bearing for anyone running the server outside a
 * container.
 *
 * **Best-effort by construction.** Each step is attempted independently and a
 * failure in one does not prevent the others — a teardown that throws halfway
 * leaves sockets open, which is the problem it exists to solve. Failures are
 * returned rather than thrown so a caller that cares can report them.
 *
 * Idempotent: calling it twice is safe, and calling it when nothing was ever
 * opened is a no-op.
 */

/** What `shutdownTrellis()` managed to close, and what it could not. */
export interface ShutdownResult {
  /** Names of the subsystems that shut down cleanly. */
  closed: string[];
  /**
   * Subsystems that threw, with the error. Non-empty does NOT mean the process
   * is unhealthy — a pool that was never opened can fail to close.
   */
  failed: { subsystem: string; error: unknown }[];
}

async function attempt(
  subsystem: string,
  fn: () => Promise<void>,
  result: ShutdownResult,
): Promise<void> {
  try {
    await fn();
    result.closed.push(subsystem);
  } catch (error) {
    result.failed.push({ subsystem, error });
  }
}

/**
 * Release core's process-wide resources so the process can exit.
 *
 * Call from a `SIGTERM` handler, a test lane's teardown, or any script that
 * booted the server in-process. Does **not** stop an HTTP server — close the
 * `Server` returned by {@link startServer} first, then call this.
 *
 * @example
 * ```ts
 * const server = await startServer();
 * // …
 * server.closeAllConnections?.();
 * await new Promise<void>((r) => server.close(() => r()));
 * await shutdownTrellis();
 * ```
 */
export async function shutdownTrellis(): Promise<ShutdownResult> {
  const result: ShutdownResult = { closed: [], failed: [] };

  await attempt(
    "database",
    async () => {
      const { sharedDatabaseConnectionManager } =
        await import("./lib/database-connection-manager.js");
      await sharedDatabaseConnectionManager.shutdown();
    },
    result,
  );

  await attempt(
    "graph",
    async () => {
      const { closeSharedGraphService } = await import("./lib/graph/index.js");
      await closeSharedGraphService();
    },
    result,
  );

  return result;
}
