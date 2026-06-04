/**
 * Cognito IdP-name derivation. Cognito's user-pool quota limits provider names
 * to 32 characters. We use `tenant-{cuid}` so each tenant gets a unique
 * Cognito identity-provider name. cuid v1 is 25 chars which fits the 32-char
 * limit (`tenant-` is 7 chars). Tenants whose IDs exceed 25 chars are
 * truncated to 25 — collision is theoretically possible only between IDs
 * sharing a 25-char prefix, which is astronomically unlikely for cuid.
 *
 * T5 (IdP CRUD) consumes this to populate `ProviderName` on `CreateIdentityProviderCommand`;
 * T8 (sign-in discovery) consumes it to build the Cognito Hosted UI redirect URL.
 */
const TENANT_ID_MAX = 25;

export function cognitoIdpName(tenantId: string): string {
  const id = tenantId.length > TENANT_ID_MAX ? tenantId.slice(0, TENANT_ID_MAX) : tenantId;
  return `tenant-${id}`;
}
