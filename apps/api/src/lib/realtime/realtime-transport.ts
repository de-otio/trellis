// CONTRACT: stable — coordinate changes.
//
// The RealtimeTransport capability interface — THE seam every other workstream
// and the Skybber client binds to. The interface body lives in types.ts (single
// source of truth for the frozen type set); this module re-exports it under its
// own name so consumers can import the contract from a file whose name states
// what it is, and so the CONTRACT banner sits with the interface.
//
// Binding rules for every transport implementor (poll, noop, appsync-events):
//   - deliver() is BEST-EFFORT and NEVER rolls back a persisted write. It
//     resolves with a DeliveryResult; it must catch its own transport errors
//     and surface them as { delivered: false, reason: "transport_error" }.
//   - The policy fence (the safety floor) runs INSIDE every deliver(), never at
//     the call site. A transport author MUST call the resolver and honor a
//     { deliver: false } by NOT sending. PollTransport, NoopRealtimeTransport,
//     and Skybber's AppSyncEventsTransport all obey this.
//   - payload is OPAQUE bytes the transport never parses (blind relay). Anything
//     sensitive is client-side ciphertext; content-free wakeups use
//     encodeWakeup().
//   - Implementations MUST NOT durably log connection/delivery metadata as
//     ordinary operational data (CLAUDE.md rule 7; retention is runtime config).

export type {
  RealtimeTransport,
  DeliveryPolicyResolver,
  DeliveryTarget,
  DeliveryResult,
  Channel,
  EncryptedBlob,
  PutResult,
  SettingStore,
} from "./types.js";
