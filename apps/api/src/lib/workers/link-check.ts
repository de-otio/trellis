/**
 * Link-check (link threat-intel) worker core (WS-2 T5, extracted from
 * `lambda/link-check-worker.ts`).
 *
 * This queue is a LIVE SECURITY CONTROL: post/comment creation enqueues async
 * link checks here (`link-security-handler.queueThreatIntelCheck`, and the
 * inline enqueues in `post-handler` / `comment-handler`). Each message names a
 * `LinkCheck` row created at enqueue time with `status: "pending"`; this core
 * resolves that row to a real verdict.
 *
 * FAIL-CLOSED REMAINS THE RULE. The core throws — so nothing is acked, the
 * batch returns to the queue, and it eventually dead-letters — whenever it
 * cannot obtain a verdict it is entitled to record:
 *
 *   - no `linkThreatIntel` port injected (an un-wired deployment must never
 *     mark links safe),
 *   - the lookup failed transiently (`retryable`), so a retry may yet succeed.
 *
 * NEVER convert either case into a silent return or an ack-drop: a link the
 * deployment failed to check must not end up indistinguishable from one it
 * checked and cleared.
 *
 * A non-retryable "unknown" (today: the API key is absent, which
 * `validateThreatIntelEnv` already refuses to boot with in production) is
 * different — retrying cannot help, and leaving the row `pending` forever is
 * worse than recording that the link is unverified. It resolves to WARNING,
 * which is the same status the synchronous path produces for an unverified
 * link and which drives the safety interstitial.
 */

import type { WorkerContext } from "./context.js";

export type LinkCheckContext = Pick<
  WorkerContext,
  "logger" | "db" | "linkThreatIntel"
>;

/** The message `queueThreatIntelCheck` and the inline enqueues produce. */
export interface LinkCheckMessage {
  linkCheckId: string;
  url: string;
  domain: string;
}

/** Mirrors `LinkStatus` in `link-security-handler.ts` without importing it. */
const LINK_STATUS = {
  safe: "safe",
  warning: "warning",
  blocked: "blocked",
} as const;

function parseMessage(payload: unknown): LinkCheckMessage {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("link-check: payload is not an object");
  }
  const { linkCheckId, url, domain } = payload as Record<string, unknown>;
  if (typeof linkCheckId !== "string" || linkCheckId === "") {
    throw new Error("link-check: payload has no linkCheckId");
  }
  if (typeof url !== "string" || url === "") {
    throw new Error("link-check: payload has no url");
  }
  return {
    linkCheckId,
    url,
    domain: typeof domain === "string" ? domain : "",
  };
}

export async function runLinkCheck(
  payload: unknown,
  ctx: LinkCheckContext,
): Promise<void> {
  const message = parseMessage(payload);

  const port = ctx.linkThreatIntel;
  if (port === undefined) {
    // Fail closed: an un-wired deployment must not resolve pending links.
    ctx.logger.error(
      "link-check: no threat-intel port injected — failing closed; batch will retry and dead-letter",
      { linkCheckId: message.linkCheckId },
    );
    throw new Error(
      "link-check: no threat-intel port injected — failing closed so link-security checks are not silently dropped",
    );
  }

  const verdict = await port.check(message.url);

  if (verdict.status === "unknown" && verdict.retryable) {
    // Transient: the row stays `pending` and the message redelivers. Do NOT
    // record a verdict we did not obtain.
    ctx.logger.warn(
      "link-check: threat-intel lookup failed transiently — not acking",
      {
        linkCheckId: message.linkCheckId,
        failOpenReason: verdict.failOpenReason,
      },
    );
    throw new Error(
      `link-check: threat-intel lookup failed (${verdict.failOpenReason ?? "unknown"}) — retrying`,
    );
  }

  const status =
    verdict.status === "safe"
      ? LINK_STATUS.safe
      : verdict.status === "unsafe"
        ? LINK_STATUS.blocked
        : LINK_STATUS.warning;

  await ctx.db.linkCheck.update({
    where: { id: message.linkCheckId },
    data: {
      status,
      checkedAt: new Date(),
      threatIntel: {
        status: verdict.status,
        threats: verdict.threats ?? [],
        ...(verdict.failOpenReason
          ? { failOpenReason: verdict.failOpenReason }
          : {}),
      },
    },
  });

  if (verdict.status === "unsafe") {
    ctx.logger.warn("link-check: link blocked by threat intel", {
      linkCheckId: message.linkCheckId,
      domain: message.domain,
      threats: verdict.threats,
    });
  }
}
