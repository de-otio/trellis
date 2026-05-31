/**
 * SSO Auth Handler stub — legacy Supabase/SAML SSO is no longer supported.
 * Authentication is handled by AWS Cognito + Amplify SDK.
 * This stub exists to satisfy test mocks that reference this module.
 */
export class SSOAuthHandler {
  async initiateSSO(..._args: unknown[]): Promise<Response> {
    return new Response(JSON.stringify({ error: "Deprecated" }), { status: 410 });
  }
  async handleSSOCallback(..._args: unknown[]): Promise<Response> {
    return new Response(JSON.stringify({ error: "Deprecated" }), { status: 410 });
  }
  async handleSSOExchange(..._args: unknown[]): Promise<Response> {
    return new Response(JSON.stringify({ error: "Deprecated" }), { status: 410 });
  }
  async handleTokenExchange(..._args: unknown[]): Promise<Response> {
    return new Response(JSON.stringify({ error: "Deprecated" }), { status: 410 });
  }
}
