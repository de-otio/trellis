/**
 * Thin AWS entrypoint for the link-check queue (WS-2 T5).
 *
 * The behaviour lives in `lib/workers/link-check.ts`; this file only resolves
 * the capabilities that core is forbidden to resolve itself (finding 7): the
 * Prisma client and a threat-intel port carrying the Safe Browsing API key and
 * KV cache.
 *
 * There is deliberately no `batchItemFailures` array. For this live security
 * control the contract stays "throw → nothing acked → retry → DLQ": a link the
 * deployment could not check must never become indistinguishable from one it
 * checked and cleared. Partial-batch reporting would ack the records processed
 * before a failure, and the failure modes here (no port, transient lookup
 * error) apply to the whole batch anyway.
 */

import type { SQSHandler } from "aws-lambda";
import { getLogger } from "../lib/logger.js";
import { runLinkCheck } from "../lib/workers/link-check.js";
import { makeLinkThreatIntelPort } from "../lib/workers/link-threat-intel-adapter.js";
import { getLambdaPrisma } from "../lib/lambda-prisma.js";
import { buildEnv } from "../env.js";

// Lazy: resolved at use, never at module load (the key is a secret, and cold
// starts should not pay for an env build that the batch may not need).
const linkThreatIntel = makeLinkThreatIntelPort(() => buildEnv());

export const handler: SQSHandler = async (event) => {
  const logger = getLogger();
  const db = await getLambdaPrisma();

  for (const record of event.Records) {
    // One message at a time: a throw abandons the whole batch, which is the
    // intended fail-closed behaviour.
    await runLinkCheck(JSON.parse(record.body), {
      logger,
      db,
      linkThreatIntel,
    });
  }
};
