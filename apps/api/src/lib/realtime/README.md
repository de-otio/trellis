# `realtime/` — the RealtimeTransport seam (WS1)

Core ships an **interface plus a poll default**. It does **not** bake AppSync (or
any AWS realtime SDK) into the platform. A consuming app (Skybber) injects a
concrete transport at startup; core never imports `@aws-sdk/*`, `aws-appsync`,
or `aws-amplify`.

> This is the **frozen WS1 contract**. The types in `types.ts` and the
> signatures here are stable; any change after WS1 merges is a breaking change
> requiring a coordinated version bump and re-fan-out. See
> `plans/appsync-skybber/00b-integration-and-frozen-contract.md` §2–§4.

## What's here

| File | Role |
|---|---|
| `types.ts` | The frozen type set: `Channel`/`ChannelKind`/`ScopeType`, `VerifiedIdentity`, `DeliveryTarget`/`DeliveryResult`/`DeliveryContext`/`DeliveryDecision`/`QuietHoursConfig`, `WakeupEnvelope` + `encodeWakeup`/`decodeWakeup`, `EncryptedBlob`/`PutResult`/`SettingStore`, `RealtimeTransport`, `DeliveryPolicyResolver`. **Single source of truth.** |
| `realtime-transport.ts` | Re-exports the `RealtimeTransport` interface under its own name, with the implementor contract banner. |
| `channel.ts` | `channelName` / `parseChannel` (canonical `/{kind}/{tenantId}/{scopeType}/{scopeId}`), `channelFor`, and `authorizeSubscription` — **the security boundary**. |
| `delivery-policy.ts` | `DeliveryPolicyResolver` port + `CalmDeliveryResolver` (the migrated notification floor). |
| `setting-store.ts` | `SettingStore` port + `InMemorySettingStore` default. |
| `poll-transport.ts` | `PollTransport` — default, zero infra. |
| `no-op-transport.ts` | `NoopRealtimeTransport` — for CI. |
| `index.ts` | Public barrel + `setRealtimeProvider` / `resolveRealtimeTransport`. |

## The hard rules (tested invariants)

1. **No AWS in core.** No file under `realtime/` may import `@aws-sdk/*`,
   `aws-appsync`, `aws-amplify`, or a socket library. Enforced by
   `test/unit/realtime/no-aws-import.test.ts`, which fails loudly if violated.
2. **Authorization is server-verified, never ambient.**
   `authorizeSubscription(id, channel)` checks the channel (a client assertion)
   against a `VerifiedIdentity` derived from Cognito claims. A subscription
   filter is not a boundary. Cross-tenant and cross-user are denied.
3. **The policy fence runs inside every `deliver()`.** Poll, Noop, and Skybber's
   AppSync transport all call the resolver and honor a `{ deliver: false }`. The
   floor (`SAFETY_ALERT`/`PARENTAL_LINK` always; quiet hours; future
   blocked-sender / minor-protection) cannot be skipped at the call site.
4. **Content-free is structural.** Wakeup/setting_sync payloads are built ONLY
   via `encodeWakeup()`. There is no free-form field.
5. **Best-effort delivery.** `deliver()` never rolls back a persisted write; it
   resolves with a `DeliveryResult` and transports catch their own errors.

## How a consuming app injects AppSync

```ts
import { setRealtimeProvider } from "@de-otio/trellis/realtime";
setRealtimeProvider(new AppSyncEventsTransport({ /* eu-central-1 config */ }));
```

`buildEnv` calls `resolveRealtimeTransport(defaultTransport)` and stores the
result on `env.realtimeTransport`. With no provider injected and no env set,
core polls — fully functional, zero infra.

`InMemorySettingStore` is **not** production-grade (no persistence across
tasks); WS5's `PrismaEncryptedSettingsStore` is the prod binding.
