/**
 * Amazon Neptune IAM (SigV4) authentication for the Bolt protocol.
 *
 * Neptune with IAM auth expects a Bolt auth token whose scheme is `basic`,
 * whose principal is a dummy username, and whose *credentials* field is a JSON
 * blob of SigV4-signed request headers (signed against `GET /opencypher`,
 * service `neptune-db`). See the canonical Node.js pattern in the AWS docs:
 * https://docs.aws.amazon.com/neptune/latest/userguide/access-graph-opencypher-bolt.html
 *
 * SigV4 signatures expire (~5 min). trellis uses a single long-lived pooled
 * driver, so a *static* token would start failing after expiry. We therefore
 * hand the driver an {@link AuthTokenManager} (neo4j-driver ≥ 6) that re-signs
 * proactively before the signature expires.
 *
 * ⚠️ The live connection path (TLS handshake + Neptune's signature
 * verification + token-refresh behaviour) can only be verified against a real
 * Neptune cluster — that is the Track-D integration test, not a unit test.
 */
import neo4j, { type AuthToken, type AuthTokenManager } from "neo4j-driver";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
// `@aws-crypto/sha256-js` exposes Sha256 as a named CJS export (no `default`).
// Use the named import so it resolves under Node ESM / esbuild AND vite SSR —
// the standalone lane boots the server via vite SSR, where a default import of
// this package is `undefined` and destructuring it throws at module load.
import { Sha256 } from "@aws-crypto/sha256-js";

const SERVICE_NAME = "neptune-db";
const DUMMY_USERNAME = "username";
/** Re-sign this far ahead of the ~5-minute SigV4 expiry. */
const TOKEN_TTL_MS = 4 * 60 * 1000;

export interface NeptuneAuthOptions {
  /** Cluster endpoint host, e.g. `my-cluster.cluster-xxxx.eu-central-1.neptune.amazonaws.com`. */
  host: string;
  /** Bolt port (8182). */
  port: number;
  /** AWS region of the cluster. */
  region: string;
}

/**
 * Produce a fresh SigV4-signed Neptune Bolt auth token. Credentials are sourced
 * from the default provider chain (ECS task role in production).
 */
export async function signNeptuneAuthToken(opts: NeptuneAuthOptions): Promise<AuthToken> {
  const { host, port, region } = opts;
  const hostPort = `${host}:${port}`;

  const request = new HttpRequest({
    method: "GET",
    // Scheme is not part of the SigV4 canonical request; only method, path,
    // query, and the signed headers (host) are. Use a conventional value.
    protocol: "https:",
    hostname: host,
    port,
    path: "/opencypher", // required for Neptune engine ≥ 1.2.0.0
    headers: { host: hostPort },
  });

  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region,
    service: SERVICE_NAME,
    sha256: Sha256,
  });

  const signed = await signer.sign(request, {
    unsignableHeaders: new Set(["x-amz-content-sha256"]),
  });

  const authInfo = JSON.stringify({
    Authorization: signed.headers["authorization"],
    HttpMethod: signed.method,
    "X-Amz-Date": signed.headers["x-amz-date"],
    Host: signed.headers["host"],
    "X-Amz-Security-Token": signed.headers["x-amz-security-token"],
  });

  // scheme="basic", principal=dummy, credentials=signed-header JSON, realm="realm"
  return neo4j.auth.custom(DUMMY_USERNAME, authInfo, "realm", "basic");
}

/**
 * An {@link AuthTokenManager} that re-signs before the SigV4 signature expires,
 * so a long-lived pooled driver keeps authenticating across the 5-minute window.
 */
export function createNeptuneAuthTokenManager(opts: NeptuneAuthOptions): AuthTokenManager {
  return neo4j.authTokenManagers.bearer({
    tokenProvider: async () => ({
      token: await signNeptuneAuthToken(opts),
      expiration: new Date(Date.now() + TOKEN_TTL_MS),
    }),
  });
}

/** Parse `bolt://host:port` (or `bolt+s://…`) into the host/port the signer needs. */
export function parseBoltEndpoint(endpoint: string): { host: string; port: number } {
  const url = new URL(endpoint);
  return { host: url.hostname, port: url.port ? Number(url.port) : 8182 };
}
