/**
 * moderation-metrics.ts — what operators may see about moderation, and what
 * nobody unauthenticated may see.
 *
 * Moderation counters are genuinely needed: a provider that has quietly started
 * reviewing everything, or a taxonomy running unpinned for a month, are both
 * invisible without them. But the same counters are an EVASION ORACLE if they
 * are readable and fresh. Upload a probe, poll a public counter, watch which
 * bucket moves: that is a per-upload verdict readout, and with it an adversary
 * tunes content against the classifier without ever seeing a decision.
 *
 * Three controls, and the reasons they are shaped the way they are:
 *
 *  1. **Aggregates only, never per-item.** Counters are keyed by
 *     `{provider, decision}` and carry no media id, tenant, user, or key.
 *  2. **Closed windows only.** {@link ModerationMetrics.snapshot} reports
 *     COMPLETED time buckets and never the one in progress. A probe uploaded
 *     now cannot be read back now, which is what breaks the poll-and-correlate
 *     loop rather than merely slowing it.
 *  3. **Authenticated surface only.** The public health payload carries exactly
 *     one moderation fact — {@link ModerationMetrics.publicHealth} — a boolean
 *     saying a real provider is wired. That is what an uptime check needs and
 *     it reveals nothing about any upload.
 *
 * The provider NAME is treated as untrusted input even though it comes from our
 * own adapter: it becomes a metric dimension, and a hostile or merely sloppy
 * value there means unbounded cardinality in a metrics backend. It must match
 * one the operator declared, and it is length- and charset-checked regardless.
 */

import type { ModerationDecision } from "./media-lifecycle.js";

/** Bound on a provider name used as a metric dimension. */
const PROVIDER_NAME_MAX = 64;

/** Dimension values are conservative ASCII: no spaces, no control characters. */
const PROVIDER_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]*$/i;

/** The placeholder recorded when a provider name is not acceptable. */
export const UNKNOWN_PROVIDER_DIMENSION = "unknown";

/**
 * Is this string safe and expected as a metric dimension?
 *
 * Both halves matter: the charset/length check bounds cardinality damage, and
 * the declared-set check means a provider cannot introduce a new dimension
 * value at runtime just by renaming itself.
 */
export function isAcceptableProviderDimension(
  name: unknown,
  declaredProviders: ReadonlyArray<string>,
): name is string {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > PROVIDER_NAME_MAX) return false;
  if (!PROVIDER_NAME_PATTERN.test(name)) return false;
  return declaredProviders.includes(name);
}

export interface ModerationMetricsConfig {
  /**
   * The provider names the operator declared. Anything else is recorded under
   * {@link UNKNOWN_PROVIDER_DIMENSION} rather than becoming a new dimension.
   */
  readonly declaredProviders: ReadonlyArray<string>;
  /**
   * Bucket width in milliseconds. Coarser means a smaller correlation window;
   * operator-supplied because how coarse is enough depends on upload volume.
   */
  readonly windowMs: number;
  /** Injected clock — no ambient `Date.now`, so tests can freeze it. */
  readonly now: () => number;
  /** Standing posture flag from the label policy: is the taxonomy unpinned? */
  readonly unpinnedTaxonomy?: boolean;
  /** Whether a real (non-fail-closed) provider is wired. */
  readonly providerActive?: boolean;
}

export class ModerationMetricsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModerationMetricsConfigError";
  }
}

/** One closed window's counters. */
export interface ModerationWindow {
  /** Start of the bucket, in epoch milliseconds. */
  readonly windowStart: number;
  /** `${provider}:${decision}` → count. */
  readonly decisions: Readonly<Record<string, number>>;
  /** `${provider}` → count of infrastructure faults that failed a track closed. */
  readonly infraFaults: Readonly<Record<string, number>>;
}

export interface ModerationMetricsSnapshot {
  /** COMPLETED windows only — never the one currently accumulating. */
  readonly windows: ReadonlyArray<ModerationWindow>;
  /**
   * True while the label policy runs without a taxonomy pin. A standing
   * condition, surfaced continuously rather than as a boot-time log line
   * nobody re-reads.
   */
  readonly unpinnedTaxonomy: boolean;
}

/** Everything the UNAUTHENTICATED health payload may say about moderation. */
export interface ModerationPublicHealth {
  readonly moderationProviderActive: boolean;
}

/** How many closed windows to retain. Bounded so this cannot grow without end. */
const RETAINED_WINDOWS = 12;

export class ModerationMetrics {
  private readonly config: ModerationMetricsConfig;
  private readonly buckets = new Map<
    number,
    { decisions: Map<string, number>; infraFaults: Map<string, number> }
  >();

  constructor(config: ModerationMetricsConfig) {
    if (
      config === null ||
      typeof config !== "object" ||
      typeof config.now !== "function" ||
      !Array.isArray(config.declaredProviders) ||
      typeof config.windowMs !== "number" ||
      !Number.isFinite(config.windowMs) ||
      config.windowMs <= 0
    ) {
      throw new ModerationMetricsConfigError(
        "moderation metrics require a declared provider list, a positive window, and a clock",
      );
    }
    this.config = config;
  }

  /** Record one classifier decision. Never throws; observability is not a gate. */
  recordDecision(provider: unknown, decision: ModerationDecision): void {
    const dimension = this.dimensionFor(provider);
    this.bucket().decisions.set(
      `${dimension}:${decision}`,
      (this.bucket().decisions.get(`${dimension}:${decision}`) ?? 0) + 1,
    );
  }

  /**
   * Record an infrastructure fault that failed a track closed.
   *
   * This counter exists because fail-closed is otherwise INDISTINGUISHABLE from
   * healthy caution: a provider that is down and a provider that is being
   * careful both produce review items. Without this, an outage looks like a
   * busy week.
   */
  recordInfraFault(provider: unknown): void {
    const dimension = this.dimensionFor(provider);
    this.bucket().infraFaults.set(
      dimension,
      (this.bucket().infraFaults.get(dimension) ?? 0) + 1,
    );
  }

  /**
   * Closed windows, newest last. The in-progress window is deliberately
   * withheld — that omission is the anti-oracle control, not a rounding detail.
   */
  snapshot(): ModerationMetricsSnapshot {
    const current = this.currentWindowStart();
    const windows: ModerationWindow[] = [];
    for (const [windowStart, bucket] of [...this.buckets.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      if (windowStart >= current) continue;
      windows.push({
        windowStart,
        decisions: Object.fromEntries(bucket.decisions),
        infraFaults: Object.fromEntries(bucket.infraFaults),
      });
    }
    return {
      windows,
      unpinnedTaxonomy: this.config.unpinnedTaxonomy === true,
    };
  }

  /** The only moderation fact the public health endpoint may carry. */
  publicHealth(): ModerationPublicHealth {
    return { moderationProviderActive: this.config.providerActive === true };
  }

  private dimensionFor(provider: unknown): string {
    return isAcceptableProviderDimension(provider, this.config.declaredProviders)
      ? provider
      : UNKNOWN_PROVIDER_DIMENSION;
  }

  private currentWindowStart(): number {
    const now = this.config.now();
    const width = this.config.windowMs;
    return Math.floor(now / width) * width;
  }

  private bucket(): {
    decisions: Map<string, number>;
    infraFaults: Map<string, number>;
  } {
    const start = this.currentWindowStart();
    let bucket = this.buckets.get(start);
    if (bucket === undefined) {
      bucket = { decisions: new Map(), infraFaults: new Map() };
      this.buckets.set(start, bucket);
      this.evictOldWindows();
    }
    return bucket;
  }

  private evictOldWindows(): void {
    while (this.buckets.size > RETAINED_WINDOWS) {
      let oldest = Number.POSITIVE_INFINITY;
      for (const key of this.buckets.keys()) if (key < oldest) oldest = key;
      this.buckets.delete(oldest);
    }
  }
}
