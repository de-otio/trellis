---
title: Security architecture
description: Trellis's security posture — defense in depth, least privilege, encryption everywhere, and validated input.
sidebar: Security architecture
order: 10
---

# Security architecture

Trellis is built to run in a hostile, multi-tenant environment. Its security
posture is layered: network isolation, least-privilege access, secrets kept out
of application data, validated input at every boundary, encryption in transit
and at rest, and an audit trail of security-relevant events. No single control
is load-bearing on its own.

## Defense in depth

Security controls are arranged so that the failure of one layer does not expose
the system. Requests pass through edge protection, a stateless application tier
that owns authentication and authorization, and a data tier that the public
internet cannot reach directly. Background workers run with their own narrowly
scoped permissions rather than sharing the API's access.

## Least privilege

Each component runs with the smallest set of permissions it needs. The
application's execution identity is separated from its runtime identity, and
background workers receive only the specific access their job requires — a media
worker can touch media storage and its own queue, and nothing else. Components
that do not need database access do not get it. This containment limits the blast
radius if any one component is compromised.

## Authentication and authorization

- **User requests** are authenticated with signed JSON Web Tokens, validated by
  application middleware on every request — signature, issuer, audience, and
  expiry are all checked.
- **Server-to-server federation** (when enabled) is authenticated with HTTP
  Signatures. See [ActivityPub federation](../concepts/activitypub.md).
- **Authorization** is role-based: tokens carry a role claim, and handlers check
  the caller's role before acting. Administrative operations require elevated
  roles.

A failed authorization check returns a generic refusal that does not reveal
*why* it failed, so an attacker cannot distinguish "wrong tenant" from
"insufficient role."

## Input validation

Every request body is validated against a schema at the handler boundary before
any business logic runs. Path and query parameters are validated in the handler.
Payload sizes are bounded. Validation happens at the edge of the system, not deep
inside it, so malformed input is rejected early.

## Rate limiting

Application traffic is rate-limited per user and per source using shared,
distributed infrastructure so the limits hold across all running instances of
the service rather than per process. Edge protection absorbs volumetric traffic
before it reaches the application.

## Secrets management

Secrets are never stored alongside application data. They live in a managed
secret store, encrypted at rest, and are injected into the runtime rather than
baked into deployment artifacts. Database credentials support rotation. Secrets
are never logged and never included in telemetry or error-reporting payloads.

## Data protection

**Encryption at rest.** All persistent stores — the relational database, object
storage, the key/value store, and the secret store — are encrypted at rest with
AES-256.

**Encryption in transit.** All connections use TLS, with a modern minimum
version enforced. Public endpoints are served over TLS with managed
certificates; internal connections between services are likewise encrypted.

## Security headers

Responses carry a standard set of hardening headers — HTTP Strict Transport
Security, content-type and frame protections, a restrictive referrer policy, and
a permissions policy — applied at the edge so they are consistent across the
whole surface.

## Audit logging

Security-relevant events are recorded to a tamper-resistant audit trail.
Each event carries a severity, and retention is tied to severity so that
higher-severity events are kept longer. Audit records are pruned automatically
once their retention window passes. Infrastructure-level logs provide a
complementary, lower-level trail.

For how this maps to regulatory obligations, see [Compliance](compliance.md).
For how the same principles isolate tenants from one another, see
[Tenant isolation](tenant-isolation.md).
