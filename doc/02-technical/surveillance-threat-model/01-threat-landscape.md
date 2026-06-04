# Threat Landscape

Commercial "intelligence platforms" sold to police, intelligence agencies, and —
through the same sales channels — authoritarian regimes extract from social
platforms through four channels. Vendors named below appear in public reporting
(ISS World Europe 2026 coverage; Meta's 2021 enforcement action); see the
[README](./README.md#sources) for sources.

## 1. Scraping / OSINT harvesting

AI fusion platforms (JSI 4Sight, Penlink PLX/CoAnalyst, Cognyte) offer
prompt-based search across heterogeneous data: social-media scrapes, open-web
OSINT, mobile-network metadata (IMSI/IMEI), audio transcripts. One prompt
queries everything; the platform returns a synthesized summary, link analysis,
and behavioral/movement patterns.

Public profile and social-graph data is the **free feedstock** that gets fused
with the rest. The social graph of a dissident — who they follow, who follows
them — combined with mobile-network metadata is exactly the product these
platforms sell.

Implication for trellis: anything publicly enumerable (profiles, follower
lists, feeds) should be assumed to be continuously harvested. See
[05-activitypub-exposure.md](./05-activitypub-exposure.md).

## 2. ADINT — purchased ad/tracker data

Behavioral and tracking data bought from ad networks and data brokers is now a
standard product category in these platforms' catalogs ("Advertising
Intelligence"). Any third-party tracker embedded in a platform leaks into this
supply chain — no hack, no subpoena, just a purchase order.

Documented case: Austria's interior ministry bought a Penlink fusion platform
that combines IMSI/IMEI mobile metadata with tracking and behavioral data
purchased from international ad networks and data brokers (parliamentary
inquiry, December 2025).

Implication for trellis: the absence of third-party trackers in the core is a
security property, not just a privacy nicety. See
[02-current-posture.md](./02-current-posture.md).

## 3. Avatar infiltration — AI-agent-driven fake accounts

Covert accounts operated by AI agents, sold as modules on the same platforms:

- The Penlink/Cobwebs product: one administrator steers **ten avatars** used
  for covert investigation inside social networks. (Austria's ten licenses =
  ten avatars.)
- Blackscore (Singapore, deployed in 30+ countries): fully agentic
  investigation — AI agents run the entire operation, "operational 24 hours
  after deployment."

These are used for social engineering, public manipulation around large
events, and suppression of dissidents.

**The Cobwebs precedent (2021):** Meta banned Cobwebs as a "rogue firm" —
200 avatar accounts deleted, operated by Cobwebs and its customers in
Bangladesh, Saudi Arabia, Hong Kong, Mexico, Poland, and others. Meta
estimated **~48,000 user accounts compromised** via avatar social
engineering.

Implication for trellis: avatar clusters are a *graph* signature, and the
platform needs both detection
([03-coordinated-inauthentic-behavior.md](./03-coordinated-inauthentic-behavior.md))
and a victim-side reporting path
([04-account-reporting.md](./04-account-reporting.md)). AI agents also make
account farming approximately free, which changes the economics of
registration friction ([06-registration-friction.md](./06-registration-friction.md)).

## 4. Legal compulsion

Whatever the platform stores can be compelled by the jurisdiction it is stored
in — and then lands in that jurisdiction's "lawful" fusion platforms. This
channel is shaped by two design decisions:

- **What is stored at all** — data not collected cannot be compelled. See
  [07-data-minimization.md](./07-data-minimization.md).
- **Where it is stored** — tenant-level data residency determines which
  states can compel it. Already on the long-term roadmap (data localisation
  for future regional expansion); this threat model is a second, independent
  justification.

## Why this matters for a platform *core*

Trellis itself doesn't choose its users — verticals do. A vertical built on
trellis may serve communities that are targets of exactly these tools
(diaspora communities, journalists, activists, or simply users in markets
where these platforms are deployed). The core cannot retrofit these
protections per-vertical; they have to be platform properties.

## The project itself is a target

These channels describe extraction from *deployments*. A separate
assumption applies to the project: threat-actor orgs monitor public
projects, and a platform core that openly ships countermeasures against
their products gets flagged as an adversary — making the repo, the npm
supply chain, and the maintainers themselves attack surface. See
[09-public-project-exposure.md](./09-public-project-exposure.md).
