/**
 * Fedify HTTP Signatures Integration
 *
 * Uses Fedify's actor dispatcher for key management and implements HTTP signature
 * signing and verification directly using crypto, without relying on old services.
 */

import * as crypto from "crypto";
import type { Env } from "../../../env.js";
import { getLogger, Logger } from "../../logger.js";
import { UserActorDispatcher } from "../dispatchers/user-actor.js";

/**
 * Verify HTTP signature using Fedify actor dispatcher
 *
 * Uses the UserActorDispatcher to get key pairs and verifies signatures directly.
 *
 * @param request - Incoming request
 * @param env - Cloudflare Workers environment
 * @returns True if signature is valid, false otherwise
 */
export async function verifyHttpSignature(
  request: Request,
  env: Env,
): Promise<boolean> {
  const logger = getLogger();

  try {
    // Check if Signature header exists
    const signatureHeader = request.headers.get("Signature");
    if (!signatureHeader) {
      logger.warn("[Fedify HTTP Signatures] Missing Signature header");
      return false;
    }

    // Parse signature parameters
    const signatureParams: Record<string, string> = {};
    signatureHeader.split(",").forEach((param) => {
      const trimmed = param.trim();
      const equalIndex = trimmed.indexOf("=");
      if (equalIndex === -1) return;
      const key = trimmed.substring(0, equalIndex).trim();
      const value = trimmed
        .substring(equalIndex + 1)
        .trim()
        .replace(/^"|"$/g, "");
      signatureParams[key] = value;
    });

    const keyId = signatureParams.keyId;
    const algorithm = signatureParams.algorithm;
    const headers = signatureParams.headers;
    const signature = signatureParams.signature;

    if (!keyId || !algorithm || !headers || !signature) {
      logger.warn(
        "[Fedify HTTP Signatures] Missing required signature parameters",
      );
      return false;
    }

    // Validate algorithm
    if (algorithm !== "rsa-sha256") {
      logger.warn("[Fedify HTTP Signatures] Unsupported algorithm", {
        algorithm,
      });
      return false;
    }

    // Extract actor URI from keyId
    // Format: https://example.com/users/{username}#main-key
    const keyIdUrl = new URL(keyId);
    const actorUri = keyIdUrl.origin + keyIdUrl.pathname.replace(/#.*$/, "");

    // Get actor dispatcher
    const dispatcher = new UserActorDispatcher(env);

    // Get key pair for actor
    const keyPair = await dispatcher.getKeyPair(actorUri);
    if (!keyPair) {
      logger.warn("[Fedify HTTP Signatures] Key pair not found", { actorUri });
      return false;
    }

    // Reconstruct signature string
    const headerList = headers.split(" ");
    const signatureParts: string[] = [];

    for (const headerName of headerList) {
      if (headerName === "(request-target)") {
        const url = new URL(request.url);
        signatureParts.push(
          `(request-target): ${request.method.toLowerCase()} ${url.pathname}`,
        );
      } else {
        const value = request.headers.get(headerName.toLowerCase());
        if (!value) {
          logger.warn("[Fedify HTTP Signatures] Missing required header", {
            headerName,
          });
          return false;
        }
        signatureParts.push(`${headerName.toLowerCase()}: ${value}`);
      }
    }

    const signatureString = signatureParts.join("\n");

    // Verify signature
    // Note: keyPair.publicKey is a string (PEM format) from our ActorKeyPair implementation
    const verify = crypto.createVerify("RSA-SHA256");
    verify.update(signatureString);
    const isValid = verify.verify(
      (keyPair as any).publicKey,
      signature,
      "base64",
    );

    if (!isValid) {
      logger.warn("[Fedify HTTP Signatures] Signature verification failed", {
        keyId,
      });
    }

    return isValid;
  } catch (error) {
    logger.error("[Fedify HTTP Signatures] Error verifying signature", {
      error: (error as Error).message,
    });
    return false;
  }
}

/**
 * Sign outgoing request using Fedify actor dispatcher
 *
 * Uses the UserActorDispatcher to get key pairs and signs requests directly.
 *
 * @param request - Outgoing request
 * @param env - Cloudflare Workers environment
 * @param actorUri - Actor URI for signing
 * @returns Request with signature headers
 */
export async function signRequest(
  request: Request,
  env: Env,
  actorUri: string,
): Promise<Request> {
  const logger = getLogger();

  try {
    // Get actor dispatcher
    const dispatcher = new UserActorDispatcher(env);

    // Get key pair for actor
    const keyPair = await dispatcher.getKeyPair(actorUri);
    if (!keyPair) {
      logger.warn("[Fedify HTTP Signatures] Key pair not found for signing", {
        actorUri,
      });
      return request; // Return original request if no key
    }

    const keyId = `${actorUri}#main-key`;
    const date = new Date().toUTCString();
    const url = new URL(request.url);

    // Create signature string
    const signatureString = [
      `(request-target): ${request.method.toLowerCase()} ${url.pathname}`,
      `host: ${url.host}`,
      `date: ${date}`,
    ].join("\n");

    // Sign with private key
    // Note: keyPair.privateKey is a string (PEM format) from our ActorKeyPair implementation
    const sign = crypto.createSign("RSA-SHA256");
    sign.update(signatureString);
    sign.end();
    const signatureValue = sign.sign((keyPair as any).privateKey, "base64");

    // Create Signature header
    const signatureHeader = [
      `keyId="${keyId}"`,
      'algorithm="rsa-sha256"',
      'headers="(request-target) host date"',
      `signature="${signatureValue}"`,
    ].join(",");

    // Clone request to add headers
    const headers = new Headers(request.headers);
    headers.set("Signature", signatureHeader);
    headers.set("Date", date);

    return new Request(request.url, {
      method: request.method,
      headers,
      body: request.body,
    });
  } catch (error) {
    logger.error("[Fedify HTTP Signatures] Error signing request", {
      error: (error as Error).message,
      actorUri,
    });
    return request; // Return original request on error
  }
}
