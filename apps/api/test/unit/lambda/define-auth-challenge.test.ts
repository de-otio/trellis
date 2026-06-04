/**
 * Unit Tests: Define Auth Challenge Lambda
 *
 * Tests for the Cognito define auth challenge trigger that determines
 * the authentication flow based on session state.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

describe("DefineAuthChallenge Lambda", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  async function loadHandler() {
    const mod = await import("../../../src/lambda/define-auth-challenge.js");
    return mod.handler;
  }

  function makeEvent(session: any[] = []) {
    return {
      request: { session },
      response: {
        issueTokens: false,
        failAuthentication: false,
        challengeName: "",
      },
    };
  }

  it("should issue a CUSTOM_CHALLENGE when no prior attempts exist", async () => {
    const handler = await loadHandler();
    const event = makeEvent([]);

    const result = await handler(event);

    expect(result.response.issueTokens).toBe(false);
    expect(result.response.failAuthentication).toBe(false);
    expect(result.response.challengeName).toBe("CUSTOM_CHALLENGE");
  });

  it("should issue tokens when first challenge was answered correctly", async () => {
    const handler = await loadHandler();
    const event = makeEvent([
      { challengeName: "CUSTOM_CHALLENGE", challengeResult: true },
    ]);

    const result = await handler(event);

    expect(result.response.issueTokens).toBe(true);
    expect(result.response.failAuthentication).toBe(false);
  });

  it("should fail authentication when challenge was answered incorrectly", async () => {
    const handler = await loadHandler();
    const event = makeEvent([
      { challengeName: "CUSTOM_CHALLENGE", challengeResult: false },
    ]);

    const result = await handler(event);

    expect(result.response.issueTokens).toBe(false);
    expect(result.response.failAuthentication).toBe(true);
  });

  it("should fail authentication when there are multiple session entries (unexpected state)", async () => {
    const handler = await loadHandler();
    const event = makeEvent([
      { challengeName: "CUSTOM_CHALLENGE", challengeResult: true },
      { challengeName: "CUSTOM_CHALLENGE", challengeResult: true },
    ]);

    const result = await handler(event);

    expect(result.response.issueTokens).toBe(false);
    expect(result.response.failAuthentication).toBe(true);
  });

  it("should fail authentication when challenge name is not CUSTOM_CHALLENGE", async () => {
    const handler = await loadHandler();
    const event = makeEvent([
      { challengeName: "SRP_A", challengeResult: true },
    ]);

    const result = await handler(event);

    expect(result.response.issueTokens).toBe(false);
    expect(result.response.failAuthentication).toBe(true);
  });

  it("should always return the event object", async () => {
    const handler = await loadHandler();
    const event = makeEvent([]);

    const result = await handler(event);

    expect(result).toBe(event);
  });
});
