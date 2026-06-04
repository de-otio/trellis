/**
 * Test Setup
 *
 * Global test configuration and setup.
 */

import dns from "node:dns";
import nodeCrypto from "node:crypto";
import { configureRootLogger } from "@de-otio/saas-foundation/logger";

configureRootLogger({ level: "silent" });

// Set test environment
process.env.NODE_ENV = "test";

// Configure DNS based on environment
// - Local: Prefer IPv4 (fallback if IPv6 is unavailable)
// - CI (GitHub Actions): Force IPv4 since GitHub runners may not support IPv6
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";

if (dns.setDefaultResultOrder) {
  // Use ipv4first for both CI and local development as a safe default
  dns.setDefaultResultOrder("ipv4first");
  console.log(
    "[test/setup] DNS configured to prefer IPv4",
  );
}

// Mock environment variables
// For postdeployment tests, don't override SESSION_SECRET or DATABASE_URL - let it use SSM or actual env var
// For unit tests, use test values
const isPostdeploymentTest =
  process.env.VITEST_CONFIG?.includes("postdeployment") ||
  process.argv.some((arg) => arg.includes("postdeployment"));

// CRITICAL: For post-deployment tests, clear ALL test database URLs FIRST
// This must happen before any other setup to prevent test URLs from being used
if (isPostdeploymentTest) {
  // Aggressively clear all test database URLs
  delete process.env.DATABASE_URL;
  delete process.env.DIRECT_DATABASE_URL;
  delete process.env.trellis_dev_database_hyperdrive_url;
  delete process.env.trellis_dev_database_hyperdrive_url;

  // Also clear any other environment variables that might contain test URLs
  Object.keys(process.env).forEach((key) => {
    const value = process.env[key];
    if (
      value &&
      (value.includes("test-hyperdrive-id") ||
        value.includes("test-hyperdrive"))
    ) {
      console.warn(`[test/setup] Clearing test database URL from ${key}`);
      delete process.env[key];
    }
  });
} else {
  // For unit tests, use test values
  process.env.SESSION_SECRET = "test-secret-key-32-characters-long!!";
  // For unit tests, use test database URLs
  process.env.DATABASE_URL =
    "postgresql://test-hyperdrive-id.hyperdrive.workers.dev:5432/postgres";
}
process.env.ENVIRONMENT = "dev";
process.env.APP_DOMAIN = "https://test.example.com";

// Suppress expected error logs during tests
// These are intentional error messages from error-handling tests
// We filter them out to avoid cluttering test output with expected errors
const originalConsoleError = console.error;
console.error = ((...args: any[]) => {
  // Only suppress known expected error patterns
  const message = args[0]?.toString() || "";
  if (
    message.includes("KV rate limit check failed") ||
    message.includes("[UserDeprovisioning] Failed to")
  ) {
    // Suppress expected error logs - these are part of error-handling tests
    return;
  }
  // Allow other errors through
  originalConsoleError.apply(console, args);
}) as typeof console.error;

// Mock global crypto if needed (for Node.js environment)
if (typeof globalThis.crypto === "undefined") {
  // In Cloudflare Workers, crypto is available globally
  // In Node.js tests, we might need to polyfill
  if (nodeCrypto.webcrypto) {
    (globalThis as any).crypto = nodeCrypto.webcrypto;
  }
}

// Note: Test timeout is configured in vitest.config.ts
// Global teardown is configured in test/teardown.ts
