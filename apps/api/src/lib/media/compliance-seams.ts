// CONTRACT: stable — coordinate changes.
//
// Compliance seams (plan 08 §2.5, plan 07 §4.2/§4.3). These are the SDK-free
// capability interfaces the deployment (skybber → Germany) injects concrete
// adapters for — exactly the MediaModerationProvider / TextModerationProvider
// pattern. Core imports no cloud SDK, hardcodes no jurisdiction, and performs no
// network I/O; it only routes on `RoutingClass` and calls through these seams.
//
// SCOPE NOTE (Lane A / plan 08 Phase 1): this file defines the INTERFACE STUBS
// plus fail-safe defaults and the injection points so downstream lanes (A2
// enforcement, B infra, C adapters, E Flutter wire-up) can compile against a
// fixed contract. The BODIES of the enforcement flow (`restrictContent`,
// authority-report tracking, the owner-scoped disposition read, submit-for-
// analysis) are Lane A2 / plan 08 Phase 2 + spec 07 §4 — deliberately NOT built
// here. The defaults are fail-SAFE: preservation and the feedback sink THROW
// when un-injected (a mis-wired deploy must fail loud before it can drop
// evidence or leak content), and the authority channel defaults to a manual
// stub that records nothing and refuses to auto-file.

// ---------------------------------------------------------------------------
// Server-only block class (spec 07 §4.3).
// ---------------------------------------------------------------------------

/**
 * The internal, BACKEND-ONLY moderation block class. This bit NEVER leaves the
 * domain: it is not in `ModerationResolvedPayload`, not in the owner-scoped
 * disposition read (which exposes only a coarse `appealable` boolean derived
 * from it), and never in any client response or notification payload.
 *
 * - `lawful-flagged`   — a lawful-content false-positive candidate. May be
 *                        offered the submit-for-analysis path (plan 07).
 * - `illegal-suspected`— suspected-illegal (e.g. OpenAI `sexual/minors`, or a
 *                        future hash-match hit). Drives the carve-out: NEVER
 *                        offered submit, NEVER written to the analysis sink,
 *                        routed to preserve-in-place + the mandated report.
 *
 * Lane A2 consumes this; Lane A only defines it so the contract is fixed.
 */
export type BlockClass = "lawful-flagged" | "illegal-suspected";

// ---------------------------------------------------------------------------
// Evidence preservation (M7) — WORM store, skybber: S3 Object Lock + Legal Hold.
// ---------------------------------------------------------------------------

/**
 * The Art. 18 "all relevant information available" bundle: a reference to the
 * content, where its bytes live, the uploader/account context, the report
 * chain, and timestamps. Refs only — NEVER raw bytes in this object.
 *
 * Field shapes are intentionally loose (`string`/`Json`-ish) at the Lane A stub
 * stage; Lane A2 tightens them alongside the `restrictContent` orchestration.
 */
export interface EvidenceBundle {
  /** Opaque content reference (e.g. `${resourceType}:${resourceId}`). */
  readonly contentRef: string;
  /** Where the preserved bytes live (bucket/key handle), NOT the bytes. */
  readonly bytesLocation?: { readonly bucket: string; readonly key: string; readonly versionId?: string };
  /** Uploader / account context available at preservation time. */
  readonly uploaderContext?: Record<string, unknown>;
  /** The chain of report ids / signals that led here. */
  readonly reportChain?: ReadonlyArray<string>;
  /** ISO timestamps of the relevant events. */
  readonly timestamps?: Record<string, string>;
}

/**
 * M7 — preserve illegal-content evidence to a WORM store and, on case closure,
 * release the hold. skybber injects an `S3EvidencePreservationStore` (Object
 * Lock + Legal Hold). Fail-safe default THROWS: a deployment MUST inject a real
 * store before enabling any `ILLEGAL_*` category (plan 08 §5 fail-safe test).
 */
export interface EvidencePreservationStore {
  preserve(bundle: EvidenceBundle): Promise<{ evidenceId: string }>;
  /** Release the legal hold when the authority case closes. Audited. */
  releaseHold(evidenceId: string, reason: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Authority reporting (M3) — channel-agnostic; skybber: manual BKA portal now.
// ---------------------------------------------------------------------------

/** The bundle handed to the authority channel. Refs, never bytes. */
export interface AuthorityReportBundle {
  readonly jurisdiction: string;
  readonly evidenceId?: string;
  readonly bundle: Record<string, unknown>;
}

/** The two channel outcomes. `manual` = the operator files it by hand. */
export type AuthorityReportResult =
  | { readonly mode: "manual"; readonly instructionsKey: string }
  | { readonly mode: "api"; readonly receiptId: string };

/**
 * M3 — submit an authority report through the deployment's channel. NEVER
 * auto-submits from core routing: the operator confirms and files (a false
 * positive to a federal police portal is not acceptable). Fail-safe default is
 * a manual stub that records nothing and returns a placeholder instructions key
 * — a real deployment injects `ManualBkaChannel` (which notifies the operator).
 */
export interface AuthorityReportChannel {
  submit(report: AuthorityReportBundle): Promise<AuthorityReportResult>;
}

// ---------------------------------------------------------------------------
// Moderation feedback sink (plan 07 §4.2) — write-only analysis sink.
// ---------------------------------------------------------------------------

/** A consent-gated, lawful-content feedback record destined for the sink. */
export interface ModerationFeedbackRecord {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly reporterUserId: string;
  readonly description?: string;
  readonly includeContent: boolean;
  /**
   * The server-re-derived block class. Defense-in-depth (plan 09 §6.5): the
   * concrete sink adapter MUST refuse to write an `illegal-suspected` record —
   * illegal content never lands in the analysis sink even if core mis-routes.
   */
  readonly blockClass: BlockClass;
}

/**
 * plan 07 §4.2 — the write-only analysis sink for lawful-content false-positive
 * submissions. skybber injects an `S3ModerationFeedbackSink`. Fail-safe default
 * THROWS when un-injected: a submit path that silently no-ops would look like a
 * successful capture while dropping the data.
 */
export interface ModerationFeedbackSink {
  store(record: ModerationFeedbackRecord): Promise<void>;
}

// ---------------------------------------------------------------------------
// Fail-safe default stubs.
// ---------------------------------------------------------------------------

/** Error thrown by an un-injected fail-safe seam. Lets wiring/tests assert. */
export class ComplianceSeamNotConfiguredError extends Error {
  constructor(seam: string) {
    super(
      `${seam} is not configured. A deployment MUST inject a concrete adapter ` +
        "via registerComplianceProfile()/the seam setter before enabling any " +
        "ILLEGAL_* report category or the moderation-feedback path. Refusing to " +
        "run: a silent no-op here would drop evidence or feedback data.",
    );
    this.name = "ComplianceSeamNotConfiguredError";
  }
}

class ThrowingEvidencePreservationStore implements EvidencePreservationStore {
  async preserve(): Promise<{ evidenceId: string }> {
    throw new ComplianceSeamNotConfiguredError("EvidencePreservationStore");
  }
  async releaseHold(): Promise<void> {
    throw new ComplianceSeamNotConfiguredError("EvidencePreservationStore");
  }
}

class ThrowingModerationFeedbackSink implements ModerationFeedbackSink {
  async store(): Promise<void> {
    throw new ComplianceSeamNotConfiguredError("ModerationFeedbackSink");
  }
}

/**
 * Manual, no-op-but-loud default channel. Returns `mode:"manual"` with a
 * neutral placeholder instructions key. It records nothing and cannot auto-file
 * — matching the "never auto-submit" invariant. A real deployment replaces it
 * with `ManualBkaChannel` (which additionally notifies the operator + carries
 * the portal runbook key).
 */
class ManualStubAuthorityReportChannel implements AuthorityReportChannel {
  async submit(): Promise<AuthorityReportResult> {
    return { mode: "manual", instructionsKey: "authority.manual.unconfigured" };
  }
}

// ---------------------------------------------------------------------------
// Injection seams (mirror setTextModerationProvider). One consuming app calls
// each setter ONCE at startup (via registerComplianceProfile in server.ts).
// ---------------------------------------------------------------------------

let injectedEvidenceStore: EvidencePreservationStore | undefined;
let injectedAuthorityChannel: AuthorityReportChannel | undefined;
let injectedFeedbackSink: ModerationFeedbackSink | undefined;

export function setEvidencePreservationStore(store: EvidencePreservationStore): void {
  injectedEvidenceStore = store;
}
export function getEvidencePreservationStore(): EvidencePreservationStore {
  return injectedEvidenceStore ?? new ThrowingEvidencePreservationStore();
}

export function setAuthorityReportChannel(channel: AuthorityReportChannel): void {
  injectedAuthorityChannel = channel;
}
export function getAuthorityReportChannel(): AuthorityReportChannel {
  return injectedAuthorityChannel ?? new ManualStubAuthorityReportChannel();
}

export function setModerationFeedbackSink(sink: ModerationFeedbackSink): void {
  injectedFeedbackSink = sink;
}
export function getModerationFeedbackSink(): ModerationFeedbackSink {
  return injectedFeedbackSink ?? new ThrowingModerationFeedbackSink();
}

/** True when no real evidence store has been injected (still the throwing default). */
export function isEvidencePreservationConfigured(): boolean {
  return injectedEvidenceStore !== undefined;
}

/** Test-only: clear all injected compliance seams so tests don't leak state. */
export function __resetComplianceSeamsForTests(): void {
  injectedEvidenceStore = undefined;
  injectedAuthorityChannel = undefined;
  injectedFeedbackSink = undefined;
}
