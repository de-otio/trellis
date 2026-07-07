/**
 * Email Provider Abstraction Layer
 *
 * This abstraction allows swapping email service providers per region without code changes.
 * This is needed for the CN region, where Resend may not be available.
 *
 * Supported Providers:
 * - Resend (current, global)
 * - Alibaba Cloud DirectMail (China)
 * - Tencent Cloud SES (China)
 * - AWS SES (global, including China regions)
 * - SMTP (generic, for any SMTP-compatible service)
 */

// NOTE: this module is intentionally free of the structured (pino-backed)
// trellis logger. It is bundled into the Cognito `create-auth-challenge`
// Lambda via `createEmailProvider`, and pulling in the foundation logger would
// bloat that bundle. The one place that logs (Resend usage-stats) uses
// `console.error` instead. The AWS SES SDK is loaded through a lazy, cached
// dynamic import (see `loadSesSdk` below) so it can stay an esbuild external
// (provided by the Lambda runtime) and the client is reused across warm
// invocations.

export interface EmailSendOptions {
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  cc?: string | string[];
  bcc?: string | string[];
  tags?: Record<string, string>;
}

export interface EmailSendResult {
  messageId: string;
  provider: string;
}

export interface EmailUsageStats {
  emailsSent: number;
  period: "month" | "day" | "year";
  periodStart: string; // ISO date string
  periodEnd: string; // ISO date string
}

export interface EmailProvider {
  /**
   * Send an email
   */
  sendEmail(options: EmailSendOptions): Promise<EmailSendResult>;

  /**
   * Get usage statistics (for cost calculation)
   * Returns null if provider doesn't support usage stats
   */
  getUsageStats?(
    period?: "month" | "day" | "year",
  ): Promise<EmailUsageStats | null>;

  /**
   * Get provider name for identification
   */
  getName(): string;
}

/**
 * Resend Email Provider (Current Implementation)
 *
 * Used globally except in China where it may not be available.
 */
export class ResendEmailProvider implements EmailProvider {
  private apiKey: string;
  private baseUrl: string;

  constructor(
    apiKey: string,
    baseUrl: string = "https://api.resend.com",
    // Retained for call-site compatibility; unused (this module avoids the
    // structured logger to keep the Lambda bundle lean).
    _env?: unknown,
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  getName(): string {
    return "resend";
  }

  async sendEmail(options: EmailSendOptions): Promise<EmailSendResult> {
    const response = await fetch(`${this.baseUrl}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: options.from,
        to: Array.isArray(options.to) ? options.to : [options.to],
        subject: options.subject,
        html: options.html,
        text: options.text,
        reply_to: options.replyTo,
        cc: options.cc
          ? Array.isArray(options.cc)
            ? options.cc
            : [options.cc]
          : undefined,
        bcc: options.bcc
          ? Array.isArray(options.bcc)
            ? options.bcc
            : [options.bcc]
          : undefined,
        tags: options.tags,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Resend API error: ${response.status} ${error}`);
    }

    const data = (await response.json()) as { id: string };
    return {
      messageId: data.id,
      provider: "resend",
    };
  }

  async getUsageStats(
    period: "month" | "day" | "year" = "month",
  ): Promise<EmailUsageStats | null> {
    try {
      const response = await fetch(`${this.baseUrl}/usage`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        return null;
      }

      const usage = (await response.json()) as { emails_sent?: number };
      const emailsSent = usage.emails_sent || 0;

      // Calculate period dates
      const now = new Date();
      let periodStart: Date;
      let periodEnd: Date = now;

      if (period === "month") {
        periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
      } else if (period === "day") {
        periodStart = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
        );
      } else {
        periodStart = new Date(now.getFullYear(), 0, 1);
      }

      return {
        emailsSent,
        period,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
      };
    } catch (error) {
      console.error("[ResendEmailProvider] Error fetching usage stats:", error);
      return null;
    }
  }
}

/**
 * Alibaba Cloud DirectMail Provider (China)
 *
 * Alibaba Cloud DirectMail is a China-compliant email service.
 * Documentation: https://www.alibabacloud.com/help/en/directmail
 */
export class AlibabaDirectMailProvider implements EmailProvider {
  private accessKeyId: string;
  private accessKeySecret: string;
  private region: string; // e.g., 'cn-hangzhou'
  private accountName: string; // Verified sender email address

  constructor(
    accessKeyId: string,
    accessKeySecret: string,
    region: string = "cn-hangzhou",
    accountName: string,
  ) {
    this.accessKeyId = accessKeyId;
    this.accessKeySecret = accessKeySecret;
    this.region = region;
    this.accountName = accountName;
  }

  getName(): string {
    return "alibaba-directmail";
  }

  async sendEmail(_options: EmailSendOptions): Promise<EmailSendResult> {
    // NOT IMPLEMENTED. The earlier version issued an UNSIGNED request to the
    // Alibaba DirectMail REST API (no HMAC-SHA1 signature), which the service
    // rejects — it never actually delivered mail. Rather than silently issue a
    // broken request, fail loudly. A real implementation must sign requests via
    // the Alibaba Cloud SDK / proper signature algorithm before this is enabled.
    void this.accessKeyId;
    void this.accessKeySecret;
    void this.region;
    void this.accountName;
    throw new Error(
      "AlibabaDirectMailProvider.sendEmail is not implemented (requires a signed Alibaba Cloud SDK integration)",
    );
  }

  async getUsageStats(): Promise<EmailUsageStats | null> {
    // Alibaba Cloud DirectMail usage stats would require additional API calls
    // This is a placeholder - implement based on Alibaba Cloud API documentation
    return null;
  }
}

/**
 * Tencent Cloud SES Provider (China)
 *
 * Tencent Cloud Simple Email Service is a China-compliant email service.
 * Documentation: https://cloud.tencent.com/document/product/1288
 */
export class TencentSESProvider implements EmailProvider {
  private secretId: string;
  private secretKey: string;
  private region: string; // e.g., 'ap-beijing'
  private fromEmail: string; // Verified sender email address

  constructor(
    secretId: string,
    secretKey: string,
    region: string = "ap-beijing",
    fromEmail: string,
  ) {
    this.secretId = secretId;
    this.secretKey = secretKey;
    this.region = region;
    this.fromEmail = fromEmail;
  }

  getName(): string {
    return "tencent-ses";
  }

  async sendEmail(_options: EmailSendOptions): Promise<EmailSendResult> {
    // NOT IMPLEMENTED. The earlier version issued an UNSIGNED request to the
    // Tencent Cloud SES v3 API (no TC3-HMAC-SHA256 signature), which the service
    // rejects — it never actually delivered mail. Fail loudly rather than issue
    // a broken request. A real implementation must sign requests via the Tencent
    // Cloud SDK / TC3-HMAC-SHA256 before this is enabled.
    void this.secretId;
    void this.secretKey;
    void this.region;
    void this.fromEmail;
    throw new Error(
      "TencentSESProvider.sendEmail is not implemented (requires a signed Tencent Cloud SDK integration)",
    );
  }

  async getUsageStats(): Promise<EmailUsageStats | null> {
    // Tencent Cloud SES usage stats would require additional API calls
    // This is a placeholder - implement based on Tencent Cloud API documentation
    return null;
  }
}

/**
 * Lazily import `@aws-sdk/client-ses` once and cache the module promise.
 *
 * Deferring the import (a) lets the Cognito Lambda keep `@aws-sdk/*` marked
 * external in esbuild (the SES SDK is provided by the Lambda runtime, not
 * bundled), and (b) means non-SES code paths never pay to load it. The cached
 * promise is reused across warm Lambda invocations.
 */
let sesSdkPromise:
  | Promise<typeof import("@aws-sdk/client-ses")>
  | undefined;
function loadSesSdk(): Promise<typeof import("@aws-sdk/client-ses")> {
  if (!sesSdkPromise) {
    sesSdkPromise = import("@aws-sdk/client-ses");
  }
  return sesSdkPromise;
}

/**
 * AWS SES Provider (Global, including China regions)
 *
 * Sends via the AWS SDK (`@aws-sdk/client-ses`), signed with SigV4 by the SDK.
 * Uses the **default credential provider chain** — no static keys are passed,
 * so it picks up the ECS task role / Lambda execution role automatically.
 *
 * AWS SES works globally and has China regions (Beijing, Ningxia).
 * Documentation: https://docs.aws.amazon.com/ses/
 */
export class AWSSESProvider implements EmailProvider {
  private region: string; // e.g. 'us-east-1', 'cn-north-1', 'cn-northwest-1'
  private fromEmail?: string;
  private configurationSet?: string;
  /** Cached SESClient promise — reused across warm invocations. */
  private clientPromise?: Promise<
    InstanceType<typeof import("@aws-sdk/client-ses").SESClient>
  >;

  constructor(
    region: string = "us-east-1",
    opts?: { fromEmail?: string; configurationSet?: string },
  ) {
    this.region = region;
    this.fromEmail = opts?.fromEmail;
    this.configurationSet = opts?.configurationSet;
  }

  getName(): string {
    return "aws-ses";
  }

  private async getClient() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const { SESClient } = await loadSesSdk();
        // NO `credentials` option → default credential provider chain
        // (ECS task role / Lambda execution role / env / SSO).
        return new SESClient({ region: this.region });
      })();
    }
    return this.clientPromise;
  }

  async sendEmail(options: EmailSendOptions): Promise<EmailSendResult> {
    const source = options.from || this.fromEmail;
    if (!source) {
      throw new Error(
        "AWS SES requires a from address (options.from or the provider's fromEmail)",
      );
    }

    const { SendEmailCommand } = await loadSesSdk();
    const client = await this.getClient();

    const toAddresses = Array.isArray(options.to) ? options.to : [options.to];
    const ccAddresses = options.cc
      ? Array.isArray(options.cc)
        ? options.cc
        : [options.cc]
      : undefined;
    const bccAddresses = options.bcc
      ? Array.isArray(options.bcc)
        ? options.bcc
        : [options.bcc]
      : undefined;

    const command = new SendEmailCommand({
      Source: source,
      Destination: {
        ToAddresses: toAddresses,
        CcAddresses: ccAddresses,
        BccAddresses: bccAddresses,
      },
      Message: {
        Subject: { Data: options.subject, Charset: "UTF-8" },
        Body: {
          Html: options.html
            ? { Data: options.html, Charset: "UTF-8" }
            : undefined,
          Text: options.text
            ? { Data: options.text, Charset: "UTF-8" }
            : undefined,
        },
      },
      ReplyToAddresses: options.replyTo ? [options.replyTo] : undefined,
      ...(this.configurationSet
        ? { ConfigurationSetName: this.configurationSet }
        : {}),
    });

    const response = await client.send(command);
    return {
      messageId: response.MessageId || "unknown",
      provider: "aws-ses",
    };
  }

  async getUsageStats(): Promise<EmailUsageStats | null> {
    // AWS SES usage stats would require CloudWatch API calls
    // This is a placeholder - implement based on AWS CloudWatch API
    return null;
  }
}

/**
 * Factory function to create email provider based on region and configuration
 */
export interface EmailProviderConfig {
  provider: "resend" | "alibaba-directmail" | "tencent-ses" | "aws-ses";
  region?: string; // For region-specific provider selection
  // Resend config
  resendApiKey?: string;
  resendBaseUrl?: string;
  // Alibaba DirectMail config
  alibabaAccessKeyId?: string;
  alibabaAccessKeySecret?: string;
  alibabaRegion?: string;
  alibabaAccountName?: string;
  // Tencent SES config
  tencentSecretId?: string;
  tencentSecretKey?: string;
  tencentRegion?: string;
  tencentFromEmail?: string;
  // AWS SES config
  /**
   * @deprecated Ignored for authentication. The SES provider now uses the
   * default AWS credential provider chain (ECS task / Lambda execution role).
   * Retained only so existing call sites that still pass it keep compiling.
   */
  awsAccessKeyId?: string;
  /**
   * @deprecated Ignored for authentication. See `awsAccessKeyId`.
   */
  awsSecretAccessKey?: string;
  awsRegion?: string;
  /** Default From address for the SES provider (used when a send omits `from`). */
  awsFromEmail?: string;
  /** SES configuration set name applied to every send (event publishing/tracking). */
  sesConfigurationSet?: string;
}

/**
 * Structural source for {@link emailProviderConfigFromEnv} /
 * {@link validateEmailEnv}. Both the application `Env` object and the raw
 * `process.env` satisfy this shape, so a single helper serves the API and the
 * Cognito Lambda. All fields are optional strings.
 */
export interface EmailEnvSource {
  EMAIL_SERVICE?: string;
  EMAIL_SERVICE_REGION?: string;
  AWS_SES_REGION?: string;
  SES_REGION?: string;
  AWS_REGION?: string;
  FROM_EMAIL?: string;
  SES_CONFIGURATION_SET?: string;
  RESEND_API_KEY?: string;
  RESEND_BASE_URL?: string;
  ALIBABA_ACCESS_KEY_ID?: string;
  ALIBABA_ACCESS_KEY_SECRET?: string;
  ALIBABA_REGION?: string;
  ALIBABA_ACCOUNT_NAME?: string;
  TENCENT_SECRET_ID?: string;
  TENCENT_SECRET_KEY?: string;
  TENCENT_REGION?: string;
  TENCENT_FROM_EMAIL?: string;
}

/**
 * Build an {@link EmailProviderConfig} from an env-shaped source.
 *
 * Region precedence for the AWS SES provider:
 *   EMAIL_SERVICE_REGION → AWS_SES_REGION → SES_REGION → AWS_REGION → us-east-1.
 *
 * Shared by the API (passes `Env`) and the Cognito magic-link Lambda (passes
 * `process.env`) so provider selection is defined in exactly one place.
 */
export function emailProviderConfigFromEnv(
  src: EmailEnvSource,
): EmailProviderConfig {
  const provider =
    (src.EMAIL_SERVICE as EmailProviderConfig["provider"]) || "aws-ses";
  const awsRegion =
    src.EMAIL_SERVICE_REGION ||
    src.AWS_SES_REGION ||
    src.SES_REGION ||
    src.AWS_REGION ||
    "us-east-1";
  return {
    provider,
    // Resend
    resendApiKey: src.RESEND_API_KEY,
    resendBaseUrl: src.RESEND_BASE_URL,
    // AWS SES (role-based; no static credentials)
    awsRegion,
    awsFromEmail: src.FROM_EMAIL,
    sesConfigurationSet: src.SES_CONFIGURATION_SET,
    // Alibaba DirectMail
    alibabaAccessKeyId: src.ALIBABA_ACCESS_KEY_ID,
    alibabaAccessKeySecret: src.ALIBABA_ACCESS_KEY_SECRET,
    alibabaRegion: src.ALIBABA_REGION,
    alibabaAccountName: src.ALIBABA_ACCOUNT_NAME,
    // Tencent SES
    tencentSecretId: src.TENCENT_SECRET_ID,
    tencentSecretKey: src.TENCENT_SECRET_KEY,
    tencentRegion: src.TENCENT_REGION,
    tencentFromEmail: src.TENCENT_FROM_EMAIL,
  };
}

/**
 * Validate email-related env for the EXPLICITLY selected provider. Returns a
 * list of human-readable errors (empty = valid). Only the fields the selected
 * provider actually needs are checked:
 *   - `resend`  → RESEND_API_KEY
 *   - `aws-ses` → FROM_EMAIL
 *
 * Callers gate this on `EMAIL_SERVICE` being set, so a deployment that never
 * selects a provider is never penalised.
 */
export function validateEmailEnv(src: EmailEnvSource): string[] {
  const errors: string[] = [];
  const provider = src.EMAIL_SERVICE;
  if (provider === "resend") {
    if (!src.RESEND_API_KEY) {
      errors.push("RESEND_API_KEY is required when EMAIL_SERVICE=resend");
    }
  } else if (provider === "aws-ses") {
    if (!src.FROM_EMAIL) {
      errors.push("FROM_EMAIL is required when EMAIL_SERVICE=aws-ses");
    }
  }
  return errors;
}

export function createEmailProvider(
  config: EmailProviderConfig,
): EmailProvider {
  // If region is China, prefer China-compatible providers
  if (config.region === "CN" || config.region === "cn") {
    // Priority: Alibaba DirectMail > Tencent SES > AWS SES (China regions)
    if (
      config.provider === "alibaba-directmail" ||
      (config.provider === "resend" && config.alibabaAccessKeyId)
    ) {
      if (
        !config.alibabaAccessKeyId ||
        !config.alibabaAccessKeySecret ||
        !config.alibabaAccountName
      ) {
        throw new Error(
          "Alibaba DirectMail requires accessKeyId, accessKeySecret, and accountName",
        );
      }
      return new AlibabaDirectMailProvider(
        config.alibabaAccessKeyId,
        config.alibabaAccessKeySecret,
        config.alibabaRegion || "cn-hangzhou",
        config.alibabaAccountName,
      );
    }

    if (
      config.provider === "tencent-ses" ||
      (config.provider === "resend" && config.tencentSecretId)
    ) {
      if (
        !config.tencentSecretId ||
        !config.tencentSecretKey ||
        !config.tencentFromEmail
      ) {
        throw new Error(
          "Tencent SES requires secretId, secretKey, and fromEmail",
        );
      }
      return new TencentSESProvider(
        config.tencentSecretId,
        config.tencentSecretKey,
        config.tencentRegion || "ap-beijing",
        config.tencentFromEmail,
      );
    }

    if (
      config.provider === "aws-ses" ||
      (config.provider === "resend" &&
        (config.awsAccessKeyId || config.awsFromEmail))
    ) {
      // Role-based auth (default credential chain); China region by default.
      return new AWSSESProvider(config.awsRegion || "cn-north-1", {
        fromEmail: config.awsFromEmail,
        configurationSet: config.sesConfigurationSet,
      });
    }
  }

  // Default to Resend for non-China regions or explicit Resend selection
  if (config.provider === "resend" || !config.provider) {
    if (!config.resendApiKey) {
      throw new Error("Resend requires resendApiKey");
    }
    return new ResendEmailProvider(config.resendApiKey, config.resendBaseUrl);
  }

  // Explicit provider selection
  switch (config.provider) {
    case "alibaba-directmail":
      if (
        !config.alibabaAccessKeyId ||
        !config.alibabaAccessKeySecret ||
        !config.alibabaAccountName
      ) {
        throw new Error(
          "Alibaba DirectMail requires accessKeyId, accessKeySecret, and accountName",
        );
      }
      return new AlibabaDirectMailProvider(
        config.alibabaAccessKeyId,
        config.alibabaAccessKeySecret,
        config.alibabaRegion || "cn-hangzhou",
        config.alibabaAccountName,
      );

    case "tencent-ses":
      if (
        !config.tencentSecretId ||
        !config.tencentSecretKey ||
        !config.tencentFromEmail
      ) {
        throw new Error(
          "Tencent SES requires secretId, secretKey, and fromEmail",
        );
      }
      return new TencentSESProvider(
        config.tencentSecretId,
        config.tencentSecretKey,
        config.tencentRegion || "ap-beijing",
        config.tencentFromEmail,
      );

    case "aws-ses":
      // Role-based auth: the default AWS credential provider chain supplies
      // credentials (ECS task role / Lambda execution role). Any
      // awsAccessKeyId/awsSecretAccessKey on the config are @deprecated and
      // ignored — no static keys are threaded into the client.
      return new AWSSESProvider(config.awsRegion || "us-east-1", {
        fromEmail: config.awsFromEmail,
        configurationSet: config.sesConfigurationSet,
      });

    default:
      throw new Error(`Unknown email provider: ${config.provider}`);
  }
}
