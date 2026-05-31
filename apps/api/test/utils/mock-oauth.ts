/**
 * Mock OAuth 2.0 Components
 *
 * Provides mocks for OAuth flow testing (PKCE, PAR, DPoP, etc.)
 */

/**
 * Mock PKCE code verifier and challenge
 */
export function generateMockPKCE(): {
  codeVerifier: string;
  codeChallenge: string;
} {
  // In real implementation, this would generate random values and compute SHA256
  return {
    codeVerifier: "mock-code-verifier-43-characters-long-xxxxxxxxxxxx",
    codeChallenge: "mock-code-challenge-base64-url-safe",
  };
}

/**
 * Mock state token for CSRF protection
 */
export function generateMockState(): string {
  return "mock-state-token-" + Math.random().toString(36).substring(7);
}

/**
 * Mock DPoP keypair (ES256)
 */
export interface MockDPoPKeypair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
}

export async function generateMockDPoPKeypair(): Promise<MockDPoPKeypair> {
  // In real implementation, this would generate an EC P-256 keypair
  // For testing, we'll create a mock structure
  const keypair = await crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["sign", "verify"],
  );

  const publicKeyJwk = await crypto.subtle.exportKey("jwk", keypair.publicKey);

  return {
    privateKey: keypair.privateKey,
    publicKey: keypair.publicKey,
    publicKeyJwk: publicKeyJwk as JsonWebKey,
  };
}

/**
 * Mock DPoP JWT token
 *
 * Returns a properly formatted JWT with 3 parts (header.payload.signature)
 */
export function createMockDPoPJWT(
  keypair: MockDPoPKeypair,
  nonce?: string,
): string {
  // In real implementation, this would create a proper JWT
  // For testing, return a mock token in JWT format (header.payload.signature)
  const header = {
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: keypair.publicKeyJwk,
  };

  const payload = {
    jti: "mock-jti",
    htm: "POST",
    htu: "https://bsky.social",
    iat: Math.floor(Date.now() / 1000),
    ...(nonce && { nonce }),
  };

  // Create a mock JWT with 3 parts (header.payload.signature)
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString(
    "base64url",
  );
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  const mockSignature = "mock-signature";

  return `${encodedHeader}.${encodedPayload}.${mockSignature}`;
}

/**
 * Mock OAuth authorization server metadata
 */
export function createMockAuthorizationServerMetadata() {
  return {
    issuer: "https://bsky.social",
    authorization_endpoint: "https://bsky.social/oauth/authorize",
    token_endpoint: "https://bsky.social/oauth/token",
    pushed_authorization_request_endpoint: "https://bsky.social/oauth/par",
    dpop_signing_alg_values_supported: ["ES256"],
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
  };
}

/**
 * Mock OAuth client metadata
 */
export function createMockClientMetadata() {
  return {
    client_id:
      "https://test.example.com/.well-known/oauth-client-metadata.json",
    application_type: "web",
    grant_types: ["authorization_code", "refresh_token"],
    scope: "atproto",
    response_types: ["code"],
    redirect_uris: ["https://test.example.com/auth/callback"],
    dpop_bound_access_tokens: true,
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_signing_alg: "ES256",
    jwks: {
      keys: [
        {
          kty: "EC",
          crv: "P-256",
          x: "mock-x-coordinate",
          y: "mock-y-coordinate",
          kid: "mock-key-id",
        },
      ],
    },
  };
}
