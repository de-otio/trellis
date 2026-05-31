# Rollout, Policy & Caveats

## 1. Suggested order

1. **First week:** P0.1 (EXIF), P0.3 (IP scrubbing), P0.5 (message/media ingestion hygiene — narrow allowlist + no server-side link preview fetch), P0.7 (mobile-client SDK inventory + MAID policy — mostly audit work), P2.2 (crypto-erase on delete), P2.6 (enforce visibility flags). All are small, defensive, limited surface area.
2. **Second–third week:** P0.2 (location coarsening), P0.6 (lockdown mode). Medium risk; need UX decisions.
3. **Month 2:** P1.3 (WebAuthn), P1.2 (pre-delivery URL scan).
4. **Quarter 2:** P1.1 (E2E DMs), P0.4 (KMS ActivityPub keys — only if federation is enabled). Significant projects. **Do not ship DMs without P0.5 in place** — the ingestion-hygiene work gates the DM launch.
5. **Stretch / never:** P3.*.

See [`03-priorities.md`](03-priorities.md) for full item descriptions.

---

## 2. Policy commitments that should precede the code

Bulk commercial data sales close the loop between civilian platforms and agencies like ICE; no amount of in-platform hardening helps a user whose data the operator has sold (directly or indirectly through SDK-mediated flows) to a broker. Citizen Lab's September 2025 analysis of Penlink's [Webloc](https://citizenlab.ca/research/analysis-of-penlinks-ad-based-geolocation-surveillance-tech/) documents exactly how this pipeline operates — RTB + SDK-embedded trackers → broker → ICE, DoD, state & local police, foreign intelligence services — and the companion NPR piece cited in the ICE/Graphite story notes the federal government purchases this data without a warrant. Three commitments are worth making explicit before any of the engineering work above:

1. **No bulk data sale, ever, to anyone — brokers, ad-tech partners, analytics resellers.** Architecturally: no pipeline out of RDS or S3 that aggregates per-user data for an external buyer. Should be named in terms of service and reflected in IAM policies — no IAM role should have `s3:GetObject`-over-everything on user content except the app itself.
2. **No ad-SDK / analytics-SDK participation; no MAID collection; no RTB integration.** This is the *upstream* end of the data-broker pipeline. Covers both client (mobile app) and server (trellis): no Firebase Analytics, no Crashlytics with device IDs, no attribution SDKs (AppsFlyer/Adjust/Branch), no ad networks, no querying iOS IDFA or Android AAID. See P0.7 in [`03-priorities.md`](03-priorities.md) for the detailed implementation requirements. This commitment is how a product on trellis stays out of Penlink's / Fog Data's / X-Mode's supply chain.
3. **Warrant-required policy for law-enforcement data requests, with transparency reporting.** An administrative subpoena (the specific path flagged by EFF in the ICE/Graphite article, and actually used by DHS against Reddit in April 2026 under a 1930 customs statute) should be refused absent a judicial warrant for content; only the minimum required by law for non-content basic subscriber info. This belongs in a public Law Enforcement Guidelines page and a warrant-canary practice — neither is trellis code, but they shape what trellis should hold.
4. **Notify users of legal process whenever possible.** Match Reddit's stated practice: when a summons, subpoena, grand jury subpoena, or warrant targets a specific user, notify that user unless a court order legally compels non-disclosure. Language like *"requested not to disclose"* in an administrative summons (the exact phrasing on the DHS summons to Reddit) is a request, not a legal gag order — do not treat it as binding. User notification is what let the Reddit John Doe get representation (CLDC) and move to quash in time; without it, the target is defenseless.

   The counter-example to aim *away from* is Google, which per The Intercept "secretly handed ICE data about a pro-Palestine student activist" — no user notification, no opportunity to challenge. Meta contested requests in court and mostly won (CLDC prevailed before Magistrate Judge Westmore in October 2025, and separate orders have blocked Meta from sharing anti-ICE activist Instagram data). Reddit's notify-and-object-to-overbroad model is the reference posture; commit to it and say so publicly, so users can choose the platform on that basis.

5. **Publish a transparency report.** Reddit's transparency report disclosed 1,179 legal-process requests in January–June 2025 (all-time high), 66% from US agencies, with 82% disclosure rate. A transparency report is the only external way users and researchers can see the pattern of requests. Even a minimal one — request counts by category and jurisdiction, denial rate, gag-order count — creates accountability. Commit to publishing one on a regular cadence (e.g. biannual) from day one of any meaningful user traffic.

All four are org-level, not trellis-level, but the engineering decisions above assume these are in place. If they aren't, the P0 hardening is partially cosmetic — a platform that hardens its DB against subpoena while its Flutter client broadcasts MAIDs to Firebase has simply moved the leak channel, not closed it.

**Documented adversaries to keep in the threat-model scope:**

- **Spyware operators:** ICE/HSI (Graphite via Paragon Solutions), and by extension any US or allied agency procuring Paragon, NSO (Pegasus), or Intellexa (Predator).
- **Commercial location brokers:** Penlink / Webloc customers — ICE, US DoD, Texas DPS, West Virginia DHS, NYC DAs, LAPD/Dallas PD/Baltimore PD and peers; Hungarian domestic intelligence (since 2022); El Salvador National Civil Police (since 2021). Plus other tools in the class: **Babel Street** and **Fivecast** (network-graph analysis), **ShadowDragon** (cross-platform identity correlation), **Dataminr** (real-time monitoring) — all documented as government contractors in the Border Safety Mode social-media-screening research in the product repo.
- **Legal-process operators:** DHS (§ 1509 customs-statute administrative summonses against political speech); the US Attorney's Office for DC (grand-jury venue-shopping, Reddit April 2026); CBP at US ports of entry (device-unlock demands, forensic tools).

The list is not "foreign adversaries against foreign dissidents" — it is substantially US agencies against US residents including non-citizens, using a mix of procured spyware, bought ad-broker data, and administrative legal process. Border Safety Mode (a product-repo feature; see the Border Safety Mode analysis in the product repo) addresses the *pre-travel, user-facing* end of this threat model; this spyware-defense document addresses the *platform-side* end. Both assume the P0-era hardening in [`03-priorities.md`](03-priorities.md) is in place.

---

## 3. Out-of-scope but worth naming

- **Mobile client** is where most of the cryptographic work for P1.1 and P1.3 actually lives, and where P0.5 message-rendering hardening is enforced end-to-end. That's in the product repo and would need its own analysis.
- **Infra:** some changes (KMS keys for P0.4, CloudWatch log redaction for P0.3) require CDK updates in `infra/lib/stacks/`.
- **Abuse operations:** reducing logged data (P0.3) increases operational cost for legitimate anti-abuse work. Any change here should be paired with a 7-day precise-retention window so active investigations aren't broken.
- **Forensic cooperation:** the Paragon/Italy story ended only because Citizen Lab could forensically attribute the infections. The client app should emit enough diagnostic signal (crash traces accessible to the user, process-integrity checks, unusual-session alerts) that an external forensic researcher can work with the user — *without* trellis itself becoming a telemetry pipe back to the operator's servers.

---

## 4. Verification of this analysis

The trellis survey underlying this document was a single-pass exploration. Before committing to any of the changes, verify:

- That the cited schema field names and line numbers still match (~L230, ~L1111 etc.) — they are point-in-time.
- That no registered domain extension relies on any of the fields we'd deprecate (EXIF GPS, precise location, plaintext DMs).
- That the published `@de-otio/trellis` package matches the source tree we surveyed.

If a newer article describes a novel vector (e.g., a new Safe Browsing bypass, a new push-notification exploit, or a specific ICE contractor TTP), map that back to [`03-priorities.md`](03-priorities.md) before acting.
