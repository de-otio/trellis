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

import { getLogger, Logger, type LoggerEnv } from "./logger.js";

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
  private logger: Logger;

  constructor(
    apiKey: string,
    baseUrl: string = "https://api.resend.com",
    env?: LoggerEnv | any,
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.logger = getLogger();
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
      this.logger.error(
        "[ResendEmailProvider] Error fetching usage stats:",
        error,
      );
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

  async sendEmail(options: EmailSendOptions): Promise<EmailSendResult> {
    // Alibaba Cloud DirectMail uses Alibaba Cloud SDK
    // This is a simplified implementation - in production, use @alicloud/dysmsapi-sdk
    // For now, we'll use their REST API

    const endpoint = `https://dm.${this.region}.aliyuncs.com`;
    const action = "SingleSendMail";

    // Build request parameters
    const params = new URLSearchParams({
      Action: action,
      Version: "2015-11-23",
      AccessKeyId: this.accessKeyId,
      Format: "JSON",
      SignatureMethod: "HMAC-SHA1",
      Timestamp: new Date().toISOString().replace(/[:\-]|\.\d{3}/g, ""),
      SignatureVersion: "1.0",
      AccountName: this.accountName,
      FromAlias: options.from.split("@")[0],
      ToAddress: Array.isArray(options.to) ? options.to.join(",") : options.to,
      Subject: options.subject,
      HtmlBody: options.html || options.text || "",
      TextBody: options.text || "",
      ReplyToAddress: options.replyTo || "false",
    });

    // Note: In production, you'd need to properly sign the request using HMAC-SHA1
    // This is a placeholder - implement proper Alibaba Cloud signature algorithm
    const response = await fetch(`${endpoint}?${params.toString()}`, {
      method: "POST",
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Alibaba DirectMail API error: ${response.status} ${error}`,
      );
    }

    const data = (await response.json()) as {
      EnvId?: string;
      RequestId?: string;
    };
    return {
      messageId: data.EnvId || data.RequestId || "unknown",
      provider: "alibaba-directmail",
    };
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

  async sendEmail(options: EmailSendOptions): Promise<EmailSendResult> {
    // Tencent Cloud SES uses Tencent Cloud SDK
    // This is a simplified implementation - in production, use tencentcloud-sdk-nodejs
    // For now, we'll use their API v3

    const endpoint = `https://ses.tencentcloudapi.com`;

    // Note: In production, you'd need to properly sign the request using TC3-HMAC-SHA256
    // This is a placeholder - implement proper Tencent Cloud signature algorithm
    const payload = {
      FromEmailAddress: this.fromEmail,
      Destination: Array.isArray(options.to) ? options.to : [options.to],
      Subject: options.subject,
      Template: {
        TemplateID: 0, // Use template ID if using templates
        TemplateData: JSON.stringify({
          html: options.html || options.text || "",
          text: options.text || "",
        }),
      },
      Simple: {
        Html: options.html || options.text || "",
        Text: options.text || "",
      },
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-TC-Action": "SendEmail",
        "X-TC-Version": "2020-10-14",
        "X-TC-Region": this.region,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Tencent SES API error: ${response.status} ${error}`);
    }

    const data = (await response.json()) as {
      Response?: { MessageId?: string };
    };
    return {
      messageId: data.Response?.MessageId || "unknown",
      provider: "tencent-ses",
    };
  }

  async getUsageStats(): Promise<EmailUsageStats | null> {
    // Tencent Cloud SES usage stats would require additional API calls
    // This is a placeholder - implement based on Tencent Cloud API documentation
    return null;
  }
}

/**
 * AWS SES Provider (Global, including China regions)
 *
 * AWS SES works globally and has China regions (Beijing, Ningxia).
 * Documentation: https://docs.aws.amazon.com/ses/
 */
export class AWSSESProvider implements EmailProvider {
  private accessKeyId: string;
  private secretAccessKey: string;
  private region: string; // e.g., 'us-east-1', 'cn-north-1', 'cn-northwest-1'

  constructor(
    accessKeyId: string,
    secretAccessKey: string,
    region: string = "us-east-1",
  ) {
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.region = region;
  }

  getName(): string {
    return "aws-ses";
  }

  async sendEmail(options: EmailSendOptions): Promise<EmailSendResult> {
    // AWS SES uses AWS Signature Version 4
    // This is a simplified implementation - in production, use AWS SDK
    // For now, we'll use their REST API

    const endpoint = `https://email.${this.region}.amazonaws.com`;

    // Note: In production, you'd need to properly sign the request using AWS Signature V4
    // This is a placeholder - implement proper AWS signature algorithm
    const payload = {
      Source: options.from,
      Destination: {
        ToAddresses: Array.isArray(options.to) ? options.to : [options.to],
        CcAddresses: options.cc
          ? Array.isArray(options.cc)
            ? options.cc
            : [options.cc]
          : undefined,
        BccAddresses: options.bcc
          ? Array.isArray(options.bcc)
            ? options.bcc
            : [options.bcc]
          : undefined,
      },
      Message: {
        Subject: {
          Data: options.subject,
          Charset: "UTF-8",
        },
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
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSSimpleEmailService.SendEmail",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`AWS SES API error: ${response.status} ${error}`);
    }

    const data = (await response.json()) as {
      SendEmailResult?: { MessageId?: string };
    };
    return {
      messageId: data.SendEmailResult?.MessageId || "unknown",
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
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsRegion?: string;
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
      (config.provider === "resend" && config.awsAccessKeyId)
    ) {
      if (!config.awsAccessKeyId || !config.awsSecretAccessKey) {
        throw new Error("AWS SES requires accessKeyId and secretAccessKey");
      }
      // Use China region for AWS SES
      return new AWSSESProvider(
        config.awsAccessKeyId,
        config.awsSecretAccessKey,
        config.awsRegion || "cn-north-1",
      );
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
      if (!config.awsAccessKeyId || !config.awsSecretAccessKey) {
        throw new Error("AWS SES requires accessKeyId and secretAccessKey");
      }
      return new AWSSESProvider(
        config.awsAccessKeyId,
        config.awsSecretAccessKey,
        config.awsRegion || "us-east-1",
      );

    default:
      throw new Error(`Unknown email provider: ${config.provider}`);
  }
}
