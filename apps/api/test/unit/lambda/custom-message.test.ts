/**
 * Unit Tests: Custom Message Lambda
 *
 * Tests for the Cognito custom message trigger that renders
 * email templates for different trigger sources.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

describe("CustomMessage Lambda", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.APP_DOMAIN = "trellis.test";
  });

  async function loadHandler() {
    const mod = await import("../../../src/lambda/custom-message.js");
    return mod.handler;
  }

  function makeEvent(triggerSource: string, codeParameter = "123456") {
    return {
      triggerSource,
      request: {
        codeParameter,
        usernameParameter: "testuser",
        userAttributes: { email: "user@example.com" },
      },
      response: {
        emailSubject: "",
        emailMessage: "",
        smsMessage: "",
      },
    } as any;
  }

  it("should render signup verification email with code", async () => {
    const handler = await loadHandler();
    const event = makeEvent("CustomMessage_SignUp", "ABC123");

    const result = await handler(event, {} as any, () => {});

    expect(result!.response.emailSubject).toBe("Verify your Trellis account");
    expect(result!.response.emailMessage).toContain("ABC123");
    expect(result!.response.emailMessage).toContain("Welcome to Trellis");
  });

  it("should render resend code email with code", async () => {
    const handler = await loadHandler();
    const event = makeEvent("CustomMessage_ResendCode", "XYZ789");

    const result = await handler(event, {} as any, () => {});

    expect(result!.response.emailSubject).toBe("Verify your Trellis account");
    expect(result!.response.emailMessage).toContain("XYZ789");
  });

  it("should render forgot password email with code", async () => {
    const handler = await loadHandler();
    const event = makeEvent("CustomMessage_ForgotPassword", "RESET1");

    const result = await handler(event, {} as any, () => {});

    expect(result!.response.emailSubject).toBe("Reset your Trellis password");
    expect(result!.response.emailMessage).toContain("RESET1");
    expect(result!.response.emailMessage).toContain("password reset");
  });

  it("should return event unmodified for unknown trigger sources", async () => {
    const handler = await loadHandler();
    const event = makeEvent("CustomMessage_AdminCreateUser", "CODE1");

    const result = await handler(event, {} as any, () => {});

    // emailSubject/emailMessage should remain at their initial values (empty or Cognito default)
    expect(result!.response.emailSubject).toBe("");
    expect(result!.response.emailMessage).toBe("");
  });

  it("should always return the event object", async () => {
    const handler = await loadHandler();
    const event = makeEvent("CustomMessage_SignUp");

    const result = await handler(event, {} as any, () => {});

    expect(result).toBeDefined();
    expect(result!.triggerSource).toBe("CustomMessage_SignUp");
  });
});
