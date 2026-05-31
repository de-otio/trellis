/**
 * Secrets Manager wrapper for IdP client secrets.
 *
 * Naming convention: `tenant/{tenantId}/idp-client-secret`. The IAM policy
 * grants Trellis's task role only `secretsmanager:CreateSecret`,
 * `PutSecretValue`, `DeleteSecret`, `DescribeSecret`, `GetSecretValue` on
 * `arn:aws:secretsmanager:{region}:{account}:secret:tenant/*` so a leak in
 * the IdP CRUD path can never read or rewrite secrets outside that prefix.
 *
 * The plaintext secret enters via `createOrUpdate` and is forwarded straight
 * to Secrets Manager. It is never logged here. Callers must not log it
 * either.
 */
import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
} from "@aws-sdk/client-secrets-manager";

export const IDP_SECRET_PREFIX = "tenant/";
export const IDP_SECRET_SUFFIX = "/idp-client-secret";

export function idpSecretName(tenantId: string): string {
  return `${IDP_SECRET_PREFIX}${tenantId}${IDP_SECRET_SUFFIX}`;
}

export interface IdpSecretRecord {
  arn: string;
  versionId?: string;
}

export class IdpSecretsClient {
  constructor(private readonly client: SecretsManagerClient) {}

  /**
   * Create the secret on first IdP connect. Tagged with the tenantId so an
   * audit (or per-tenant cleanup) can find the secret without a lookup table.
   * Throws if a secret with the same name already exists — the route handler
   * maps that into 409.
   */
  async create(tenantId: string, plaintext: string): Promise<IdpSecretRecord> {
    const name = idpSecretName(tenantId);
    const result = await this.client.send(
      new CreateSecretCommand({
        Name: name,
        SecretString: plaintext,
        Tags: [
          { Key: "tenantId", Value: tenantId },
          { Key: "purpose", Value: "idp-client-secret" },
        ],
      }),
    );
    if (!result.ARN) {
      throw new Error("Secrets Manager CreateSecret returned no ARN");
    }
    return { arn: result.ARN, ...(result.VersionId ? { versionId: result.VersionId } : {}) };
  }

  /**
   * Rotate the secret in place. Returns the new version id so the caller
   * can attach it to audit metadata.
   */
  async rotate(tenantId: string, plaintext: string): Promise<IdpSecretRecord> {
    const name = idpSecretName(tenantId);
    const result = await this.client.send(
      new PutSecretValueCommand({
        SecretId: name,
        SecretString: plaintext,
      }),
    );
    if (!result.ARN) {
      throw new Error("Secrets Manager PutSecretValue returned no ARN");
    }
    return { arn: result.ARN, ...(result.VersionId ? { versionId: result.VersionId } : {}) };
  }

  /**
   * Permanently delete with no recovery window. We never want to leave
   * dangling client secrets in Secrets Manager, and the only call sites
   * (rollback after Cognito create failure, IdP disconnect) are explicitly
   * destructive. NotFound is silently swallowed for idempotency.
   */
  async delete(tenantId: string): Promise<void> {
    const name = idpSecretName(tenantId);
    try {
      await this.client.send(
        new DeleteSecretCommand({
          SecretId: name,
          ForceDeleteWithoutRecovery: true,
        }),
      );
    } catch (err) {
      const errName = (err as { name?: string }).name;
      if (errName === "ResourceNotFoundException") return;
      throw err;
    }
  }

  /**
   * Existence + ARN lookup. Used at IdP create time to decide whether to
   * call Create vs Put. Returns null if the secret does not exist.
   */
  async describe(tenantId: string): Promise<IdpSecretRecord | null> {
    const name = idpSecretName(tenantId);
    try {
      const result = await this.client.send(
        new DescribeSecretCommand({ SecretId: name }),
      );
      if (!result.ARN) return null;
      return { arn: result.ARN };
    } catch (err) {
      const errName = (err as { name?: string }).name;
      if (errName === "ResourceNotFoundException") return null;
      throw err;
    }
  }
}

export function createIdpSecretsClient(region?: string): IdpSecretsClient {
  return new IdpSecretsClient(
    new SecretsManagerClient({ region: region ?? process.env.AWS_REGION ?? "eu-central-1" }),
  );
}
