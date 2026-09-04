/**
 * Provider-neutral {@link DeletionEmailPort} factory for the worker container
 * (plan 015 WS-5).
 *
 * The AWS nightly-cron entrypoint (`lambda/nightly-cron.ts`) hand-rolls an
 * SES-only port. The worker container instead builds the deployment's
 * CONFIGURED email provider from env — `EMAIL_SERVICE` selects it exactly as
 * for every other send (scaleway-tem on Scaleway, aws-ses on AWS, resend/…) —
 * and adapts its generic `sendEmail()` to the narrow `sendAccountDeleted()`
 * the nightly cron's completion step needs. One provider-selection path, no
 * second SES hard-wire.
 *
 * Fail-closed to `undefined` (⇒ the core skips the confirmation send, never
 * fails the deletion — see `runNightlyCron` step 4f) when:
 *   - `EMAIL_SERVICE` is unset (no provider chosen), or
 *   - the selected provider's required env is missing/half-set
 *     (`validateEmailEnv`), or
 *   - no From address is resolvable (`FROM_EMAIL`) — a send with no From
 *     cannot succeed, so a silent skip beats a guaranteed throw.
 *
 * From-address alignment mirrors `makeSesEmailPort` (nightly-cron.ts):
 * `${EMAIL_BRAND_NAME|Trellis} <${FROM_EMAIL}>`, so the From matches the
 * DKIM/SPF-validated sending domain (DMARC). The confirmation email is a live
 * send — reputation matters (plan 014 posture).
 */

import {
  createEmailProvider,
  emailProviderConfigFromEnv,
  validateEmailEnv,
  type EmailEnvSource,
} from "../email-provider.js";
import type { DeletionEmailPort } from "./nightly-cron.js";

/** `EmailEnvSource` plus the brand-name var the From line uses. Both the app
 *  `Env` and `process.env` satisfy this (all optional strings). */
export type DeletionEmailEnvSource = EmailEnvSource & {
  EMAIL_BRAND_NAME?: string;
};

/**
 * Build the container's `DeletionEmailPort` from env, or `undefined` when no
 * usable sender is configured (fail-closed; see module doc).
 */
export function makeEmailPortFromEnv(
  src: DeletionEmailEnvSource = process.env,
): DeletionEmailPort | undefined {
  if (!src.EMAIL_SERVICE) return undefined;
  // A half-configured provider (e.g. TEM without its project id) must not
  // produce a port that throws mid-batch — skip the confirmation instead.
  if (validateEmailEnv(src).length > 0) return undefined;
  if (!src.FROM_EMAIL) return undefined;

  const provider = createEmailProvider(emailProviderConfigFromEnv(src));
  const brandName = src.EMAIL_BRAND_NAME || "Trellis";
  const from = `${brandName} <${src.FROM_EMAIL}>`;

  return {
    async sendAccountDeleted({ to, subject, textBody, htmlBody }) {
      await provider.sendEmail({
        from,
        to,
        subject,
        text: textBody,
        html: htmlBody,
      });
    },
  };
}
