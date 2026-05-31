# T7 — Audit Log

**Recommended model:** Sonnet 4.6
**Effort:** ~3 days
**Depends on:** T1, T3, T6 (capability catalog defines the audit-event types implicitly)
**Blocks:** T9b (compliance.json references audit retention), S6 (compliance.json content)
**Branch:** `feat/T7-audit-log`

## Goal

Structured audit-log emission for every administrative action on identity/tenancy. Both CloudWatch Logs (machine-queryable) and Postgres `security_events` extension. Tenant-admin-visible read endpoint.

## Design reference

[`doc/02-technical/identity-federation/07-security-and-isolation.md §audit-log`](../../doc/02-technical/identity-federation/07-security-and-isolation.md#audit-log)

## Scope

### In scope

1. **`AuditEventEmitter`** at `apps/api/src/lib/audit/emit.ts`:
   - `emit({ tenantId, type, actorUserId, payload })` writes to CloudWatch + Postgres.
   - Idempotent on `(eventId)` (UUID generated server-side).
   - PII filter: claim *names* OK, claim *values* never. Validated by allowlist.
2. **Event-type catalog** at `apps/api/src/lib/audit/event-types.ts` — exact enum of permitted types per design doc.
3. **Wire into all admin handlers** from T3–T6 (tenant create/update, member changes, domain add/verify, IdP CRUD, role-mapping CRUD).
4. **CloudWatch log group:** `/{appName}/{stage}/audit-events` with 30-day retention (provisioned by the consuming deployment's CDK).
5. **Postgres `security_events` extension:** add `tenantId` column (already exists per existing schema; verify); add new event `type` strings.
6. **Read endpoint:** `GET /api/tenants/{id}/audit?from=&to=&type=&format=json|csv` — paginated, filterable, exportable.
7. **CSV export** with proper header row, RFC 4180 escaping.
8. **Agent-session tagging:** every event from an agent-authenticated session includes `agentSessionId`.

### Out of scope

- Tenant-deletion event (Phase 3).
- SIEM/Splunk export (Phase 3).

## Acceptance criteria

- [ ] Every event listed in `event-types.ts` is emitted by at least one handler.
- [ ] Emit is non-blocking (handler returns even if CloudWatch is slow; events queue or log to local fallback).
- [ ] PII filter rejects payloads containing claim values, email body content, etc. (test fixture verifies).
- [ ] Tenant admin read endpoint: paginated, filtered, returns only the caller's tenant's events.
- [ ] CSV export works on > 10k events.
- [ ] Cross-tenant isolation: tenant-B cannot see tenant-A's audit log.

## Test requirements

### Coverage floor

- **Emit + PII filter:** 95% lines.
- **Read endpoint:** 85% lines.

### Required tests

1. Per-event-type emission test (every type in catalog has at least one trigger test).
2. PII-filter unit tests (positive + negative).
3. Idempotency: same event UUID submitted twice → single record.
4. Read endpoint: pagination, filter combinations, CSV format validation.
5. Cross-tenant isolation.
6. CloudWatch outage simulation: emit doesn't fail the handler, fallback log written.

## Files to add/modify

| File | Action |
|---|---|
| `apps/api/src/lib/audit/emit.ts` | new |
| `apps/api/src/lib/audit/event-types.ts` | new |
| `apps/api/src/lib/audit/pii-filter.ts` | new |
| `apps/api/src/lib/routes/tenant-audit.ts` | new |
| `apps/api/src/lib/audit/csv-export.ts` | new |
| CloudWatch log-group definition | new — owned by the consuming deployment's CDK (coordinated with its infra stage) |
| All T3–T6 handlers | modify (replace placeholder emitter) |
| `apps/api/test/lib/audit-emit.test.ts` | new |
| `apps/api/test/lib/pii-filter.test.ts` | new |
| `apps/api/test/routes/tenant-audit.test.ts` | new |

## Security considerations

- [ ] PII allowlist for payload fields (test that disallowed fields are rejected).
- [ ] `actorUserId` never `null` for admin actions (forensic trail).
- [ ] Source IP captured but anonymized to /24 in long-term storage (GDPR consideration).
- [ ] Tenant admins see only their tenant; SUPER_ADMIN sees all.
- [ ] Agent-authenticated requests include `agentSessionId` in every emitted event.

## Definition of done

All acceptance criteria checked. PR reviewed, merged to integration branch.
