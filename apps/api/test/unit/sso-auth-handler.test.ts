/**
 * Deprecation contract tests for SSOAuthHandler.
 *
 * Legacy Supabase/SAML SSO paths have been removed; Cognito handles auth.
 * Every method on SSOAuthHandler must permanently return HTTP 410 with
 * `{ error: "Deprecated" }`. These tests lock that contract so nobody
 * can silently re-enable a legacy SSO path that returns 200.
 */

import { describe, expect, it } from "vitest";
import { SSOAuthHandler } from "../../src/lib/sso-auth-handler.js";

const METHODS = [
  "initiateSSO",
  "handleSSOCallback",
  "handleSSOExchange",
  "handleTokenExchange",
] as const;

type MethodName = (typeof METHODS)[number];

describe("SSOAuthHandler — deprecation contract", () => {
  const handler = new SSOAuthHandler();

  it.each(METHODS)("%s returns status 410", async (method: MethodName) => {
    const response = await handler[method]("dummy-arg-1", "dummy-arg-2");
    expect(response.status).toBe(410);
  });

  it.each(METHODS)("%s body equals { error: 'Deprecated' }", async (method: MethodName) => {
    const response = await handler[method]("dummy-arg-1", "dummy-arg-2");
    const body = await response.json();
    expect(body).toEqual({ error: "Deprecated" });
  });

  it.each(METHODS)("%s tolerates no arguments", async (method: MethodName) => {
    const response = await handler[method]();
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body).toEqual({ error: "Deprecated" });
  });
});
