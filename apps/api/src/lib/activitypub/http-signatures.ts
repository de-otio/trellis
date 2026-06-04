/**
 * HTTP Signatures Service
 *
 * Handles signing and verification of HTTP Signatures for ActivityPub federation.
 * Implements RFC 9421 (HTTP Message Signatures).
 */

import * as crypto from "crypto";
import { getLogger, Logger } from "../logger.js";

export interface HttpSignatureEnv {
  LOG_LEVEL?: string;
  ACTIVITYPUB_BASE_URL?: string;
  [key: string]: any; // Allow additional properties to be compatible with Env
}

export class HttpSignatureService {
  /**
   * Sign outgoing request
   */
  static signRequest(
    method: string,
    path: string,
    host: string,
    privateKey: string,
    keyId: string,
  ): { signature: string; date: string } {
    const date = new Date().toUTCString();

    // Create signature string
    const signatureString = [
      `(request-target): ${method.toLowerCase()} ${path}`,
      `host: ${host}`,
      `date: ${date}`,
    ].join("\n");

    // Sign with private key
    const sign = crypto.createSign("RSA-SHA256");
    sign.update(signatureString);
    sign.end();
    const signature = sign.sign(privateKey, "base64");

    // Create Signature header
    const signatureHeader = [
      `keyId="${keyId}"`,
      'algorithm="rsa-sha256"',
      'headers="(request-target) host date"',
      `signature="${signature}"`,
    ].join(",");

    return {
      signature: signatureHeader,
      date,
    };
  }

  /**
   * Add HTTP Signature headers to request
   */
  static addSignatureHeaders(
    request: Request,
    privateKey: string,
    keyId: string,
  ): Headers {
    const url = new URL(request.url);
    const { signature, date } = this.signRequest(
      request.method,
      url.pathname,
      url.host,
      privateKey,
      keyId,
    );

    const headers = new Headers(request.headers);
    headers.set("Signature", signature);
    headers.set("Date", date);

    return headers;
  }

  /**
   * Verify HTTP Signature on incoming request
   */
  static async verifyRequest(
    request: Request,
    env: HttpSignatureEnv,
  ): Promise<boolean> {
    const logger = getLogger();

    // Parse Signature header
    const signatureHeader = request.headers.get("Signature");
    if (!signatureHeader) {
      logger.warn("[HttpSignatureService] Missing Signature header");
      return false;
    }

    let signatureParams: {
      keyId: string;
      algorithm: string;
      headers: string;
      signature: string;
    };

    try {
      signatureParams = this.parseSignatureHeader(signatureHeader);
    } catch (error) {
      logger.warn("[HttpSignatureService] Failed to parse Signature header", {
        error: (error as Error).message,
      });
      return false;
    }

    const {
      keyId,
      algorithm,
      headers: headerList,
      signature,
    } = signatureParams;

    // Validate algorithm
    if (algorithm !== "rsa-sha256") {
      logger.warn("[HttpSignatureService] Unsupported algorithm", {
        algorithm,
      });
      return false;
    }

    // Fetch public key from actor document
    const publicKey = await this.fetchPublicKey(keyId, env);
    if (!publicKey) {
      logger.warn("[HttpSignatureService] Failed to fetch public key", {
        keyId,
      });
      return false;
    }

    // Reconstruct signature string
    let signatureString: string;
    try {
      signatureString = this.reconstructSignatureString(request, headerList);
    } catch (error) {
      logger.warn(
        "[HttpSignatureService] Failed to reconstruct signature string",
        {
          error: (error as Error).message,
        },
      );
      return false;
    }

    // Verify signature
    try {
      const verify = crypto.createVerify("RSA-SHA256");
      verify.update(signatureString);
      const isValid = verify.verify(publicKey, signature, "base64");

      if (!isValid) {
        logger.warn("[HttpSignatureService] Signature verification failed", {
          keyId,
        });
      }

      return isValid;
    } catch (error) {
      logger.warn(
        "[HttpSignatureService] Error during signature verification",
        {
          error: (error as Error).message,
        },
      );
      return false;
    }
  }

  /**
   * Parse Signature header
   */
  private static parseSignatureHeader(header: string): {
    keyId: string;
    algorithm: string;
    headers: string;
    signature: string;
  } {
    const params: Record<string, string> = {};
    header.split(",").forEach((param) => {
      const trimmed = param.trim();
      const equalIndex = trimmed.indexOf("=");
      if (equalIndex === -1) {
        throw new Error(`Invalid signature parameter: ${trimmed}`);
      }
      const key = trimmed.substring(0, equalIndex).trim();
      const value = trimmed
        .substring(equalIndex + 1)
        .trim()
        .replace(/^"|"$/g, "");
      params[key] = value;
    });

    if (
      !params.keyId ||
      !params.algorithm ||
      !params.headers ||
      !params.signature
    ) {
      throw new Error("Missing required signature parameters");
    }

    return {
      keyId: params.keyId,
      algorithm: params.algorithm,
      headers: params.headers,
      signature: params.signature,
    };
  }

  /**
   * Fetch public key from actor document
   */
  private static async fetchPublicKey(
    keyId: string,
    env: HttpSignatureEnv,
  ): Promise<string | null> {
    const logger = getLogger();

    try {
      // Extract actor URI from keyId (format: https://domain.com/users/username#main-key)
      const actorUri = keyId.split("#")[0];
      if (!actorUri) {
        logger.warn("[HttpSignatureService] Invalid keyId format", { keyId });
        return null;
      }

      // Check if this is a local or remote actor
      const { isRemoteUri } = await import("./standalone-mode.js");
      const isRemote = isRemoteUri(actorUri, env as any);

      let actor: any;

      if (isRemote) {
        // Check if standalone mode is enabled - reject remote signature verification
        const { isStandaloneModeEnabled } = await import("./standalone-mode.js");
        const standaloneMode = await isStandaloneModeEnabled(env as any);
        if (standaloneMode) {
          logger.info(
            "[HttpSignatureService] Rejecting remote signature verification (standalone mode enabled)",
            {
              actorUri,
            },
          );
          return null;
        }

        // Phase 4: Fetch remote actor using RemoteFetchService
        const { RemoteFetchService } = await import("./remote-fetch-service.js");
        const fetchedActor = await RemoteFetchService.fetchActor(
          actorUri,
          env as any,
          logger,
        );
        if (!fetchedActor) {
          logger.warn(
            "[HttpSignatureService] Failed to fetch remote actor document",
            {
              actorUri,
            },
          );
          return null;
        }
        actor = fetchedActor;
      } else {
        // Fetch local actor document
        const response = await fetch(actorUri, {
          headers: {
            Accept: "application/activity+json",
          },
        });

        if (!response.ok) {
          logger.warn("[HttpSignatureService] Failed to fetch actor document", {
            actorUri,
            status: response.status,
          });
          return null;
        }

        actor = (await response.json()) as any;
      }

      const publicKey = actor.publicKey;

      if (!publicKey) {
        logger.warn("[HttpSignatureService] Actor document missing publicKey", {
          actorUri,
        });
        return null;
      }

      // Verify keyId matches
      if (publicKey.id !== keyId) {
        logger.warn("[HttpSignatureService] KeyId mismatch", {
          expected: keyId,
          actual: publicKey.id,
        });
        return null;
      }

      return publicKey.publicKeyPem;
    } catch (error) {
      logger.warn("[HttpSignatureService] Error fetching public key", {
        error: (error as Error).message,
        keyId,
      });
      return null;
    }
  }

  /**
   * Reconstruct signature string from request
   */
  private static reconstructSignatureString(
    request: Request,
    headerList: string,
  ): string {
    const headers: string[] = [];
    const headerNames = headerList.split(" ");

    for (const headerName of headerNames) {
      if (headerName === "(request-target)") {
        const url = new URL(request.url);
        headers.push(
          `(request-target): ${request.method.toLowerCase()} ${url.pathname}`,
        );
      } else {
        const value = request.headers.get(headerName.toLowerCase());
        if (!value) {
          throw new Error(`Missing required header: ${headerName}`);
        }
        headers.push(`${headerName.toLowerCase()}: ${value}`);
      }
    }

    return headers.join("\n");
  }
}
