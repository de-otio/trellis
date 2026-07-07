/**
 * Unit Tests: Email Provider
 *
 * Tests for email provider abstraction layer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the AWS SES SDK. AWSSESProvider loads it via a lazy dynamic import; the
// mock intercepts that import so no real client / network is exercised.
const { mockSesSend, sesClientCtor } = vi.hoisted(() => ({
  mockSesSend: vi.fn(),
  sesClientCtor: vi.fn(),
}));

vi.mock("@aws-sdk/client-ses", () => {
  function SESClient(this: any, cfg: any) {
    sesClientCtor(cfg);
  }
  SESClient.prototype.send = mockSesSend;
  return {
    SESClient,
    SendEmailCommand: vi.fn(function (this: any, input: any) {
      this.input = input;
    }),
  };
});

import {
  AlibabaDirectMailProvider,
  AWSSESProvider,
  createEmailProvider,
  emailProviderConfigFromEnv,
  ResendEmailProvider,
  TencentSESProvider,
  validateEmailEnv,
  type EmailSendOptions,
} from "../../src/lib/email-provider.js";

describe("Email Providers", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn();
    mockSesSend.mockResolvedValue({ MessageId: "ses-msg-123" });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  describe("ResendEmailProvider", () => {
    it("should return correct provider name", () => {
      const provider = new ResendEmailProvider("api-key");
      expect(provider.getName()).toBe("resend");
    });

    it("should send email successfully", async () => {
      const provider = new ResendEmailProvider("api-key");
      const mockResponse = { id: "msg-123" };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const options: EmailSendOptions = {
        from: "sender@example.com",
        to: "recipient@example.com",
        subject: "Test Email",
        html: "<p>Test</p>",
      };

      const result = await provider.sendEmail(options);

      expect(result.provider).toBe("resend");
      expect(result.messageId).toBe("msg-123");
      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.resend.com/emails",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer api-key",
            "Content-Type": "application/json",
          }),
        }),
      );
    });

    it("should handle array of recipients", async () => {
      const provider = new ResendEmailProvider("api-key");
      const mockResponse = { id: "msg-123" };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const options: EmailSendOptions = {
        from: "sender@example.com",
        to: ["recipient1@example.com", "recipient2@example.com"],
        subject: "Test Email",
      };

      await provider.sendEmail(options);

      const fetchCall = (global.fetch as any).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.to).toEqual([
        "recipient1@example.com",
        "recipient2@example.com",
      ]);
    });

    it("should include optional fields", async () => {
      const provider = new ResendEmailProvider("api-key");
      const mockResponse = { id: "msg-123" };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const options: EmailSendOptions = {
        from: "sender@example.com",
        to: "recipient@example.com",
        subject: "Test",
        html: "<p>HTML</p>",
        text: "Text",
        replyTo: "reply@example.com",
        cc: "cc@example.com",
        bcc: ["bcc1@example.com", "bcc2@example.com"],
        tags: { category: "test" },
      };

      await provider.sendEmail(options);

      const fetchCall = (global.fetch as any).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.reply_to).toBe("reply@example.com");
      expect(body.cc).toEqual(["cc@example.com"]);
      expect(body.bcc).toEqual(["bcc1@example.com", "bcc2@example.com"]);
      expect(body.tags).toEqual({ category: "test" });
    });

    it("should throw error on API failure", async () => {
      const provider = new ResendEmailProvider("api-key");

      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => "Bad Request",
      });

      const options: EmailSendOptions = {
        from: "sender@example.com",
        to: "recipient@example.com",
        subject: "Test",
      };

      await expect(provider.sendEmail(options)).rejects.toThrow(
        "Resend API error: 400 Bad Request",
      );
    });

    it("should get usage stats successfully", async () => {
      const provider = new ResendEmailProvider("api-key");
      const mockUsage = { emails_sent: 1000 };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockUsage,
      });

      const stats = await provider.getUsageStats("month");

      expect(stats).not.toBeNull();
      expect(stats?.emailsSent).toBe(1000);
      expect(stats?.period).toBe("month");
      expect(stats?.periodStart).toBeDefined();
      expect(stats?.periodEnd).toBeDefined();
    });

    it("should return null when usage stats API fails", async () => {
      const provider = new ResendEmailProvider("api-key");

      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 500,
      });

      const stats = await provider.getUsageStats();

      expect(stats).toBeNull();
    });

    it("should handle different period types", async () => {
      const provider = new ResendEmailProvider("api-key");
      const mockUsage = { emails_sent: 100 };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockUsage,
      });

      const dayStats = await provider.getUsageStats("day");
      expect(dayStats?.period).toBe("day");

      const yearStats = await provider.getUsageStats("year");
      expect(yearStats?.period).toBe("year");
    });

    it("should handle usage stats errors gracefully (console.error, no logger)", async () => {
      const provider = new ResendEmailProvider("api-key");
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      (global.fetch as any).mockRejectedValue(new Error("Network error"));

      const stats = await provider.getUsageStats();

      expect(stats).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("should use custom base URL", async () => {
      const provider = new ResendEmailProvider(
        "api-key",
        "https://custom.resend.com",
      );
      const mockResponse = { id: "msg-123" };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const options: EmailSendOptions = {
        from: "sender@example.com",
        to: "recipient@example.com",
        subject: "Test",
      };

      await provider.sendEmail(options);

      expect(global.fetch).toHaveBeenCalledWith(
        "https://custom.resend.com/emails",
        expect.any(Object),
      );
    });
  });

  describe("AlibabaDirectMailProvider", () => {
    it("should return correct provider name", () => {
      const provider = new AlibabaDirectMailProvider(
        "key-id",
        "key-secret",
        "cn-hangzhou",
        "sender@example.com",
      );
      expect(provider.getName()).toBe("alibaba-directmail");
    });

    it("should throw not-implemented from sendEmail (no unsigned request)", async () => {
      const provider = new AlibabaDirectMailProvider(
        "key-id",
        "key-secret",
        "cn-hangzhou",
        "sender@example.com",
      );

      const options: EmailSendOptions = {
        from: "sender@example.com",
        to: "recipient@example.com",
        subject: "Test",
        html: "<p>Test</p>",
      };

      await expect(provider.sendEmail(options)).rejects.toThrow(
        "not implemented",
      );
      // Must NOT have issued any network request.
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return null for usage stats", async () => {
      const provider = new AlibabaDirectMailProvider(
        "key-id",
        "key-secret",
        "cn-hangzhou",
        "sender@example.com",
      );

      const stats = await provider.getUsageStats();

      expect(stats).toBeNull();
    });
  });

  describe("TencentSESProvider", () => {
    it("should return correct provider name", () => {
      const provider = new TencentSESProvider(
        "secret-id",
        "secret-key",
        "ap-beijing",
        "sender@example.com",
      );
      expect(provider.getName()).toBe("tencent-ses");
    });

    it("should throw not-implemented from sendEmail (no unsigned request)", async () => {
      const provider = new TencentSESProvider(
        "secret-id",
        "secret-key",
        "ap-beijing",
        "sender@example.com",
      );

      const options: EmailSendOptions = {
        from: "sender@example.com",
        to: "recipient@example.com",
        subject: "Test",
        html: "<p>Test</p>",
      };

      await expect(provider.sendEmail(options)).rejects.toThrow(
        "not implemented",
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return null for usage stats", async () => {
      const provider = new TencentSESProvider(
        "secret-id",
        "secret-key",
        "ap-beijing",
        "sender@example.com",
      );

      const stats = await provider.getUsageStats();

      expect(stats).toBeNull();
    });
  });

  describe("AWSSESProvider", () => {
    it("should return correct provider name", () => {
      const provider = new AWSSESProvider("us-east-1");
      expect(provider.getName()).toBe("aws-ses");
    });

    it("should send via the SDK and return the MessageId", async () => {
      const provider = new AWSSESProvider("us-east-1", {
        fromEmail: "noreply@example.com",
      });

      const options: EmailSendOptions = {
        from: "sender@example.com",
        to: "recipient@example.com",
        subject: "Test",
        html: "<p>Test</p>",
        text: "Test",
      };

      const result = await provider.sendEmail(options);

      expect(result.provider).toBe("aws-ses");
      expect(result.messageId).toBe("ses-msg-123");
      expect(mockSesSend).toHaveBeenCalledTimes(1);

      const command = mockSesSend.mock.calls[0][0];
      expect(command.input.Source).toBe("sender@example.com");
      expect(command.input.Destination.ToAddresses).toEqual([
        "recipient@example.com",
      ]);
      expect(command.input.Message.Subject.Data).toBe("Test");
      expect(command.input.Message.Body.Html.Data).toBe("<p>Test</p>");
      expect(command.input.Message.Body.Text.Data).toBe("Test");
    });

    it("should construct the SESClient with NO static credentials (default chain)", async () => {
      const provider = new AWSSESProvider("eu-central-1", {
        fromEmail: "noreply@example.com",
      });

      await provider.sendEmail({
        from: "sender@example.com",
        to: "recipient@example.com",
        subject: "Test",
      });

      expect(sesClientCtor).toHaveBeenCalledTimes(1);
      const cfg = sesClientCtor.mock.calls[0][0];
      expect(cfg).toEqual({ region: "eu-central-1" });
      expect(cfg).not.toHaveProperty("credentials");
    });

    it("should fall back to the provider's fromEmail when options.from is absent", async () => {
      const provider = new AWSSESProvider("us-east-1", {
        fromEmail: "noreply@example.com",
      });

      await provider.sendEmail({
        from: "",
        to: "recipient@example.com",
        subject: "Test",
      });

      const command = mockSesSend.mock.calls[0][0];
      expect(command.input.Source).toBe("noreply@example.com");
    });

    it("should throw when no from address is available", async () => {
      const provider = new AWSSESProvider("us-east-1");

      await expect(
        provider.sendEmail({
          from: "",
          to: "recipient@example.com",
          subject: "Test",
        }),
      ).rejects.toThrow("AWS SES requires a from address");
      expect(mockSesSend).not.toHaveBeenCalled();
    });

    it("should handle CC and BCC", async () => {
      const provider = new AWSSESProvider("us-east-1");

      const options: EmailSendOptions = {
        from: "sender@example.com",
        to: "recipient@example.com",
        subject: "Test",
        cc: ["cc1@example.com", "cc2@example.com"],
        bcc: "bcc@example.com",
      };

      await provider.sendEmail(options);

      const command = mockSesSend.mock.calls[0][0];
      expect(command.input.Destination.CcAddresses).toEqual([
        "cc1@example.com",
        "cc2@example.com",
      ]);
      expect(command.input.Destination.BccAddresses).toEqual([
        "bcc@example.com",
      ]);
    });

    it("should apply the configuration set when provided", async () => {
      const provider = new AWSSESProvider("us-east-1", {
        fromEmail: "noreply@example.com",
        configurationSet: "my-config-set",
      });

      await provider.sendEmail({
        from: "sender@example.com",
        to: "recipient@example.com",
        subject: "Test",
      });

      const command = mockSesSend.mock.calls[0][0];
      expect(command.input.ConfigurationSetName).toBe("my-config-set");
    });

    it("should omit the configuration set when not provided", async () => {
      const provider = new AWSSESProvider("us-east-1", {
        fromEmail: "noreply@example.com",
      });

      await provider.sendEmail({
        from: "sender@example.com",
        to: "recipient@example.com",
        subject: "Test",
      });

      const command = mockSesSend.mock.calls[0][0];
      expect(command.input.ConfigurationSetName).toBeUndefined();
    });

    it("should return 'unknown' when the SDK returns no MessageId", async () => {
      mockSesSend.mockResolvedValueOnce({});
      const provider = new AWSSESProvider("us-east-1");

      const result = await provider.sendEmail({
        from: "sender@example.com",
        to: "recipient@example.com",
        subject: "Test",
      });

      expect(result.messageId).toBe("unknown");
    });

    it("should propagate SDK send errors", async () => {
      mockSesSend.mockRejectedValueOnce(new Error("SES send failed"));
      const provider = new AWSSESProvider("us-east-1");

      await expect(
        provider.sendEmail({
          from: "sender@example.com",
          to: "recipient@example.com",
          subject: "Test",
        }),
      ).rejects.toThrow("SES send failed");
    });

    it("should return null for usage stats", async () => {
      const provider = new AWSSESProvider("us-east-1");

      const stats = await provider.getUsageStats();

      expect(stats).toBeNull();
    });
  });

  describe("createEmailProvider", () => {
    it("should create Resend provider", () => {
      const provider = createEmailProvider({
        provider: "resend",
        resendApiKey: "api-key",
      });

      expect(provider.getName()).toBe("resend");
    });

    it("should throw error when Resend API key missing", () => {
      expect(() => {
        createEmailProvider({
          provider: "resend",
        });
      }).toThrow("Resend requires resendApiKey");
    });

    it("should create Alibaba provider", () => {
      const provider = createEmailProvider({
        provider: "alibaba-directmail",
        alibabaAccessKeyId: "key-id",
        alibabaAccessKeySecret: "key-secret",
        alibabaAccountName: "sender@example.com",
      });

      expect(provider.getName()).toBe("alibaba-directmail");
    });

    it("should throw error when Alibaba credentials missing", () => {
      expect(() => {
        createEmailProvider({
          provider: "alibaba-directmail",
        });
      }).toThrow("Alibaba DirectMail requires");
    });

    it("should create Tencent provider", () => {
      const provider = createEmailProvider({
        provider: "tencent-ses",
        tencentSecretId: "secret-id",
        tencentSecretKey: "secret-key",
        tencentFromEmail: "sender@example.com",
      });

      expect(provider.getName()).toBe("tencent-ses");
    });

    it("should throw error when Tencent credentials missing", () => {
      expect(() => {
        createEmailProvider({
          provider: "tencent-ses",
        });
      }).toThrow("Tencent SES requires");
    });

    it("should create AWS SES provider WITHOUT requiring static credentials", () => {
      const provider = createEmailProvider({
        provider: "aws-ses",
        awsFromEmail: "sender@example.com",
      });

      expect(provider.getName()).toBe("aws-ses");
    });

    it("should create AWS SES provider even with no aws config at all (role-based)", () => {
      const provider = createEmailProvider({ provider: "aws-ses" });
      expect(provider.getName()).toBe("aws-ses");
    });

    it("should ignore @deprecated aws access keys and still build a role-based provider", () => {
      const provider = createEmailProvider({
        provider: "aws-ses",
        awsAccessKeyId: "ignored",
        awsSecretAccessKey: "ignored",
        awsRegion: "us-east-1",
      });
      expect(provider.getName()).toBe("aws-ses");
    });

    it("should default to Resend when provider not specified", () => {
      const provider = createEmailProvider({
        resendApiKey: "api-key",
      });

      expect(provider.getName()).toBe("resend");
    });

    it("should prefer Alibaba for China region", () => {
      const provider = createEmailProvider({
        provider: "resend",
        region: "CN",
        resendApiKey: "api-key",
        alibabaAccessKeyId: "key-id",
        alibabaAccessKeySecret: "key-secret",
        alibabaAccountName: "sender@example.com",
      });

      expect(provider.getName()).toBe("alibaba-directmail");
    });

    it("should prefer Tencent for China region when Alibaba not available", () => {
      const provider = createEmailProvider({
        provider: "resend",
        region: "CN",
        resendApiKey: "api-key",
        tencentSecretId: "secret-id",
        tencentSecretKey: "secret-key",
        tencentFromEmail: "sender@example.com",
      });

      expect(provider.getName()).toBe("tencent-ses");
    });

    it("should use AWS SES for China region when others not available", () => {
      const provider = createEmailProvider({
        provider: "resend",
        region: "CN",
        resendApiKey: "api-key",
        awsFromEmail: "sender@example.com",
        awsRegion: "cn-north-1",
      });

      expect(provider.getName()).toBe("aws-ses");
    });

    it("should throw error for unknown provider", () => {
      expect(() => {
        createEmailProvider({
          provider: "unknown" as any,
        });
      }).toThrow("Unknown email provider");
    });
  });

  describe("emailProviderConfigFromEnv", () => {
    it("should default to aws-ses and us-east-1 when nothing is set", () => {
      const config = emailProviderConfigFromEnv({});
      expect(config.provider).toBe("aws-ses");
      expect(config.awsRegion).toBe("us-east-1");
    });

    it("should honour region precedence: EMAIL_SERVICE_REGION wins", () => {
      const config = emailProviderConfigFromEnv({
        EMAIL_SERVICE_REGION: "eu-west-1",
        AWS_SES_REGION: "eu-central-1",
        SES_REGION: "ap-south-1",
        AWS_REGION: "us-west-2",
      });
      expect(config.awsRegion).toBe("eu-west-1");
    });

    it("should fall through the region precedence chain", () => {
      expect(
        emailProviderConfigFromEnv({ AWS_SES_REGION: "eu-central-1" })
          .awsRegion,
      ).toBe("eu-central-1");
      expect(
        emailProviderConfigFromEnv({ SES_REGION: "ap-south-1" }).awsRegion,
      ).toBe("ap-south-1");
      expect(
        emailProviderConfigFromEnv({ AWS_REGION: "us-west-2" }).awsRegion,
      ).toBe("us-west-2");
    });

    it("should map resend + SES fields", () => {
      const config = emailProviderConfigFromEnv({
        EMAIL_SERVICE: "resend",
        RESEND_API_KEY: "re_key",
        FROM_EMAIL: "noreply@example.com",
        SES_CONFIGURATION_SET: "cfg-set",
      });
      expect(config.provider).toBe("resend");
      expect(config.resendApiKey).toBe("re_key");
      expect(config.awsFromEmail).toBe("noreply@example.com");
      expect(config.sesConfigurationSet).toBe("cfg-set");
    });

    it("should build a working provider end-to-end from env", () => {
      const provider = createEmailProvider(
        emailProviderConfigFromEnv({
          EMAIL_SERVICE: "aws-ses",
          FROM_EMAIL: "noreply@example.com",
          AWS_SES_REGION: "eu-central-1",
        }),
      );
      expect(provider.getName()).toBe("aws-ses");
    });
  });

  describe("validateEmailEnv", () => {
    it("should require RESEND_API_KEY for resend", () => {
      const errors = validateEmailEnv({ EMAIL_SERVICE: "resend" });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("RESEND_API_KEY");
    });

    it("should pass for resend when RESEND_API_KEY present", () => {
      const errors = validateEmailEnv({
        EMAIL_SERVICE: "resend",
        RESEND_API_KEY: "re_key",
      });
      expect(errors).toEqual([]);
    });

    it("should require FROM_EMAIL for aws-ses", () => {
      const errors = validateEmailEnv({ EMAIL_SERVICE: "aws-ses" });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("FROM_EMAIL");
    });

    it("should pass for aws-ses when FROM_EMAIL present", () => {
      const errors = validateEmailEnv({
        EMAIL_SERVICE: "aws-ses",
        FROM_EMAIL: "noreply@example.com",
      });
      expect(errors).toEqual([]);
    });

    it("should not validate when no provider is selected", () => {
      expect(validateEmailEnv({})).toEqual([]);
    });
  });
});
