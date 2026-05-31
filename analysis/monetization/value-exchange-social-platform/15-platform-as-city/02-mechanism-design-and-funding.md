# Lineage 2 — Mechanism Design and Tax-like Funding

The mechanism-design lineage that operationalises tax-like funding for shared services. The most directly relevant body of work for **claim 3** (common services are tax-financed by their participants), and the only lineage that has *implemented* anything resembling the hypothesis at scale.

---

## Core Works

| Author / Work | Year | Contribution |
|---|---|---|
| **Eric Posner & Glen Weyl, *Radical Markets*** (Princeton) | 2018 | Two mechanisms relevant here: Common Ownership Self-Assessed Tax (COST) — a levy on self-declared asset value, designed to discourage rent-extraction — and Quadratic Voting (QV) — preference intensity at quadratic cost. Both are tax-shaped mechanisms designed with digital economies in mind. |
| **Vitalik Buterin, Zoë Hitzig & Glen Weyl, "A Flexible Design for Funding Public Goods"** (Management Science) | working paper 2018; published 2019 | Quadratic Funding (QF): the matching formula in which the subsidy to a public good scales with the *square of the sum of square roots* of contributions. Many small contributors outweigh a few large ones. Probably the single most relevant academic work to the hypothesis. |
| **Gitcoin Grants (operational deployment of QF)** | 2019– | The largest live QF implementation. The round finalised in May 2025 distributed >$1.2M across 235 projects. Real-world evidence that the mechanism works at non-trivial scale. |
| **RadicalxChange Foundation** | 2018– | Operational arm of the Posner/Weyl programme. Maintains plural-funding and plural-voting literature. |
| **Glen Weyl & Audrey Tang, *Plurality: The Future of Collaborative Technology and Democracy*** | 2024 | The closest existing synthesis to the hypothesis. Tang's Taiwan vTaiwan/Polis work (platform-as-deliberation-space) + Weyl's mechanism design (tax-like funding mechanisms) = explicitly "platform as polity with funding mechanisms". **If only one work is read from this folder, this is it.** |
| **Lars Doucet, *Land is a Big Deal*** (self-published) | 2022 | Georgist land-value-tax theory applied digitally — the argument that some forms of shared value-creation are the natural tax base, including in digital spaces. Niche but the most direct LVT-for-digital-commons argument. |

---

## What This Lineage Gives the Hypothesis

Strong support for **claim 3**: there are operational, implemented, mathematically grounded mechanisms for funding shared services from participants in proportion to their support, with anti-concentration properties built in. QF in particular is exactly the *shape* of mechanism the hypothesis needs.

Implicit support for **claim 1**: QF was designed *for* public goods. Adopting QF inside a platform is itself a normative claim that the platform supplies public goods.

---

## What This Lineage Does Not Give

The **dual B2B/B2C citizenship** framing. QF and COST assume a relatively homogeneous citizen-funder body where every participant is broadly similar in kind, differing only in resource. Neither mechanism is specifically designed for a polity where one class of citizen (B2B) routinely contributes orders of magnitude more than another (B2C). The mathematical anti-concentration property of QF is *part* of an answer to this, but not the full answer — it doesn't speak to whether B2B and B2C have the same vote, the same service entitlement, or the same standing.

It also says little about **what the common services are**. The mechanism is general-purpose; the *menu* of services it should fund inside a social platform is a separate design question.
