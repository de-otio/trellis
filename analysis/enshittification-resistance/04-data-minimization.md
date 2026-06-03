# 04 — Don't collect the behavioural surplus

> **Leverage: high, and uniquely durable.** This is the one change that makes
> enshittification *technically* hard later, not merely policy-forbidden now.

## The principle

Twiddling runs on surveillance data; behavioural surplus is its fuel. Trellis
already declines to *rank* on engagement (doc 03). The deeper question:

> Does Trellis **collect and retain** the per-user behavioural data
> (dwell time, scroll depth, view events, hover, time-on-post) that a future
> product manager could switch ranking, ads, or microtargeting onto?

You cannot rank on, sell, A/B-microtarget with, or hand to an acquirer data you
never collected. Every other invariant in this folder forbids a *use* of data;
this one removes the *raw material*. It is the only proposal here that an
acquirer or a desperate growth team cannot undo by editing a config — the data
simply isn't in the warehouse.

## Why a use-restriction isn't enough

A "we won't microtarget" policy is a reversible default: the data sits in a
table, and one quarter of bad revenue turns the policy into a `JOIN`.
Data-minimization is the structural version — it changes what is *possible*, not
what is *permitted*.

## Design changes

### A. No per-user behavioural telemetry retention

- Do **not** persist per-user view / dwell / scroll / impression streams. If a
  signal is needed for operations (capacity, abuse detection), collect it
  **aggregated** and without a user key, or with a short, enforced TTL.
- Where per-user events are unavoidable (e.g. read-state for "caught up"),
  retain only the minimum (a high-water mark / cursor), not a full event log.

### B. Make the absence auditable

- A documented data-inventory listing every per-user signal collected, its
  purpose, and its retention. A schema change that adds a behavioural-surplus
  column should require a corresponding inventory entry — enforceable as a
  review rule (CODEOWNERS on the inventory + the Prisma schema) and, ideally, a
  test that flags new `Json` "metadata"/"events" columns on user-scoped models.

### C. Aggregate-only metrics for the operator

- Operational dashboards read from aggregated, non-re-identifiable rollups, so
  there is never a business reason to keep the raw per-user stream "just in
  case." Removing the *justification* to collect is as important as removing the
  *permission*.

## Interaction with other docs

- Reinforces **doc 03**: even if the ranking guard were somehow circumvented,
  there is no behavioural signal to rank on.
- Reinforces **doc 05**: a tenant cannot ask for microtargeting of its users if
  the surplus to target on does not exist.
- Caveat for **doc 02**: the export/round-trip must itself not become a pretext
  to start logging detailed activity. Export the user's *content and graph*, not
  a behavioural profile.
