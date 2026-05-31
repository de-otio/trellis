# Threat Model

## Specifics from the NPR article (April 7, 2026)

- **The spyware:** Graphite, by Paragon Solutions (Israeli, acquired late 2024 by AE Industrial Partners / REDLattice).
- **The operator:** ICE's Homeland Security Investigations (HSI), under a $2M Paragon contract revived by the Trump administration in late 2025. Stated pretext: fentanyl trafficking and "foreign terrorist organizations."
- **The delivery vector:** zero-click via encrypted messaging apps. WhatsApp disclosed in early 2025 that ~90 journalists and civil-society targets were hit with Graphite; Citizen Lab attributed specific Italian journalist and humanitarian-worker infections to Graphite delivered via WhatsApp messages.
- **The scope-creep risk:** civil-liberties advocates (EFF, EPIC, Rep. Summer Lee) flag that ICE has not ruled out deploying Graphite against US residents under **administrative subpoena** — i.e. without judicial review — in "ideological battles against constitutionally protected protest." The article explicitly lists immigrants, Black and brown communities, journalists, and organizers as the likely scope-creep targets. A companion NPR piece cited in the article notes the federal government **buys bulk commercial data about Americans without a warrant**, closing the loop between data brokers and surveillance.
- **Compounding factor:** since Graphite is zero-click via messaging, the attack surface is *the messaging app's own parser and renderer* — not a link the user must click. This shifts defensive emphasis away from URL scanning and toward message-rendering hygiene, format restriction, and prompt disclosure of exploit telemetry.

This reframes the threat model in three important ways for trellis:

1. The plausible adversary for platform users is no longer "foreign government vs. foreign dissident." It's **US government vs. US residents, including non-citizens**. The server lives in AWS eu-central-1, which puts it partly outside US jurisdiction for direct legal process, but third-party preservation letters, MLAT, and US-issued subpoenas to AWS EU subsidiaries are still realistic.
2. The **administrative-subpoena path** is load-bearing. Anything the server holds in plaintext is obtainable without judicial warrant. That elevates metadata minimization and application-layer encryption far above "nice to have."
3. **If a product on trellis ships DMs with rich rendering** (link previews, auto-loaded media, HTML/markdown with embeds), it becomes the same class of zero-click delivery channel that WhatsApp is. Hardening the DM renderer and message ingestion path is now a P0 concern that wasn't on this list before reading the article.

---

## Four threat classes

### T1 — Client-device compromise via zero-click mercenary spyware

Buyers like ICE/HSI procure Graphite, Pegasus, or Predator and deploy zero-click exploits against targeted phones. Once on-device, the attacker reads everything the user can: DMs, photos, location history, push-notification content, stored session tokens, keychain.

Trellis cannot prevent device compromise. It *can*:

- reduce what a compromised session can retrieve from the server (ephemerality, reduced history, server-side history horizon),
- reduce what transits the network or is visible to push-infra intermediaries (polling notifications, already done),
- provide a fast "I think I'm compromised" lockdown path (revoke sessions, hide history),
- avoid being the *delivery channel* for zero-click exploits against other apps (see T3).

**Design constraint from screening research** (per the Border Safety Mode threat model in the product repo that ships this feature): screening contractors flag *sudden silence*, *mass deletion*, and *activity spikes* as suspicious. A lockdown feature that makes a user abruptly invisible is itself a screening signal. P0.6 should degrade visibility gracefully (e.g. hide DMs and block new posts while leaving existing posts in place) rather than brick the profile.

### T2 — Server-side exposure via administrative subpoena, judicial warrant, database compromise, or insider access

Same adversaries can obtain server-stored data through legal process — and per the NPR article, an **administrative** subpoena (issued by the agency itself, no judge) may suffice for much of what the server holds. Anything plaintext in RDS, DynamoDB, or AuraDB is exposed. A DB-level compromise (insider, credential theft, CVE) has the same effect with no paper trail.

AWS hosting in eu-central-1 provides some friction against direct US-issued compulsory process but does not eliminate it (AWS is a US company; MLATs exist).

**Concrete April 2026 example.** The Intercept / Ars Technica reported that DHS issued an administrative summons to Reddit under 19 USC § 1509 (a 1930 Smoot-Hawley customs statute — boats, alcohol, wild-animal imports) to unmask an anonymous US-citizen Redditor in Oregon whose only flagged conduct was political speech criticizing ICE after the Minneapolis police-shooting death of Renée Good. When the target moved to quash, DHS rescinded; four days later, the US Attorney for DC issued a **grand jury subpoena** — secret, non-adversarial, venue-shopped to DC, scope 3× longer than the original summons. The exact data demanded: *"name, telephone number, home address, banking and credit card information, IP addresses, telephone model number(s), and the names of any other accounts associated with their Reddit account."* That shopping list maps cleanly to trellis's `User` row, `SecurityEvent` rows, and the Cognito attributes trellis reads. EFF characterises this as "where free-speech protections are at their weakest." Whatever data trellis holds on a pseudonymous user will be subject to the same legal playbook; the defense is to hold less of it.

**History does not self-correct.** The same § 1509 tactic was attempted against Trump-administration critics in 2017 and reprimanded by DHS's own Office of the Inspector General. Nine years later, the same agency is using the same statute for the same purpose. "Internal oversight will catch this" is not a defense a platform operator can rely on. External commitments — notify users of process, publish a transparency report, refuse overbroad requests — are the only checks that have demonstrably worked, per the Reddit case.

**Platform posture varies, and it matters.** The Intercept's coverage reveals three different postures among platforms receiving these requests: Google "secretly handed ICE data about a pro-Palestine student activist" (no user notification, no challenge); Meta contested requests in court (CLDC prevailed in October 2025 before Magistrate Judge Westmore); Reddit notifies users and objects to overbroad requests. The practical difference for targets is whether they get representation in time to quash. This is a policy choice a Trellis operator can and should make explicitly (see commitment #4 in [`04-rollout-policy.md`](04-rollout-policy.md)).

Trellis can:

- hold less subpoenable data in the first place (metadata minimization — coarsen location, scrub IPs, truncate history),
- make sensitive content server-unreadable (client-side E2E encryption for DMs, then for other sensitive fields),
- make the subpoena target noisy/ambiguous (sealed sender, cover traffic — higher effort, lower priority).

### T3 — Trellis as a zero-click delivery channel against its own clients

**New in light of the Graphite/WhatsApp pattern.** Graphite reached targets through WhatsApp messages that triggered parser/renderer exploits in the WhatsApp client without the user clicking anything. Any messaging or social-feed feature that auto-renders user-supplied content — images, videos, link-preview cards, HTML-ish markdown, animated stickers, emoji rendering, URL unfurling — is the same class of attack surface.

If a product on trellis ships DMs (and it's on the roadmap for at least one consumer), or if a post's auto-expanded media renders on first view of a timeline, trellis becomes a plausible delivery channel for the next zero-click bug. The ICE/Paragon case is US-domestic and argues against complacency on the theory that "we're not a political platform."

Trellis can:

- restrict incoming media formats to a small, well-hardened allowlist; transcode-then-discard novel formats,
- **refuse to auto-fetch link previews server-side** from user-supplied URLs (OG-scrape is a server-side SSRF / exploit-delivery hop, and the fetch itself is a tracking pixel),
- serialize DMs as structured data rather than rich HTML; render with minimal parsers on the client,
- for first-contact messages from unknown senders, rate-limit and quarantine to reduce drive-by zero-click reach.

### T4 — Commercial data acquisition without warrant or spyware

**Not implied by the NPR article directly, but by its companion piece and Citizen Lab's September 2025 report on [Webloc / Penlink](https://citizenlab.ca/research/analysis-of-penlinks-ad-based-geolocation-surveillance-tech/).** Penlink (formerly Cobwebs Technologies, Israeli-founded, acquired by Spire Capital in 2023) sells Webloc to ICE, the US military, Texas DPS, West Virginia DHS, NYC DAs, and many US police departments — as well as Hungarian intelligence, El Salvador's National Civil Police, and others. Webloc does not exploit devices and does not subpoena servers. It **buys** Mobile Advertising IDs, GPS coordinates, IP-inferred locations, nearby WiFi/Bluetooth detections, and device specs from the Real-Time Bidding ad ecosystem and from SDKs embedded in consumer apps (games, weather, dating), retaining up to **three years of per-device movement history**.

**Related tools in the same commercial-surveillance class** (documented in the Border Safety Mode social-media-screening research in the product repo): **Babel Street** and **Fivecast** for network-graph analysis (social connections, cluster identification); **ShadowDragon** for cross-platform identity correlation across 225+ platforms via usernames, emails, phone numbers, IP addresses, and writing-style fingerprints; **Dataminr**-style real-time social-media monitoring. Several are US-government contractors with CBP, ICE, and state-police customers. The defensive implication for trellis is the same as for Penlink: don't be a source, and don't make what we *do* publish cross-referenceable.

The significance for a product on trellis: a Webloc customer targeting one of its users does not need the platform's database. They have the user's MAID-keyed 3-year location corpus via any other app the user has installed. What they gain from the platform is *cross-reference material* — a post with precise GPS + second-precision timestamp links cleanly to the already-purchased corpus and reveals identity.

T4 is not defensible by T1 or T2 defenses alone. Specific T4 defenses:

- **Don't be a source.** No ad SDKs, no third-party analytics SDKs that ship MAIDs, no growth/attribution SDKs, no RTB participation. This is largely a mobile-client commitment but naming it at the trellis level keeps it load-bearing.
- **Reduce cross-reference value of what the platform *does* publish.** Coarsening location (P0.2) and post-timestamp granularity directly degrade the cross-reference attack — 1km × hour is noise-dominated where 6-decimal × second is pinpoint-clean.
- **Don't collect MAIDs server-side either.** If Cognito's advanced-security features or any push-notification setup ever pulls IDFA/AAID, remove it.
- **Strengthen IP scrubbing (P0.3).** Webloc infers location from IP; a leaked/subpoenaed `SecurityEvent` row with a precise IP feeds the same corpus.

See also the policy section in [`04-rollout-policy.md`](04-rollout-policy.md) — T4 is the class where policy commitments (no ad-SDK, no data sale) matter as much as code.

---

## What trellis *should* defend vs. what is explicitly out of scope

In scope: DM privacy, location privacy, metadata minimization in logs and EXIF, push-notification payload reduction, panic/lockdown mode, ActivityPub federation leakage, link-delivered exploits, key material handling.

Out of scope: on-device hardening (OS and client app's job), endpoint attestation (no realistic defense for a rooted/exploited device), pre-exploit disclosure programs (Apple/Google domain).
