/**
 * WS7 — the shared RealtimeTransport conformance suite run against BOTH in-core
 * transports: PollTransport (the default, store-backed) and NoopRealtimeTransport
 * (the CI/store-less transport). Skybber imports the SAME helper and runs it
 * against AppSyncEventsTransport — that is the cross-repo behavior contract.
 *
 * Independence from WS5: the store seam here is the WS1 in-core
 * InMemorySettingStore (ciphertext-only, optimistic concurrency). We do NOT
 * import WS5's PrismaEncryptedSettingsStore — the conformance suite must stay
 * runnable with zero infra.
 *
 * Thin-test audit (2026-09): this file itself has 0 `expect()` calls — that
 * is intentional. It only wires two harnesses into the shared
 * `runRealtimeTransportConformance()` suite (`test/_helpers/realtime-conformance.ts`),
 * which defines ~11 real `it()`s per transport with substantial assertions
 * (fence-runs-once, policy-denied dropping, error containment, store
 * round-tripping). Confirmed by reading that helper directly.
 */

import { describe } from "vitest";
import {
  CalmDeliveryResolver,
  InMemorySettingStore,
  NoopRealtimeTransport,
  PollTransport,
} from "../../../src/lib/realtime/index.js";
import {
  runRealtimeTransportConformance,
  type RealtimeConformanceHarness,
} from "../../_helpers/realtime-conformance.js";

function makePollHarness(): RealtimeConformanceHarness {
  const store = new InMemorySettingStore();
  const policy = new CalmDeliveryResolver();
  const transport = new PollTransport(store, policy);
  return { transport, policy, store };
}

function makeNoopHarness(): RealtimeConformanceHarness {
  const policy = new CalmDeliveryResolver();
  const transport = new NoopRealtimeTransport(policy);
  // Noop has no store; the suite probes inertness. We still hand back a store
  // instance to satisfy the harness shape — it is unused by the noop transport.
  const store = new InMemorySettingStore();
  return { transport, policy, store };
}

describe("PollTransport", () => {
  runRealtimeTransportConformance(makePollHarness);
});

describe("NoopRealtimeTransport", () => {
  runRealtimeTransportConformance(makeNoopHarness);
});
