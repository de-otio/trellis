/**
 * Text-moderation gate for user-authored text on the posting flow (post
 * create/edit, comment create/edit).
 *
 * THE fail-closed choke point: every moderated text write calls
 * {@link gateTextOrRespond} and only proceeds when the injected
 * TextModerationProvider affirmatively returns `decision: "approved"`.
 *
 * Mapping (fail-closed, mirrors the media pipeline's invariant):
 *   approved            -> null (caller proceeds; content may be persisted)
 *   quarantine          -> 400 CONTENT_REJECTED   (positive flag — not persisted)
 *   review / anything   -> 503 MODERATION_UNAVAILABLE (uncertainty/fault —
 *   else / provider          not persisted; retryable)
 *   throw
 *
 * A provider throw is caught HERE and treated as `review`: a faulted provider
 * must degrade to fail-closed 503, never bubble into a generic 500 — and never,
 * ever approve. There is deliberately NO branch in this module that returns
 * null on any error path.
 */

import { getTextModerationProvider } from "./media/request-text-moderation.js";
import type { ModerationVerdict } from "./media/moderation-provider.js";
import { getLogger } from "./logger.js";

const JSON_HEADERS = { "content-type": "application/json" } as const;

/**
 * Moderate `text` through the injected TextModerationProvider seam.
 *
 * Returns `null` when the text is affirmatively approved; otherwise returns the
 * error Response the route handler must send (the content must NOT be
 * persisted or served).
 *
 * @param text            The user-authored text to moderate.
 * @param rejectedMessage User-facing message for a positive rejection
 *                        (quarantine). The unavailable/review message is fixed.
 */
export async function gateTextOrRespond(
  text: string,
  rejectedMessage: string,
): Promise<Response | null> {
  let verdict: ModerationVerdict | undefined;
  try {
    verdict = await getTextModerationProvider().moderateText(text);
  } catch (error) {
    // Fail closed: a faulted provider is uncertainty, and uncertainty never
    // approves. Treated exactly like a `review` verdict below.
    getLogger().error(
      "[TextModerationGate] provider threw — failing closed to review",
      error,
    );
    verdict = undefined;
  }

  if (verdict?.decision === "approved") {
    return null;
  }

  if (verdict?.decision === "quarantine") {
    return new Response(
      JSON.stringify({ error: "CONTENT_REJECTED", message: rejectedMessage }),
      { status: 400, headers: JSON_HEADERS },
    );
  }

  // `review`, an unknown/future decision token, or a provider fault: the text
  // could not be affirmatively approved. Hold it (do not persist), retryable.
  getLogger().warn("[TextModerationGate] text held (fail-closed)", {
    decision: verdict?.decision ?? "provider-error",
    provider: verdict?.provider,
  });
  return new Response(
    JSON.stringify({
      error: "MODERATION_UNAVAILABLE",
      message:
        "Your content could not be checked right now. Please try again in a few minutes.",
    }),
    { status: 503, headers: JSON_HEADERS },
  );
}
