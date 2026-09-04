/**
 * The extension-facing half of the event seam — `ctx.events.emit(type, payload)`.
 *
 * ## Why an extension cannot emit into another tenant
 *
 * The published signature is `emit(type, payload)`. There is no tenant
 * parameter, so there is nothing for an extension to get wrong or to forge:
 * core closes over the tenant when it builds the context and the extension
 * never sees, names or supplies it. Underneath, {@link emitDomainEvent}
 * requires the branded `TenantId`, whose only constructor (`mintTenantId`) is
 * core-private and is deliberately not re-exported through
 * `@de-otio/trellis-extension-api` — so even an extension that reached the
 * emitter directly could not produce the value it demands.
 *
 * This is the same mechanism `ctx.db.tenant(tid)` uses (O-1 §5.3 / Sec-15
 * confused-deputy defence), reused rather than re-invented.
 *
 * ## Where the tenant comes from
 *
 * Preferably from the tenant core resolved for this request and handed to
 * `createExtensionContext`. When that argument is absent the emitter falls
 * back to the ambient tenant context (`getCurrentTenantId()`), established by
 * the tenant middleware in `lib/app.ts`, and **throws when there is none** —
 * exactly the posture `extensionTenant()` takes for the graph bridge in
 * `extension-context.ts`. Failing loudly at the boundary beats writing an
 * event with an empty tenant, which is an event scoped to nothing and a row a
 * future dispatcher would have no idea who to deliver to.
 *
 * ## Not in a mutation's transaction
 *
 * A core call site emits inside the transaction of the mutation the event
 * describes. An extension's `emit` has no such transaction to join — core does
 * not own the extension's writes and the published contract hands it no `tx` —
 * so each extension emit is its own single-statement transaction. That is
 * honest about what it guarantees: the row is written atomically, and it is
 * NOT tied to whatever the extension did just before. An extension that needs
 * the stronger guarantee needs a contract change (a transaction-carrying emit),
 * not a comment here saying it has one.
 */

import type { ExtensionEventEmitter } from "@de-otio/trellis-extension-api";
import type { Prisma } from "@prisma/client";
import { getCurrentTenantId } from "@de-otio/saas-foundation/tenant";
import type { TenantId } from "../mint-tenant-id.js";
import { emitDomainEvent } from "./emit.js";

/** The slice of a Prisma client this emitter needs. */
export interface TransactionRunner {
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
}

/**
 * Longest event type accepted. A type is a routing key, not a payload; a long
 * one is a caller pushing data through the wrong field.
 */
const MAX_TYPE_LENGTH = 200;

/**
 * Build the `ctx.events` binding for one extension.
 *
 * @param extensionId The emitting extension's id. Recorded as the event's
 *                    subject so an outbox row's origin is unambiguous, and so
 *                    an extension's `walk.created` is distinguishable from a
 *                    hypothetical core event of the same name without
 *                    rewriting the type the extension declared in its catalog.
 * @param prisma      The request's Prisma client.
 * @param tenantId    The tenant core resolved for this request, when it has
 *                    one. Omitted → the ambient tenant context is read at emit
 *                    time and absence throws.
 */
export function createExtensionEventEmitter(
  extensionId: string,
  prisma: TransactionRunner,
  tenantId?: TenantId,
): ExtensionEventEmitter {
  return {
    async emit(type: string, payload: unknown): Promise<void> {
      if (typeof type !== "string" || type.length === 0) {
        throw new Error("ctx.events.emit: `type` must be a non-empty string");
      }
      if (type.length > MAX_TYPE_LENGTH) {
        throw new Error(
          `ctx.events.emit: \`type\` must be at most ${MAX_TYPE_LENGTH} characters`,
        );
      }

      const tid = tenantId ?? getCurrentTenantId();
      if (!tid) {
        throw new Error(
          `ctx.events.emit: extension "${extensionId}" has no active tenant; ` +
            "an event cannot be scoped to nothing (TENANT_SCOPE_MODE is off?)",
        );
      }

      await prisma.$transaction((tx) =>
        emitDomainEvent(tx, {
          type,
          tenantId: tid,
          subjectKind: "extension",
          subjectId: extensionId,
          // The extension's payload, normalised to an object. A non-object
          // (a bare string, a number) is wrapped rather than rejected: the
          // published signature is `payload: unknown` and refusing a legal
          // value at runtime would be a contract the types do not state.
          payload: isPlainObject(payload) ? payload : { value: payload ?? null },
        }),
      );
    },
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
