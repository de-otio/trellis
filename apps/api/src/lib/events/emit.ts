/**
 * Domain-event emission — the write half of the outbox (plan 034 lane E).
 *
 * NOT to be confused with the calendar-`Event` handlers that share this
 * directory (`event-handler.ts`, `rsvp-handler.ts`, `shift-handler.ts`). Those
 * are a domain model called Event; this file is about *domain events* — the
 * `domain_events` outbox rows that record that something happened.
 *
 * ## The one rule
 *
 * `emitDomainEvent` takes a `Prisma.TransactionClient` as its first argument
 * and nothing else. That is deliberate and is the whole design: it makes the
 * transactional requirement a *type* error to get wrong rather than a review
 * comment to remember. A row written outside the emitting mutation's
 * transaction is an event for a write that rolled back, and a subscriber
 * acting on a phantom event corrupts its own state — worse than no event.
 *
 * There is no `emitDomainEventOutsideTransaction`, and adding one would
 * dissolve the guarantee. A caller that has no transaction should open one
 * around its own write and pass the `tx`.
 *
 * ## Nothing reads this
 *
 * Phase 0 writes the outbox and never reads it. There is no dispatcher, no
 * sweeper, no subscriber, and `deliveredAt` is set by nobody. Delivery
 * (signed `safe-fetch`, MNQ retry, DLQ) is Phase 2. Emission *points* are the
 * expensive thing to retrofit across every mutation; delivery is not.
 *
 * ## Payloads
 *
 * Ids and the names of the fields that changed — never their values, never
 * free text, never contact data. A consumer that needs the object fetches it
 * with a scoped token, at which point the normal access controls and the
 * normal erasure path apply. `MINIMISED_PAYLOAD_NOTE` below is the sentence
 * to quote at a reviewer who proposes putting content in a payload.
 */

import type { Prisma } from "@prisma/client";
import type { TenantId } from "../mint-tenant-id.js";

/**
 * The erasure posture of every outbox payload, in one sentence.
 *
 * Exported so a test can assert it exists and a future call site's author sees
 * it in autocomplete. If a payload ever has to carry personal data, the
 * `DomainEvent` model needs the same `/// erasure:` discipline the extension
 * tables carry, and that has to be argued in the change that introduces it —
 * not assumed.
 */
export const MINIMISED_PAYLOAD_NOTE =
  "Domain-event payloads carry ids and changed field names only — never values, free text or contact data.";

/**
 * An event about to be written to the outbox.
 *
 * `tenantId` is the branded {@link TenantId}, which only core can mint
 * (`mintTenantId`, core-private and never re-exported through
 * `@de-otio/trellis-extension-api`). That is what stops an in-process
 * extension from writing an event scoped to a tenant it does not act for: it
 * has no way to construct the value this field requires, and the
 * extension-facing `emit(type, payload)` never accepts one.
 */
export interface NewDomainEvent {
  /** `<subject>.<verb>`, past tense — `post.published`, `consent.withdrawn`. */
  readonly type: string;
  /** The tenant the event happened in. Branded; core-minted only. */
  readonly tenantId: TenantId;
  /** What the event is about — `post`, `consent`, `rsvp`, `extension`. */
  readonly subjectKind: string;
  /** The subject's id. */
  readonly subjectId: string;
  /**
   * Ids and changed field names only — see {@link MINIMISED_PAYLOAD_NOTE}.
   * A plain JSON object; anything unserialisable is a caller bug.
   */
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Write one event to the outbox, in the caller's transaction.
 *
 * Errors are NOT swallowed. An outbox insert that fails must roll the
 * mutation back with it — the alternative is a mutation that succeeded and an
 * event that silently did not, which is exactly the divergence the outbox
 * exists to prevent. (Contrast the audit logger and the graph dual-write,
 * which are best-effort by design and say so at their call sites.)
 *
 * @param tx The transaction client of the mutation this event describes.
 *           Passing the non-transactional client is a type error.
 * @param e  The event.
 */
export async function emitDomainEvent(
  tx: Prisma.TransactionClient,
  e: NewDomainEvent,
): Promise<void> {
  await tx.domainEvent.create({
    data: {
      type: e.type,
      tenantId: e.tenantId,
      subjectKind: e.subjectKind,
      subjectId: e.subjectId,
      // Spread into a fresh object: the caller's literal is `readonly` and
      // Prisma's `InputJsonValue` is not, and a caller must never be able to
      // hand us a live reference it goes on mutating after the write.
      payload: { ...e.payload } as Prisma.InputJsonObject,
    },
  });
}
