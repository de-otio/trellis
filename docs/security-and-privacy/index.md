---
title: Security & privacy
description: Trellis's security posture and privacy guarantees.
sidebar: Security & privacy
order: 5
---

# Security & privacy

Trellis is a multi-tenant social-network platform core. The verticals built on
it may serve communities that are targets of organized data extraction —
diaspora communities, journalists, activists, or simply users in markets where
commercial surveillance products are deployed. A platform core cannot retrofit
protection for those communities one vertical at a time, so privacy-protective
behaviour is built in as a property of the core itself.

This page describes the posture Trellis ships today: the kinds of threats it is
designed against, the guarantees it currently provides, its data-minimization
and data-residency stance, and the open security philosophy behind it.

## The threat landscape Trellis is designed against

Social platforms are a feedstock for data extraction. Trellis treats the
following extraction channels as part of its baseline threat model — at a
conceptual level, independent of any single deployment:

- **Scraping and OSINT harvesting.** Anything publicly enumerable — profiles,
  follower lists, feeds — should be assumed to be continuously harvested and
  fused with other data sources. Public profile and social-graph data is the
  cheapest feedstock for data-fusion platforms, so the core treats public
  enumeration surface as something to minimize, not expand.

- **Purchased ad and tracker data.** Behavioural data bought from ad networks
  and data brokers is a standard product category for surveillance vendors. Any
  third-party tracker embedded in a platform leaks into that supply chain
  through an ordinary purchase order — no breach required. The absence of
  third-party trackers in the server-side core is therefore a *security*
  property, not just a privacy nicety.

- **Inauthentic-account infiltration.** Networks of fake accounts — increasingly
  agent-operated — are used for social engineering and manipulation inside
  social networks. The core's job is to give verticals the structure (moderation,
  reporting, conservative defaults) needed to keep such activity costly rather
  than free.

- **Legal compulsion.** Whatever a platform stores can be compelled by the
  jurisdiction it is stored in. Two design decisions shape this channel: *what
  is stored at all* (data not collected cannot be compelled) and *where it is
  stored* (storage jurisdiction determines which states can compel it). Both are
  addressed below.

These channels describe extraction from *deployments*. Trellis cannot choose how
a vertical's users will be targeted, so it makes the relevant protections
platform properties rather than per-vertical add-ons.

## Guarantees Trellis ships today

### A tracker-free server-side core

The Trellis API core embeds no analytics SDKs and no ad-network trackers.
External calls are limited to opt-in, feature-gated services (for example,
content moderation and optional IP geolocation). There is simply no tracker data
stream from the core to be purchased through the ad-data supply chain.

This is an enforced commitment, not an incidental fact. Extensions built by
verticals **must not** introduce third-party trackers, analytics SDKs, or
ad-network integrations into server-side request handling — this is an
extension-review criterion, so a vertical cannot silently break a property
that at-risk users may be relying on. Client-side analytics in a vertical's own
frontend are the vertical's responsibility; the Trellis API surface stays
tracker-free.

### IP anonymization and bounded retention

Client metadata (IP address, User-Agent, device identifiers) is stored **only**
through a path that enforces either anonymization or an explicit retention
bound. The two sanctioned paths are:

- **The audit log**, where events pass through a PII allowlist and IP
  anonymization before they are persisted, under a tiered, bounded retention
  schedule.
- **Security forensics events**, which carry raw client signals deliberately but
  always under an explicit retention bound that is enforced by a recurring
  cleanup job.

Storing raw client metadata ad hoc alongside domain data — where it would
accumulate indefinitely and silently — is a review blocker. This extends the
data-minimization stance already present in the identity-federation design,
where only the identity claims actually used are stored, and claim names are
logged rather than claim values.

### Conservative privacy defaults

Profile visibility and direct-message access default conservatively, and those
defaults tighten further for protected age tiers, where they can be locked
against loosening. Abuse-control identification prefers stable account
identifiers over network-level signals, so rate limiting and similar controls
do not make a user's IP address the primary key. The intent throughout is that
the safe choice is the default, and the user does not have to discover a setting
to be protected.

### Data minimization and data residency

Two levers govern the legal-compulsion channel:

- **Minimization** — the less that is stored, the less that can be compelled or
  breached. The data-minimization stance above applies across the platform, from
  the identity layer outward.
- **Residency** — Trellis models tenants with a region, so storage jurisdiction
  can be chosen per tenant. Data residency is not only a regulatory feature
  (such as GDPR cross-border rules) but a *protective control for users*: a
  tenant serving an at-risk community can choose a storage jurisdiction whose
  compulsion regime its users can live with.

## Security philosophy: open by design

Trellis follows **Kerckhoffs's principle**: a system's security must not depend
on the secrecy of its design. Every protection in Trellis is meant to survive an
adversary reading its implementation.

Concretely, this means the protection comes from structure and economics rather
than from obscurity. The *kinds* of signals and controls a platform applies can
be public; what raises the cost for an adversary is sound design, conservative
defaults, corroboration of independent signals, and account economics — not the
hope that the code stays unread. Trellis is distributed as public npm packages,
so this is not an aspiration but an operating reality: the design can be open,
and the security does not depend on it being closed.

A direct consequence: any operational security parameter that a deployment
might tune — thresholds, sampling rates, retention windows beyond the defaults —
belongs in runtime configuration for that deployment, never as a value baked
into the published core. The published artifact describes *what* is defended,
not the settings of any particular deployment.

## In this section

- [Security architecture](security-architecture.md) — defense in depth, least
  privilege, encryption everywhere, and validated input.
- [Tenant isolation](tenant-isolation.md) — how every tenant's data is kept
  separated, from the database schema up to the API boundary.
- [Compliance](compliance.md) — GDPR support, data residency, sub-processor
  transparency, and a machine-readable compliance surface.
- [Media security](media-security.md) — how image and video metadata is
  validated and how location privacy is protected by default.
