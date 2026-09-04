// Statement of reasons (compliance plan 08 §2.4 — DSA Art. 17, jurisdiction-
// neutral). Core WRITES the record and, unless suppressed, DELIVERS it via a
// deployment-injected transport. The human-readable text lives in
// deployment-supplied, counsel-approved templates keyed by `templateKey`; core
// ships no legal copy and stores only template PARAMS — never raw classifier
// output (labels/confidence/decision/provider), which the pure
// `sanitizeStatementParams` guard strips defensively (plan 08 §5 test).
//
// A `suppressStatement` (non-tip-off carve-out, e.g. CSAM) still WRITES the
// record for the audit trail; only delivery is skipped (spec 07 §2.3 / plan 08
// §2.4 + the "suppressed=true writes-but-doesn't-deliver" test).

import type { Env } from "../../env.js";
import { getLogger } from "../logger.js";

/**
 * Keys that MUST NEVER appear in a statement's `params` — they are raw
 * classifier / moderation output whose exposure would (a) leak operational
 * thresholds (anti-oracle) and (b) reveal detection detail to the affected user.
 * The sanitizer drops them defensively even if a caller passes them by mistake.
 */
export const FORBIDDEN_STATEMENT_PARAM_KEYS: ReadonlyArray<string> = [
  "labels",
  "label",
  "category",
  "categories",
  "confidence",
  "score",
  "scores",
  "decision",
  "verdict",
  "provider",
  "blockClass",
  "rawVerdict",
  "moderation",
];

/**
 * Strip any forbidden raw-classifier keys from statement params. Pure + total;
 * returns a new object (immutable input). A non-object input yields `undefined`.
 */
export function sanitizeStatementParams(
  params: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!params || typeof params !== "object") return undefined;
  const forbidden = new Set(FORBIDDEN_STATEMENT_PARAM_KEYS.map((k) => k.toLowerCase()));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (forbidden.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Delivery transport for a written statement. Injected for tests. */
export type StatementDelivery = (record: {
  id: string;
  affectedUserId: string;
  templateKey: string;
  params?: Record<string, unknown>;
}) => Promise<void>;

/**
 * Default delivery: best-effort log only. Real delivery (notification + email
 * to the affected user, rendered from the deployment template) is wired by the
 * deployment via {@link setStatementDelivery}; core ships a neutral no-op that
 * never throws so an un-wired deploy is loud-by-log, not a crash.
 */
const defaultDelivery: StatementDelivery = async (record) => {
  getLogger().info(
    "[StatementOfReasons] statement written (no delivery transport injected)",
    { statementId: record.id, templateKey: record.templateKey },
  );
};

let injectedDelivery: StatementDelivery | undefined;

/** Deployment injects the affected-user delivery transport at startup. */
export function setStatementDelivery(delivery: StatementDelivery): void {
  injectedDelivery = delivery;
}
/** Test-only: clear the injected delivery transport. */
export function __resetStatementDeliveryForTests(): void {
  injectedDelivery = undefined;
}
function getStatementDelivery(): StatementDelivery {
  return injectedDelivery ?? defaultDelivery;
}

/** Minimal Prisma slice needed to write a statement. */
export interface StatementOfReasonsDb {
  statementOfReasons: {
    create(args: {
      data: {
        affectedUserId: string;
        resourceType: string;
        resourceId: string;
        restriction: string;
        templateKey: string;
        params?: Record<string, unknown>;
        suppressed: boolean;
        suppressReason?: string | null;
      };
      select: { id: true; suppressed: true };
    }): Promise<{ id: string; suppressed: boolean }>;
  };
}

export interface WriteStatementInput {
  affectedUserId: string;
  resourceType: string;
  resourceId: string;
  /** "removed" | "hidden" | "account-suspended" … */
  restriction: string;
  templateKey: string;
  params?: Record<string, unknown>;
  /** Present => suppress DELIVERY (still writes the record, audited). */
  suppress?: { reasonKey: string };
}

export interface WriteStatementResult {
  statementId: string;
  suppressed: boolean;
  delivered: boolean;
}

/**
 * Write a statement of reasons and (unless suppressed) deliver it. Params are
 * sanitized of raw classifier output before persistence. Delivery is
 * best-effort — a transport fault never fails the takedown, and never throws
 * into the caller.
 */
export async function writeStatementOfReasons(
  db: StatementOfReasonsDb,
  input: WriteStatementInput,
  _env: Env,
): Promise<WriteStatementResult> {
  const suppressed = input.suppress !== undefined;
  const params = sanitizeStatementParams(input.params);

  const record = await db.statementOfReasons.create({
    data: {
      affectedUserId: input.affectedUserId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      restriction: input.restriction,
      templateKey: input.templateKey,
      ...(params ? { params } : {}),
      suppressed,
      suppressReason: input.suppress?.reasonKey ?? null,
    },
    select: { id: true, suppressed: true },
  });

  if (suppressed) {
    // Non-tip-off carve-out: written for the audit trail, deliberately NOT
    // delivered to the affected user.
    return { statementId: record.id, suppressed: true, delivered: false };
  }

  let delivered = false;
  try {
    await getStatementDelivery()({
      id: record.id,
      affectedUserId: input.affectedUserId,
      templateKey: input.templateKey,
      ...(params ? { params } : {}),
    });
    delivered = true;
  } catch (error) {
    getLogger().error("[StatementOfReasons] delivery failed (best-effort)", error);
  }

  return { statementId: record.id, suppressed: false, delivered };
}
