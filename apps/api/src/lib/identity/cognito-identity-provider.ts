/**
 * `CognitoIdentityProvider` — thin AWS Cognito adapter for the
 * `@de-otio/saas-foundation/identity` `IdentityProviderPort` (WS-3.3).
 *
 * ## Zero-AWS-change invariant
 *
 * This adapter wraps the EXISTING Cognito surfaces byte-identically — the
 * WS-1 `KV_PROVIDER` pattern applied to identity:
 *
 *  - `initiateMagicLink` drives the existing `InitiateAuth` CUSTOM_AUTH path.
 *    The unchanged trigger chain does the rest: define-auth-challenge issues
 *    CUSTOM_CHALLENGE, create-auth-challenge generates + stores the token and
 *    SENDS THE EMAIL itself (so `emailSent: true`, no `link` — on Cognito the
 *    application never sees the link). The returned `handle` is the Cognito
 *    `Session`; completing sign-in means presenting it to
 *    RespondToAuthChallenge with the emailed token. The client-driven Amplify
 *    flow is untouched — this server-side initiation is purely additive.
 *  - `deleteUser` is exactly WS-2's provisional X6 `IdentityAdminPort`
 *    implementation (`AdminDeleteUserCommand({ UserPoolId, Username: email })`,
 *    previously hand-rolled per Lambda entrypoint). SDK errors propagate
 *    UNWRAPPED, as they did there — the WS-2 call sites treat deletion as
 *    best-effort and swallow failures themselves.
 */

import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  IdentityProviderError,
  type IdentityProviderPort,
  type MagicLinkInitiation,
  type MagicLinkOptions,
} from "@de-otio/saas-foundation/identity";

/** The subset of the Cognito client this adapter uses (injectable in tests). */
export interface CognitoClientLike {
  send(command: InitiateAuthCommand | AdminDeleteUserCommand): Promise<{
    ChallengeName?: string;
    Session?: string;
  }>;
}

export interface CognitoIdentityProviderConfig {
  readonly userPoolId: string;
  /**
   * The app client the CUSTOM_AUTH flow runs against. OPTIONAL because the X6
   * admin slice (deleteUser) needs only the pool — the WS-2 entrypoints have
   * always been wired with `COGNITO_USER_POOL_ID` alone and must keep
   * deleting identities without an app client configured. `initiateMagicLink`
   * fails closed (config_missing) when it is absent.
   */
  readonly appClientId?: string;
  readonly region?: string;
  /** Injectable client (tests). */
  readonly client?: CognitoClientLike;
}

export class CognitoIdentityProvider implements IdentityProviderPort {
  private readonly cfg: CognitoIdentityProviderConfig;
  private client: CognitoClientLike | null;

  constructor(config: CognitoIdentityProviderConfig) {
    // Fail closed: the pool is always required.
    if (!config.userPoolId) {
      throw new IdentityProviderError(
        "config_missing",
        "CognitoIdentityProvider: userPoolId is required",
      );
    }
    this.cfg = config;
    this.client = config.client ?? null;
  }

  private getClient(): CognitoClientLike {
    if (this.client === null) {
      this.client = new CognitoIdentityProviderClient({
        ...(this.cfg.region !== undefined ? { region: this.cfg.region } : {}),
      }) as unknown as CognitoClientLike;
    }
    return this.client;
  }

  /**
   * Initiate the existing CUSTOM_AUTH magic-link flow. `opts` fields that are
   * Keycloak-shaped (redirectUri/state/nonce/codeChallenge) are intentionally
   * unused here: on Cognito the link target, TTL (300s) and email content are
   * owned by the create-auth-challenge trigger, and CSRF/PKCE binding is the
   * client session's job. Documented asymmetry, not an omission.
   */
  async initiateMagicLink(email: string, _opts: MagicLinkOptions): Promise<MagicLinkInitiation> {
    if (typeof email !== "string" || email.length === 0) {
      throw new IdentityProviderError("config_missing", "initiateMagicLink: email is required");
    }
    const appClientId = this.cfg.appClientId;
    if (!appClientId) {
      // Fail closed: initiation needs the app client (deleteUser does not).
      throw new IdentityProviderError(
        "config_missing",
        "initiateMagicLink requires an app client id (COGNITO_APP_CLIENT_ID / OIDC_APP_CLIENT_ID)",
      );
    }
    let response: { ChallengeName?: string; Session?: string };
    try {
      response = await this.getClient().send(
        new InitiateAuthCommand({
          AuthFlow: "CUSTOM_AUTH",
          ClientId: appClientId,
          AuthParameters: { USERNAME: email },
        }),
      );
    } catch (err) {
      const name = (err as { name?: string }).name ?? "";
      if (name === "UserNotFoundException") {
        // Never surface raw to end clients — app-layer enumeration stance
        // (G2 C-13/F10) decides the client-visible answer.
        throw new IdentityProviderError("unknown_user", "No user for this email");
      }
      if (name === "NotAuthorizedException") {
        // With PreventUserExistenceErrors, Cognito reports unknown users this
        // way too; either way the flow could not start for this email.
        throw new IdentityProviderError("unauthorized", "Cognito rejected the CUSTOM_AUTH initiation");
      }
      throw new IdentityProviderError(
        "provider_error",
        `Cognito CUSTOM_AUTH initiation failed (${name || "unknown error"})`,
      );
    }
    if (response.ChallengeName !== "CUSTOM_CHALLENGE" || !response.Session) {
      throw new IdentityProviderError(
        "provider_error",
        `Cognito CUSTOM_AUTH initiation returned an unexpected challenge (${String(
          response.ChallengeName,
        )})`,
      );
    }
    return {
      handle: response.Session,
      // create-auth-challenge sent the email inside the trigger chain.
      emailSent: true,
    };
  }

  /**
   * X6 admin surface, byte-identical to the previous per-Lambda
   * `makeCognitoIdentityPort`: SDK errors (incl. UserNotFoundException)
   * propagate unwrapped; callers keep their best-effort handling.
   */
  async deleteUser(input: { readonly email: string }): Promise<void> {
    await this.getClient().send(
      new AdminDeleteUserCommand({
        UserPoolId: this.cfg.userPoolId,
        Username: input.email,
      }),
    );
  }
}
