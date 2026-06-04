/**
 * Helper utilities for retrieving magic links from SES maildummy S3 bucket
 *
 * This module provides utilities for E2E tests to retrieve magic links
 * from emails captured by the SES maildummy infrastructure.
 */

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { simpleParser } from "mailparser";

export interface MaildummyConfig {
  bucketName: string;
  region?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
}

/**
 * Retrieve magic link from S3 bucket for a given email address
 *
 * @param config - Maildummy configuration
 * @param emailAddress - Email address to find magic link for
 * @param maxWaitSeconds - Maximum time to wait for email (default: 30)
 * @returns Promise resolving to the magic link URL
 */
export async function getMagicLinkFromS3(
  config: MaildummyConfig,
  emailAddress: string,
  maxWaitSeconds: number = 30,
): Promise<string> {
  const s3Client = new S3Client({
    region: config.region || "eu-central-1",
    credentials:
      config.awsAccessKeyId && config.awsSecretAccessKey
        ? {
            accessKeyId: config.awsAccessKeyId,
            secretAccessKey: config.awsSecretAccessKey,
          }
        : undefined,
  });

  const startTime = Date.now();
  const maxWaitMs = maxWaitSeconds * 1000;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      // List objects in the bucket (emails are stored under raw/ prefix)
      const listCommand = new ListObjectsV2Command({
        Bucket: config.bucketName,
        Prefix: "raw/",
      });

      const listResponse = await s3Client.send(listCommand);

      if (!listResponse.Contents || listResponse.Contents.length === 0) {
        // Wait a bit and retry
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }

      // Sort by last modified (most recent first)
      const objects = [...listResponse.Contents].sort(
        (a, b) =>
          (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0),
      );

      // Find the most recent email for the given address
      for (const object of objects) {
        if (!object.Key) continue;

        // Get the email object
        const getCommand = new GetObjectCommand({
          Bucket: config.bucketName,
          Key: object.Key,
        });

        const emailObject = await s3Client.send(getCommand);

        if (!emailObject.Body) continue;

        // Convert stream to buffer
        const chunks: Uint8Array[] = [];
        for await (const chunk of emailObject.Body as any) {
          chunks.push(chunk);
        }
        const emailBuffer = Buffer.concat(chunks);

        // Parse the email
        const parsed = await simpleParser(emailBuffer);

        // Check if this email is for the target address.
        // mailparser returns AddressObject with a `value` array; flatten both forms.
        const addressObjects = [parsed.to, parsed.cc].filter(Boolean);
        const flatAddresses = addressObjects.flatMap((addr: any) => {
          if (!addr) return [];
          if (Array.isArray(addr)) return addr;
          if (Array.isArray(addr.value)) return addr.value;
          return [addr];
        });
        const toAddresses = flatAddresses.map((addr: any) =>
          (addr.address || "").toLowerCase(),
        );

        if (!toAddresses.includes(emailAddress.toLowerCase())) {
          continue;
        }

        // Extract magic link from email body
        const body = parsed.html || parsed.text || "";
        const magicLink = extractMagicLink(body);

        if (magicLink) {
          return magicLink;
        }
      }

      // Wait a bit before retrying
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (error) {
      // Log error but continue retrying
      console.warn("Error retrieving magic link:", error);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  throw new Error(
    `Timeout: No magic link found for email ${emailAddress} in bucket ${config.bucketName} after ${maxWaitSeconds} seconds`,
  );
}

/**
 * Extract magic link URL from email body
 *
 * @param body - Email body (HTML or text)
 * @returns Magic link URL or null if not found
 */
function extractMagicLink(body: string): string | null {
  // Try to find Trellis magic link URL
  // Format: https://{env}.example.com/auth/verify?token=...&email=...
  const trellisPattern =
    /https:\/\/[^\s"<>]*example\.com\/auth\/verify\?[^\s"<>]+/gi;
  const trellisMatches = body.match(trellisPattern);

  if (trellisMatches && trellisMatches.length > 0) {
    return trellisMatches[0];
  }

  // Try to find Supabase magic link URL (legacy)
  // Format: https://{project}.supabase.co/auth/v1/verify?token=...&type=...
  const supabasePattern =
    /https:\/\/[^\/]+\.supabase\.co\/auth\/v1\/verify\?[^\s"<>]+/gi;
  const supabaseMatches = body.match(supabasePattern);

  if (supabaseMatches && supabaseMatches.length > 0) {
    return supabaseMatches[0];
  }

  // Try to find any URL with token parameter
  const tokenPattern = /https?:\/\/[^\s"<>]*[?&]token=[^\s"<>]+/gi;
  const tokenMatches = body.match(tokenPattern);

  if (tokenMatches && tokenMatches.length > 0) {
    return tokenMatches[0];
  }

  return null;
}

/**
 * Extract token and type from magic link URL
 *
 * @param magicLink - Magic link URL
 * @returns Object with token and type, or null if parsing fails
 */
export function parseMagicLink(magicLink: string): {
  token: string;
  email?: string;
  type?: string;
} | null {
  try {
    const url = new URL(magicLink);
    const token = url.searchParams.get("token");

    if (!token) {
      return null;
    }

    return {
      token,
      email: url.searchParams.get("email") || undefined,
      type: url.searchParams.get("type") || undefined,
    };
  } catch (error) {
    return null;
  }
}
