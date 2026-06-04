import type { PrismaClient } from "@prisma/client";
import { sharedDatabaseConnectionManager } from "./lib/database-connection-manager.js";

export interface EnvWithDb {
  DATABASE_URL: string;
  LOG_LEVEL?: string;
  DATABASE_CONNECTION_TIMEOUT_MS?: string;
  DATABASE_STATEMENT_TIMEOUT_MS?: string;
}

export type ManagedPrismaClient = PrismaClient & {
  release: () => Promise<void>;
};

export function createPrisma(env: EnvWithDb, region: string = "US"): ManagedPrismaClient {
  const managed = sharedDatabaseConnectionManager.acquireClient(region, env);
  const prisma = managed.client as ManagedPrismaClient;
  // No-op release — pool lifecycle managed by DatabaseConnectionManager.shutdown()
  prisma.release = async () => {};
  return prisma;
}

export async function withPrisma<T>(
  env: EnvWithDb,
  fn: (client: PrismaClient) => Promise<T>,
  region: string = "US",
): Promise<T> {
  const client = createPrisma(env, region);
  try {
    return await fn(client);
  } finally {
    await client.release();
  }
}

export async function withPrismaRetry<T>(
  env: EnvWithDb,
  queryFn: (client: PrismaClient) => Promise<T>,
  options: {
    region?: string;
    timeoutMs?: number;
    retryTimeoutMs?: number;
    maxRetries?: number;
    baseDelayMs?: number;
    defaultValue?: T;
    context?: Record<string, any>;
  } = {},
): Promise<T> {
  const { region = "US", ...rest } = options;
  return sharedDatabaseConnectionManager.executeWithRetry(region, env, queryFn, rest);
}

export function createPrismaForRegion(region: string, env: EnvWithDb): ManagedPrismaClient {
  return createPrisma(env, region);
}

export class DatabaseClient {
  static clearPoolCache(): void { sharedDatabaseConnectionManager.clearPools(); }
  static getPoolStatus() { return sharedDatabaseConnectionManager.getPoolStatus(); }
  static createForRegion(region: string, env: EnvWithDb): ManagedPrismaClient { return createPrisma(env, region); }
  static create(env: EnvWithDb, region: string = "US"): ManagedPrismaClient { return createPrisma(env, region); }
}
