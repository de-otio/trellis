# De Otio Alignment

De Otio's stated mission, from [cdk-de-otio-website/hugo/content/about.md](../../../cdk-de-otio-website/hugo/content/about.md):

> *De Otio provides infrastructure for projects that engage, teach, inspire or spread Lebensfreude. It is inspired by Seneca's "De Otio"*

And from [dot-notes/README.md](../../../dot-notes/README.md):

> *De Otio follows an AI-first strategy with the goal of maximizing the benefits of AI across the entire organization.*

This section maps those values to the concrete decisions a public `@de-otio/crypto-envelope` package would embody.

## Values → package shape

| Value | What it implies for the package |
|---|---|
| **AI-first** | A single-message agent instruction (`"install @de-otio/crypto-envelope and wire up an envelope client at tier Standard for my app"`) must produce a working setup. README structured for agent consumption: capability table near the top, code-block-first examples, no "choose your own adventure" branching. API designed so that the 95% path has one correct call; advanced paths are separate entry points. Matches the pattern already set by `@de-otio/agent-safety-pack`. |
| **Lebensfreude** | Joy in building, not friction. Indie devs and small teams should find this *delightful* compared to rolling libsodium primitives or reading JOSE specs. The package removes cryptographer gatekeeping from building privacy-respecting apps. The UX goal is "you don't need to know what key commitment is — but if you read the code, you'll find it there, done right." |
| **Infrastructure-provider role** | De Otio's stated role is "provides infrastructure." An encryption envelope library is exactly that: invisible plumbing that makes other people's work possible. It is not a product with a user journey of its own. This aligns — productizing chaoskb's crypto matches the role description; productizing, say, a social app does not. |
| **Privacy-forward** | MIT license, public repo, auditable code, encryption-first defaults, server-never-decrypts ethos baked into the envelope design. Consistent with Trellis's spyware-defense posture (and the downstream border-safety feature in the trellis product repo) and with GDPR-compliance already in de-otio's public legal pages. |
| **Open-source default** | `@de-otio/agent-safety-pack` is MIT, public. `@de-otio/chaoskb` is MIT but private (`"private": true` in package.json). An envelope library should be MIT + public from day one — crypto libraries earn trust only through external review, and private crypto code is anti-trust-signal. |
| **Supply chain integrity** | De Otio has opinions on this, written up in [dot-notes/doc/supply-chain-attack-mitigations.md](../../../dot-notes/doc/supply-chain-attack-mitigations.md): publish with provenance, use Trusted Publishing, scoped packages, 2FA. A public de-otio crypto library is the most load-bearing application of that guidance. Follow it exactly. |
| **Minimal dependencies** | `agent-safety-pack` advertises "zero runtime dependencies." `@de-otio/crypto-envelope` should aim for the same — with `@noble/*` as possible exceptions if they're genuinely load-bearing. A crypto lib with 40 deps in its tree is a security liability regardless of what it claims to defend. |

## Lineup: `@de-otio` as "safe defaults for agent-built private apps"

Two public packages so far fit a single coherent story:

1. **`@de-otio/agent-safety-pack`** — protects the *agent* from doing destructive things while building your app.
2. **`@de-otio/crypto-envelope`** (proposed) — protects the *user* of the app the agent built.

Together they form a narrative: *"when you build an app with an AI coding agent, these two libraries cover the two ways it can hurt people — the agent damaging your system, and your app leaking user data to servers that shouldn't see it."*

This is a natural brand story. Further packages could join the lineup without forcing it:

- **`@de-otio/opaque-blob-store`** — the server-side primitive from chaoskb (Lambda + DynamoDB), published as a CDK construct. Makes it one command to deploy a zero-knowledge backend for any `crypto-envelope` client.
- **`@de-otio/mcp-registry`** — agent-facing manifest utilities if they emerge from existing work.

But the *minimum viable lineup* is just the two: agent-safety-pack (already shipped) and crypto-envelope (proposed). They're sibling libraries with matching shape: MIT, TypeScript-first, agent-installable, zero-ish runtime deps, Node 20+, published on npm with provenance.

## What this package is *not*

Important, because scope creep is the death of crypto libraries:

- Not a secrets manager. (Platform keyring integration is a thin helper at best.)
- Not a protocol library. (No Signal ratchet, no MLS, no federation.)
- Not a KMS wrapper. (Users who want KMS-backed master keys can use aws-encryption-sdk.)
- Not a file encryption tool. (age exists and is excellent at that.)
- Not a JWT / token library. (jose exists.)
- Not a full end-to-end messaging protocol. (Signal / MLS exist.)

The package is exactly one layer: take a plaintext payload + a key tier, produce a versioned authenticated envelope with defensible defaults, reversibly. That's the contract.

## The Lebensfreude test

Before shipping v1.0, there's a subjective-but-real sanity check: is working with this library a *joy* for an indie developer building a private-by-default app? If `EnvelopeClient` setup requires more than two mental steps ("pick a tier, call init") and the common cases require more than one line of code each, the Lebensfreude test fails.

This is a quality bar that has real engineering implications: careful naming, excellent docs, examples that run, agent-readable README, and the willingness to say no to features that hurt the 95% case.
