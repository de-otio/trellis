# FROZEN CONTRACT — Push device registration + wakeup dispatch (T8)

Status: **frozen** for the skybber infra lane (Lambda/SNS-or-FCM transport) and
the Flutter lane (firebase_messaging + APNs). Changes after those lanes start
are breaking and require a coordinated re-fan-out.

Scope: trellis ships the device-registration API, the `PushDevice` storage, the
`PushTransport` injection seam, and the `PushDispatcher` that consumes the
existing content-free `WakeupEnvelope`. The concrete APNs/FCM/SNS delivery is
**not** in trellis — the consuming app injects it (same model as
`setRealtimeProvider` / `setMediaModerationProvider`).

## 0. Invariants (non-negotiable)

1. **Content-free payload.** The bytes handed to `PushTransport.send()` are
   produced ONLY by `buildNotificationWakeup()` (`realtime/push-notifier.ts`),
   i.e. the frozen WS1 `WakeupEnvelope` `{ "v": 1, "kind": "wakeup" | "safety" }`.
   No title, no body, no data, no IDs. A transport implementation MUST relay
   this as a data-only / background push (FCM `data` message, APNs
   `content-available: 1`) and MUST NOT synthesize alert content from it.
   The client reacts to a wakeup by refetching over the authenticated API.
2. **Server-resolved identity.** Registration and dispatch key off the
   session's `userId` — never a client-asserted user id. A device row is bound
   to the account that presented the session.
3. **Default OFF.** The whole dispatch path is gated by
   `features.realtimePush` (`REALTIME_PUSH_ENABLED === "true"`, default false)
   AND by a transport being injected. Un-wired or un-flagged deploys never
   attempt a push. Registration endpoints work regardless of the flag (a
   client may register early; dispatch simply doesn't happen).
4. **Best-effort dispatch.** Dispatch never throws into the caller and never
   rolls back the persisted `Notification` row. Polling remains the floor.
5. **Tokens encrypted at rest.** The raw platform token is stored AES-GCM
   encrypted (the existing `MfaEnrollment.encryptedSecret` pattern, keyed off
   `SESSION_SECRET`); a deterministic SHA-256 hash (`tokenHash`) is the
   dedupe/lookup key. The raw token never appears in a response body or log.

## 1. Storage — `PushDevice`

```prisma
enum PushPlatform { APNS FCM WEB }

model PushDevice {
  id              String       @id @default(cuid())
  userId          String       @map("user_id")
  platform        PushPlatform
  tokenHash       String       @unique @map("token_hash")        // SHA-256 hex of the raw token
  tokenCiphertext String       @map("token_ciphertext") @db.Text // AES-GCM, SESSION_SECRET-keyed
  createdAt       DateTime     @default(now()) @map("created_at")
  lastSeenAt      DateTime     @default(now()) @map("last_seen_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])   // dispatcher lookup path
  @@map("push_devices")
}
```

**`tokenHash` is globally unique, not per-user.** One platform token
identifies one physical device, and a physical device belongs to exactly one
account at a time. Re-registering a token that another account currently holds
**reassigns** the row to the registering account (last registration wins —
the account-switch / handed-over-device case). This is deliberate: it prevents
a stale account from continuing to receive wakeups for a device it no longer
controls.

**Per-user device cap:** at most **20** devices per user
(`MAX_PUSH_DEVICES_PER_USER`). Registering a 21st evicts the stalest row by
`lastSeenAt`. Bounds both storage abuse and dispatch fan-out.

## 2. Endpoints

All endpoints: authenticated session cookie required (401 otherwise),
middleware CORS + CSRF + rate limit, standard security headers.

### 2.1 `POST /api/devices/register`

Registers (or refreshes) the calling user's device token. Idempotent upsert
keyed on `tokenHash`.

Rate limit: **10/min** per user.

Request body (Zod-validated):

```jsonc
{
  "token": "…",          // string, 1..4096 chars — the raw APNs/FCM/WebPush token
  "platform": "apns"     // "apns" | "fcm" | "web"
}
```

Responses:

- **201** — registered (created, refreshed, or reassigned; the response does
  NOT distinguish and NEVER echoes the token):

```jsonc
{
  "device": {
    "id": "c…",                              // PushDevice.id (cuid)
    "platform": "apns",
    "createdAt": "2026-07-05T12:00:00.000Z",  // ISO-8601
    "lastSeenAt": "2026-07-05T12:00:00.000Z"
  }
}
```

- **400** — validation failure (`validate-request.ts` shape):
  `{ "error": "Validation failed", "details": [{ "path", "message" }] }`
  (or `{ "error": "Invalid JSON" }`).
- **401** — `{ "error": "Unauthorized" }`.
- **429** — standard limiter shape (`Retry-After` header + JSON body).
- **500** — `{ "error": "<sanitized>" }`.

### 2.2 `DELETE /api/devices/:id`

Deletes one of the calling user's devices (logout / push-opt-out path).
Owner-scoped: the row must belong to the session user.

Rate limit: **30/min** per user.

Responses:

- **200** — `{ "success": true }`.
- **404** — `{ "error": "Device not found" }`. Returned both when the id does
  not exist AND when it belongs to another user (no existence oracle; there is
  deliberately no 403).
- **401 / 429 / 500** — as above.

## 3. The `PushTransport` seam (what the infra lane implements)

Exported from `@de-otio/trellis` (built path `lib/push/index.js`):

```ts
export type PushPlatformWire = "apns" | "fcm" | "web";

export interface PushDeviceTarget {
  deviceId: string;        // PushDevice.id — echo back for invalidation bookkeeping
  platform: PushPlatformWire;
  token: string;           // decrypted raw platform token
}

export type PushSendOutcome =
  | { ok: true }
  | { ok: false; reason: "unregistered" | "transient" | "config" };

export interface PushTransport {
  readonly kind: string;   // e.g. "sns-platform", "fcm-v1" — label only
  /**
   * Deliver ONE content-free wakeup payload to ONE device. MUST NOT throw for
   * per-device delivery failures — map them to an outcome. `payload` is the
   * encoded WakeupEnvelope bytes; the transport is a blind relay (data-only /
   * content-available push, never an alert built from the payload).
   */
  send(device: PushDeviceTarget, payload: Uint8Array): Promise<PushSendOutcome>;
}

export function setPushTransportProvider(t: PushTransport): void;
export function resolvePushTransport(): PushTransport | undefined;
```

Outcome semantics:

- `ok: true` — accepted by the platform (or durably enqueued by an async
  transport; see below).
- `"unregistered"` — the platform says the token is dead/invalid
  (APNs `410 Unregistered` / `BadDeviceToken`; FCM `UNREGISTERED` /
  `INVALID_ARGUMENT` on the token). **The dispatcher deletes the
  `PushDevice` row** — this is the token-invalidation cleanup.
- `"transient"` — retryable platform/network hiccup. The dispatcher skips
  (no retry loop in-process; the next notification is the retry). Row kept.
- `"config"` — the transport is not usable (missing platform credentials).
  Row kept; logged.

**Async transports (queue-based):** an implementation that only enqueues
(e.g. SQS → dispatch Lambda) returns `ok: true` on enqueue and cannot report
`"unregistered"` synchronously. In that model the infra lane owns feedback:
its Lambda observes the platform response and deletes the dead row itself
(direct DB or a future internal endpoint — infra-lane decision, out of scope
here). The synchronous outcome contract above is what trellis acts on.

Secrets: APNs key / FCM service account are **human handoffs**, referenced by
SSM path `/skybber/{stage}/push/*` in the infra lane. Trellis never sees them.

## 4. Dispatch flow (what trellis ships)

`PushDispatcher` (`lib/push/push-dispatcher.ts`), invoked from
`NotificationHandler.createNotification()` inside the existing
`env.features.realtimePush && decision.deliver` gate — the SAME decision that
sets `deliveredAt`, so push can never diverge from polling, and the calm/floor
policy fence has already run:

```
createNotification()
  └─ decision.deliver && features.realtimePush
       ├─ PushNotifier.notify()            (existing realtime-transport wakeup)
       └─ resolvePushTransport()
            └─ (if injected) PushDispatcher.dispatch({ userId, kind })
                 1. payload = buildNotificationWakeup(kind)   // frozen envelope
                 2. devices = PushDevice where userId (≤ cap, bounded loop)
                 3. token   = AES-GCM decrypt(tokenCiphertext)
                 4. transport.send({deviceId, platform, token}, payload)
                 5. outcome "unregistered" → delete PushDevice row
                 6. never throws; per-device errors → treated as "transient"
```

`kind` is `"safety"` for ALWAYS_DELIVER types, else `"wakeup"` — identical to
the `PushNotifier` routing. `dispatch()` resolves to
`{ attempted, delivered, invalidated }` for observability; callers ignore it
functionally.

## 5. What each lane consumes

- **Infra lane (skybber CDK):** implements `PushTransport`, calls
  `setPushTransportProvider()` in the API shim at startup (before
  `startServer()`), provisions SNS platform apps / FCM creds behind
  `/skybber/{stage}/push/*`, and owns async invalidation feedback if it
  chooses a queue-based transport.
- **Flutter lane:** obtains the FCM/APNs token, calls
  `POST /api/devices/register` after login and on token rotation
  (`onTokenRefresh`), calls `DELETE /api/devices/:id` on logout, and treats
  every received push as a content-free wakeup → refetch. The `device.id`
  from the register response is what the client stores for the later DELETE.
- **Error handling contract for the client:** 401 → re-auth then re-register;
  429 → back off (honor `Retry-After`); 5xx → retry with backoff. Register is
  idempotent — replaying it is always safe.
