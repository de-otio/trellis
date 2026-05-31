/**
 * Fedify Test Fixtures
 *
 * Provides test fixtures and utilities for testing Fedify integration.
 * Uses @fedify/testing for mock actors and activities.
 */

import type { Actor } from "@fedify/fedify";
import { createMockEnv } from "./mock-env.js";
import type { Env } from "../../src/env.js";

/**
 * Create a mock User for testing
 */
export function createMockUser(overrides: Partial<any> = {}) {
  return {
    id: "user-123",
    username: "testuser",
    email: "test@example.com",
    actorUri: "https://example.com/users/testuser",
    inboxUrl: "https://example.com/users/testuser/inbox",
    outboxUrl: "https://example.com/users/testuser/outbox",
    followersUrl: "https://example.com/users/testuser/followers",
    followingUrl: "https://example.com/users/testuser/following",
    friendsUrl: "https://example.com/users/testuser/friends",
    publicKey: `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1234567890abcdefghij
klmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefghijklmn
opqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefghijklmnopqr
stuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefghijklmnopqrstuv
wxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefghijklmnopqrstuvwxyz
AB
-----END PUBLIC KEY-----`,
    privateKey: `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD1234567890abc
defghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefgh
ijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefghijkl
mnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefghijklmnopqr
stuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefghijklmnopqrstuvw
xyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefghijklmnopqrstuvwxyzAB
-----END PRIVATE KEY-----`,
    suspended: false,
    deletionConfirmedAt: null,
    ...overrides,
  };
}

/**
 * Create a mock Fedify Actor for testing
 */
export function createMockActor(overrides: Partial<Actor> = {}): Actor {
  return {
    id: new URL("https://example.com/users/testuser"),
    type: "Person",
    preferredUsername: "testuser",
    inbox: new URL("https://example.com/users/testuser/inbox"),
    outbox: new URL("https://example.com/users/testuser/outbox"),
    followers: new URL("https://example.com/users/testuser/followers"),
    following: new URL("https://example.com/users/testuser/following"),
    ...overrides,
  } as Actor;
}

/**
 * Create mock environment for Fedify tests
 */
export function createFedifyTestEnv(overrides: Partial<Env> = {}): Env {
  return createMockEnv({
    ACTIVITYPUB_BASE_URL: "https://example.com",
    APP_DOMAIN: "https://example.com",
    ...overrides,
  }) as Env;
}
