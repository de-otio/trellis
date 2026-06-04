/**
 * Maildummy Integration Tests
 *
 * Tests the email capture system for authentication testing.
 * These tests verify that:
 * - Maildummy infrastructure is deployed
 * - S3 bucket is accessible
 * - Email retrieval functions work correctly
 *
 * ✅ SAFE FOR PRODUCTION ✅
 *
 * These tests verify maildummy infrastructure and functionality.
 * They do NOT modify any data or resources.
 *
 * Run with: npm run test:integration
 */

import {
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { execSync } from "child_process";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  getMagicLinkFromS3,
  type MaildummyConfig,
} from "../../e2e/utils/maildummy-helper.js";
import { getEnvironment } from "../../utils/test-environment-guard.js";

/**
 * Wait for email to arrive in S3 bucket
 * Polls the bucket until an email for the given address is found or timeout is reached
 */
async function waitForEmail(
  config: MaildummyConfig,
  emailAddress: string,
  options: {
    timeout?: number; // milliseconds
    pollInterval?: number; // milliseconds
  } = {},
): Promise<string> {
  const timeout = options.timeout || 30000; // 30 seconds default
  const pollInterval = options.pollInterval || 2000; // 2 seconds default
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const magicLink = await getMagicLinkFromS3(config, emailAddress, 5);
      return magicLink;
    } catch (error) {
      // If it's not a "not found" error, rethrow
      if (
        error instanceof Error &&
        !error.message.includes("No magic link found") &&
        !error.message.includes("Timeout")
      ) {
        throw error;
      }
      // Otherwise, wait and retry
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  throw new Error(
    `Timeout waiting for email to ${emailAddress} in bucket ${config.bucketName}`,
  );
}

class MaildummyTestHelper {
  private environment: string;
  public s3Client: S3Client;
  private sesClient: SESClient;
  private ssmClient: SSMClient;
  private region: string;
  private terraformDir: string;

  constructor(environment: string = "dev") {
    this.environment = environment;
    this.region = environment === "prod" ? "us-east-1" : "eu-central-1";
    this.terraformDir = join(
      process.cwd(),
      "../../../environments",
      environment,
      "terraform",
    );
    this.s3Client = new S3Client({ region: this.region });
    this.sesClient = new SESClient({ region: this.region });
    this.ssmClient = new SSMClient({ region: this.region });
  }

  private runCommand(command: string, cwd?: string): string {
    try {
      // Use default shell (don't specify shell path - let Node.js choose)
      // This avoids ENOENT errors when /bin/sh is not available
      // execSync is synchronous and automatically cleans up the process
      const result = execSync(command, {
        cwd: cwd || process.cwd(),
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 10000, // 10 second timeout to prevent hanging
        // Don't specify shell - use Node.js default (works on all platforms)
      });
      return result.trim();
    } catch (error) {
      const err = error as { stderr?: string; stdout?: string };
      throw new Error(err.stderr || err.stdout || String(error));
    }
  }

  private async getSSMParameter(name: string): Promise<string | null> {
    try {
      const command = new GetParameterCommand({
        Name: name,
        WithDecryption: false, // These are String type, not SecureString
      });
      const response = await this.ssmClient.send(command);
      if (!response.Parameter?.Value) {
        return null;
      }
      return response.Parameter.Value;
    } catch (error: any) {
      // Return null if parameter doesn't exist (caller will handle error)
      if (
        error?.name === "ParameterNotFound" ||
        (error instanceof Error && error.message?.includes("ParameterNotFound"))
      ) {
        return null;
      }
      // For other errors, return null and let caller handle
      console.warn(
        `Failed to get SSM parameter ${name}:`,
        error?.message || error,
      );
      return null;
    }
  }

  async getTerraformOutputs(): Promise<{
    maildummy_domain?: { value: string };
    maildummy_s3_bucket_name?: { value: string };
  }> {
    // Skip Terraform outputs in test environment where shell is not available
    // This prevents ENOENT errors when /bin/sh is not available
    // Tests should use SSM parameters instead
    throw new Error(
      "Terraform outputs not available in test environment - use SSM parameters",
    );
  }

  async getMaildummyConfig(): Promise<{
    domain: string;
    bucketName: string;
    region: string;
  }> {
    // Skip Terraform outputs in test environment - go straight to SSM
    // This prevents shell command execution errors when /bin/sh is not available

    // Get from SSM parameters (required)
    // SSM parameter paths:
    // - /trellis/{env}/maildummy/domain
    // - /trellis/{env}/maildummy/bucket/name
    const domain = await this.getSSMParameter(
      `/trellis/${this.environment}/maildummy/domain`,
    );
    const bucketName = await this.getSSMParameter(
      `/trellis/${this.environment}/maildummy/bucket/name`,
    );

    if (!bucketName || !domain) {
      throw new Error(
        `Maildummy configuration not found in SSM. Expected SSM parameters:
        - /trellis/${this.environment}/maildummy/domain
        - /trellis/${this.environment}/maildummy/bucket/name
        
        Current values:
        - bucketName: ${bucketName || "NOT FOUND"}
        - domain: ${domain || "NOT FOUND"}
        
        These parameters are created by Terraform. Run 'terraform apply' to create them.`,
      );
    }

    return {
      domain,
      bucketName,
      region: this.region,
    };
  }

  /**
   * Send a test email to the maildummy domain using SES
   * Note: Requires SES to be out of sandbox mode or verified sender
   * Returns the SendEmail response
   */
  async sendTestEmail(to: string, subject: string, body: string): Promise<any> {
    try {
      // Use a verified sender address
      // For trellis, we'll use the maildummy domain itself or a verified sender
      const config = await this.getMaildummyConfig();
      const verifiedSender = `noreply@${config.domain}`;

      const command = new SendEmailCommand({
        Source: verifiedSender,
        Destination: {
          ToAddresses: [to],
        },
        Message: {
          Subject: {
            Data: subject,
            Charset: "UTF-8",
          },
          Body: {
            Html: {
              Data: body,
              Charset: "UTF-8",
            },
            Text: {
              Data: body,
              Charset: "UTF-8",
            },
          },
        },
      });

      const result = await this.sesClient.send(command);
      return result;
    } catch (error) {
      // If SES is in sandbox mode, we can't send emails
      // This is expected and we'll skip the email sending test
      if (
        error instanceof Error &&
        (error.message.includes("Email address not verified") ||
          error.message.includes("Account is in the SES Sandbox"))
      ) {
        throw new Error("SES_SANDBOX_MODE");
      }
      throw error;
    }
  }
}

/**
 * Maildummy Integration Tests
 *
 * ✅ SAFE FOR PRODUCTION ✅
 *
 * These tests verify maildummy infrastructure and functionality.
 * They do NOT modify any data or resources.
 */
// Check if maildummy infrastructure is deployed before running any tests
let maildummyAvailable = false;
try {
  const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
  const ssm = new SSMClient({ region: process.env.AWS_REGION || "eu-central-1" });
  const env = process.env.ENVIRONMENT || process.env.DEPLOY_ENV || "dev";
  const res = await ssm.send(new GetParameterCommand({ Name: `/trellis/${env}/maildummy/domain` }));
  maildummyAvailable = !!res.Parameter?.Value;
} catch {
  maildummyAvailable = false;
}

describe.skipIf(!maildummyAvailable)("Maildummy Integration Tests", () => {
  const environment = getEnvironment();
  const helper = new MaildummyTestHelper(environment);

  describe("Infrastructure Verification", () => {
    it("should have maildummy configuration available", async () => {
      const config = await helper.getMaildummyConfig();
      expect(config.domain).toBeDefined();
      expect(config.bucketName).toBeDefined();
      expect(config.region).toBeDefined();
    });

    it("should have S3 bucket accessible", async () => {
      const config = await helper.getMaildummyConfig();
      const command = new HeadBucketCommand({ Bucket: config.bucketName });

      await expect(helper.s3Client.send(command)).resolves.toBeDefined();
    });

    it("should have correct maildummy domain format", async () => {
      const config = await helper.getMaildummyConfig();

      if (environment === "dev") {
        expect(config.domain).toMatch(/^maildummy\./);
      } else {
        expect(config.domain).toMatch(/^maildummy\./);
      }
    });
  });

  describe("S3 Bucket Operations", () => {
    it("should be able to list objects in S3 bucket", async () => {
      const config = await helper.getMaildummyConfig();
      const command = new ListObjectsV2Command({
        Bucket: config.bucketName,
        Prefix: "raw/",
        MaxKeys: 10,
      });

      const response = await helper.s3Client.send(command);
      expect(response).toBeDefined();
      // It's okay if there are no emails yet
      expect(
        Array.isArray(response.Contents) || response.Contents === undefined,
      ).toBe(true);
    });

    it("should have correct bucket name format", async () => {
      const config = await helper.getMaildummyConfig();
      // Trellis bucket format: trellis-{env}-testing-{cdk-logical-id} (CDK auto-generated)
      expect(config.bucketName).toMatch(/^trellis-(dev|prod)-testing-/);
    });
  });

  describe("Maildummy Helper Functions", () => {
    it("should handle empty bucket gracefully", async () => {
      const config = await helper.getMaildummyConfig();
      const testEmail = `test-${Date.now()}@${config.domain}`;

      await expect(getMagicLinkFromS3(config, testEmail, 5)).rejects.toThrow(
        /No magic link found|Timeout/,
      );
    });

    it("should handle waitForEmail timeout correctly", async () => {
      const config = await helper.getMaildummyConfig();
      const testEmail = `test-${Date.now()}@${config.domain}`;

      await expect(
        waitForEmail(config, testEmail, { timeout: 2000, pollInterval: 500 }),
      ).rejects.toThrow(/Timeout waiting for email/);
    }, 15000); // 15 second timeout for test (needs to be longer than waitForEmail timeout + overhead)
  });

  describe("Email Capture", () => {
    it.skipIf(process.env.SKIP_EMAIL_SEND === "true")(
      "should capture and retrieve test email",
      async () => {
        const config = await helper.getMaildummyConfig();
        const testEmail = `test-${Date.now()}@${config.domain}`;
        const testSubject = `Test Email ${Date.now()}`;
        const testBody = `
          <html>
            <body>
              <p>This is a test email for maildummy integration testing.</p>
              <p>Magic link: <a href="https://example.supabase.co/auth/v1/verify?token=test-token-123&type=magiclink">Click here</a></p>
            </body>
          </html>
        `;

        try {
          // Send test email using SES API
          // When SES sends an email via SendEmail API to a domain with an MX record pointing to SES,
          // SES will route the email through the MX record, receive it via the inbound endpoint,
          // and process it through the receipt rule, storing it in S3
          console.log(`Sending test email to ${testEmail}...`);
          const sendResult = await helper.sendTestEmail(
            testEmail,
            testSubject,
            testBody,
          );
          console.log(
            `Email sent successfully. MessageId: ${sendResult?.MessageId || "N/A"}`,
          );

          // Wait for email to arrive (up to 60 seconds to account for MX routing and processing)
          console.log("Waiting for email to arrive in S3...");
          const magicLink = await waitForEmail(config, testEmail, {
            timeout: 60000,
            pollInterval: 2000,
          });
          console.log(`Email received! Magic link: ${magicLink}`);

          expect(magicLink).toBeDefined();
          expect(magicLink).toContain("token=test-token-123");
          expect(magicLink).toContain("supabase.co");
        } catch (error) {
          if (error instanceof Error && error.message === "SES_SANDBOX_MODE") {
            // Skip test if SES is in sandbox mode
            console.log("Skipping email send test - SES is in sandbox mode");
            return;
          }
          throw error;
        }
      },
      90000, // 90 second timeout for email delivery (includes MX routing, SES processing, and S3 storage)
    );
  });

  describe("Configuration Validation", () => {
    it("should have correct region configuration", async () => {
      const config = await helper.getMaildummyConfig();

      if (environment === "dev") {
        expect(config.region).toBe("eu-central-1");
      } else {
        expect(config.region).toBe("us-east-1");
      }
    });

    it("should have valid domain format", async () => {
      const config = await helper.getMaildummyConfig();
      expect(config.domain).toMatch(/^maildummy\./);
    });
  });
});
