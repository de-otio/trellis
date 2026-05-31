# Spyware Defense — Trellis-side Changes

Initial analysis, 2026-04-12.

Threat prompt: *"Changes or features to trellis that would help defend against nation-state spyware attacks like the NPR / ICE spyware story"* (NPR, April 7 2026 — ICE's HSI using Paragon's **Graphite** spyware, zero-click via messaging apps, with civil-liberties concerns about administrative-subpoena scope creep against US residents).

Grounded further in Citizen Lab's September 2025 analysis of Penlink's [**Webloc**](https://citizenlab.ca/research/analysis-of-penlinks-ad-based-geolocation-surveillance-tech/) — a parallel commercial-data-broker pipeline that sells ICE, DoD, state police, and foreign intelligence services up to **three years of per-device location history** purchased from Real-Time Bidding auctions and SDK-embedded trackers in everyday consumer apps. No warrant, no spyware; they just buy it.

The question for trellis: given that spyware exists and can't be prevented at the OS layer, and that commercial location corpora exist and can't be erased, what can a backend do to (a) reduce what a compromised device exfiltrates, (b) reduce what's subpoenable from the server, (c) avoid becoming the delivery channel for the next zero-click exploit, and (d) avoid feeding the ad-broker pipeline that already sells to the same adversaries?

This is a platform-level analysis. It applies to any product built on Trellis; product-specific repos (e.g. a vertical that ships a mobile client) own the client-side half of several items.

## Contents

1. [**Threat Model**](01-threat-model.md) — what the article actually describes, the three threat classes this document defends against (client compromise, server-side legal process, trellis-as-delivery-channel), and scope boundaries.
2. [**Current State**](02-current-state.md) — what trellis already has, grounded in a repo survey. Mostly "preparatory scaffolding" (schema fields waiting to be wired up) rather than working defenses.
3. [**Prioritized Changes**](03-priorities.md) — P0 through P3 changes, each with impact, current state, concrete change, and files to touch.
4. [**Rollout, Policy & Caveats**](04-rollout-policy.md) — suggested order of work, policy commitments that must come before the code (no bulk data sale; warrant-required LE policy), out-of-scope items, and verification steps.

## How to read this

- The **P0 list in `03-priorities.md`** is the most actionable — six items, each finishing scaffolding that's already in the schema. That's where to start.
- The **threat model in `01-threat-model.md`** is the "why" — reviewers and future-you will want this context when scoping individual items.
- The **policy section in `04-rollout-policy.md`** is out-of-scope for code but gates the engineering work; none of the P0 hardening is worth much if the platform sells bulk data.

This is an analysis, not a specification. Each P0/P1 item still needs its own scoped design pass before implementation.
