# 01 — The research-access crisis and the opportunity

## The instruments went away

For roughly a decade (2012–2022), computational social science ran on a small
number of platform-provided instruments. They are mostly gone:

- **CrowdTangle.** Meta's tool for tracking public content was the workhorse of
  misinformation, public-health, and election research. Meta announced its
  retirement and shut it down on **14 August 2024**, directing researchers to
  the **Meta Content Library** — a more restricted API gated behind
  institutional vetting via ICPSR, with a narrower data scope and no ad-hoc
  export.
- **Twitter/X API.** In **February 2023**, Twitter ended free API access and
  removed the academic-research product track introduced in 2021. The
  replacement enterprise tiers (reported in the tens of thousands of dollars per
  month) priced out the systematic data collection that thousands of papers had
  depended on. A large body of "Twitter as a model organism" research lost its
  organism.
- **Reddit, TikTok, others** tightened or monetised access over the same period.

The net effect: the field's empirical base narrowed to whatever platforms chose
to expose, on terms platforms set, with analysis often required to run inside
platform-controlled enclaves.

## The credibility problem this creates

The **US 2020 Facebook & Instagram Election Study** (Guess, Nyhan, Tucker et
al., published in *Science* and *Nature* in 2023) is the clearest illustration.
It was a genuine collaboration: external academics designed interventions
(chronological-feed swaps, reshare removal) that Meta implemented on consenting
users, producing some of the best causal evidence yet on feed effects. But the
data lived on Meta's infrastructure, the instrumentation was Meta's code, and
the analysis ran in Meta's environment. The findings' independence rested
entirely on trust in the platform — exactly the thing the research was trying to
adjudicate. Critics noted the platform could, in principle, shape what was
measurable.

This is the structural bind of platform research: **the entity being studied
controls the instrument.** A platform built so that the *instrument is
independent of the platform's commercial incentives* would be a different kind
of object.

## The regulatory pull: DSA Article 40

The EU **Digital Services Act, Article 40** changes the default. Very large
online platforms (VLOPs) must provide **vetted researchers** with access to data
needed to study *systemic risks* (disinformation, effects on minors, civic
discourse). The **delegated regulation on data access**, adopted 2 July 2025,
specifies the vetting process (researchers apply via Digital Services
Coordinators), the data-protection safeguards, and the obligation to provide
data in a usable, documented form.

Article 40 presumes a platform can:

1. Identify and authenticate a **vetted researcher** (not just any developer).
2. Scope access to a **specific, approved research question**.
3. Provide data with **documentation and provenance** good enough to be
   scientifically usable.
4. Do all of this **without violating the GDPR rights** of the people in the
   data.

Most platforms are retrofitting this onto architectures that were never designed
for it. Trellis has the components for each of those four obligations already
(tenant-scoped identity for (1), feature-flag + extension scoping for (2),
`AuditEvent`/export pipelines for (3), `CrossRegionConsent` + deletion for (4)).
That is the opportunity.

## The reproducibility angle

Beyond access, computational social science has its own replication crisis:
findings that don't reproduce because the underlying data was a one-time scrape
against a moving target (a ranking model that changed, an API that was
deprecated, a sample that can't be reconstructed). Salganik's *Bit by Bit*
(2018) frames the methodological choice as **"readymade" observational data vs.
"custommade" designed data**, and argues the future is *hybrid* — designed
studies embedded in running systems, with the design recorded.

A platform whose feed is **stationary and documented** (chronological, no
drifting model) and whose interventions are **defined as versioned feature
flags** can offer something rare: a study you can re-run, on a treatment you can
describe exactly, against a feed that behaved the same way last year. That is the
reproducibility dividend of the safety-first design — see doc 04 and doc 07.

## What "useful for research" should and should not mean

To keep the rest of this analysis honest, two boundaries:

- **It should mean** lowering the cost of *legitimate, consented, reviewed*
  research on social behaviour — and raising the *credibility* of that research
  by making the instrument independent and reproducible.
- **It must not mean** turning Trellis into a data broker, a surveillance
  surface for "research-washed" ad targeting, or a platform that experiments on
  users (especially minors) without consent. Doc 06 makes these the governing
  constraints, not afterthoughts.

## Sources

- Meta, CrowdTangle retirement announcement and Meta Content Library transition
  (shutdown 14 Aug 2024).
- Twitter/X API access changes, February 2023; removal of the academic research
  product track.
- Guess, Nyhan, Tucker et al., US 2020 Facebook & Instagram Election Study,
  *Science* / *Nature*, 2023.
- EU Digital Services Act, Regulation (EU) 2022/2065, Article 40; delegated
  regulation on data access for vetted researchers (adopted 2 July 2025).
- M. Salganik, *Bit by Bit: Social Research in the Digital Age* (2018), ch. on
  observing behaviour and running experiments.

> Dates and figures above are from memory to the January 2026 cutoff and should
> be re-verified against primary sources before external use.
