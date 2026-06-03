# 07 — Binding your own hands

> **Leverage: medium, but it's the meta-move.** Doctorow's deepest structural
> point is that what actually prevents decay is making good behaviour
> **expensive to reverse** — and doing it while it is still cheap, before the
> pressure to reverse arrives.

## The idea

Docs 02–06 each harden one surface. This doc is about the *pattern* they share
and the governance scaffolding that makes the pattern stick: every good property
should live somewhere the operator cannot quietly edit without the change being
**visible, reviewed, and costly**.

A guarantee's strength is the effort required to break it:

| Where the guarantee lives | Reversal cost | Verdict |
|---|---|---|
| A maintainer's intention | zero | not a guarantee |
| A default value in code | one-line diff, invisible to users | weak |
| A guard test + CODEOWNERS | a reviewed diff to a tripwire | strong |
| A user-visible version/disclosure | a diff *plus* a public signal | stronger |
| An external, re-importable exit path | users can already be gone | strongest |

## Concrete, cheap-now bindings

### A. A versioned, in-repo "user rights" contract

A single document enumerating the invariants — no engagement ranking
(doc 03), no behavioural-surplus collection (doc 04), re-importable export
(doc 02), floor-only tenant policy (doc 05), no anti-interop measures (doc 06).
Versioned in the repo so any regression is a **visible diff**, not a silent
config change. This is the human-readable index that the machine checks below
enforce.

### B. Wire each invariant to a tripwire

Recap of the machine-checked guarantees proposed across this folder, so they
land as one CI surface rather than scattered intentions:

- Ranking guard test — fails the build on any engagement signal (doc 03).
- Export round-trip test — fails the build if the graph stops being
  re-importable (doc 02).
- Tenant-floor property test — fails the build if a tenant policy can loosen a
  safety floor (doc 05).
- Data-inventory check — flags new per-user behavioural columns (doc 04).
- Anti-interop dependency check — flags client-attestation/fingerprinting
  additions (doc 06).

CODEOWNERS over the guards themselves, the rights contract, the licence, and the
ToS, so weakening *the locks* is also a reviewed, visible act.

### C. Keep the CRIA / safe-by-design process as the labour-force analogue

Trellis already has a Child Rights Impact Assessment step in the feature
lifecycle (`analysis/safer-social-design/07-safe-by-design-and-governance.md`).
That is the closest thing a codebase has to Doctorow's **labour** discipline — a
standing process whose sign-off a feature cannot skip. Extend its checklist to
ask, for each feature: *which invariant in the rights contract does this touch,
and does it move toward or away from harm?* A feature that loosens an invariant
must say so out loud.

## The timing argument

All of this is cheap **now** — no users, no production data, no backward
compatibility (`analysis/redesign/README.md`). It becomes expensive exactly when
it becomes valuable: once there are users to protect and revenue pressure to
resist. The entire point of enshittification-resistance is that **the
constraints must predate the incentive to break them.** Build the locks before
there's anything behind the door worth taking.
