# What in Trellis isn't actually about social networks

A meta-review of `apps/api/src/lib/` (141 files, ~37k LOC) and the extension
package, looking for code that is so generic to multi-tenant SaaS / API
backends that it belongs *below* Trellis as its own package — not inside the
social-network core.

Trellis is supposed to *be* the reusable thing, but a lot of what it
currently contains isn't actually social-network-specific. It's generic
multi-tenant-SaaS plumbing that gets re-written every time a new backend
starts. Three buckets, ordered by payoff.

## 1. Replace with OSS, don't extract

These are reasonable in-house solutions that would be better off retired
than packaged:

- **Custom router** (`router.ts`, `route-matcher.ts`, `route-helpers.ts`,
  the regex-array `Route[]` pattern) — middleware composition hand-rolled
  on `node:http`. Hono or Fastify give the same shape with typed params,
  OpenAPI generation, and a maintained ecosystem. Likely the
  highest-leverage swap in the repo.
- **`circuit-breaker.ts` + `database-circuit-breaker.ts`** (~300 LOC) →
  cockatiel or opossum. Same state machine, audited.
- **`csrf.ts`, `security-headers.ts`, `cors-handler.ts`** (~600 LOC) →
  helmet + a CSRF lib. The custom code has subtle pitfalls (CSP nonces,
  SameSite/Secure interplay) that the OSS libs already got bitten by.
- **`openapi/`** → zod-openapi or `@hono/zod-openapi`. Generate from
  existing Zod schemas instead of a custom walker.
- **`id-generator.ts`** → nanoid / cuid2 / ulid. Already 50 LOC; the
  dependency is smaller than the wrapper.
- **Custom Cognito JWT plumbing in `cognito/`** — `aws-jwt-verify` is
  already a dependency; collapse the wrapper.

## 2. Extract into a foundation package

Call it `@de-otio/saas-foundation` or similar. These are *generic* but
currently shaped around Trellis types. They will pay off the next time a
new backend is started — and several have been. Worth one focused
decoupling pass:

- **The cloud shims** in `kv/dynamodb-kv.ts`, `queue/sqs-queue.ts`,
  `storage/s3-storage.ts` — already structured as Cloudflare-compatible
  interfaces over AWS primitives. This is the single most reusable thing
  in the repo. ~Zero domain coupling, exactly what's needed to bootstrap
  a new SaaS. Extract verbatim.
- **`secret-resolver.ts` + `secrets/`** — SSM / Secrets Manager loader
  with caching. Every AWS project has this.
- **`session-manager.ts`** (665 LOC) — AES-GCM cookie + Cognito JWT
  validation. Split: the encryption layer is generic; the Cognito-claim
  parsing is pluggable. The generic half is reusable.
- **`audit-logger.ts`** — drop the Trellis-specific event-type enum,
  parameterise the table, and what remains is a generic append-only
  audit log with retention tiers.
- **`logger.ts` + `request-context.ts`** — structured logging with
  AsyncLocalStorage request-id propagation. Remove the
  `Logger.getInstance()` singleton and this is a house logging package.
  (Or replace with pino + a small ALS wrapper.)
- **`feature-toggle-service.ts`** — DB-backed boolean toggles. Generic.
  The `feature-flags.ts` enum is Trellis-specific; keep that here.
- **`rate-limit.ts` + `database-rate-limiter.ts`** — KV-backed token
  bucket. The shape is generic; the Trellis-specific limits (per-route,
  per-user) layer on top.
- **`net/` IP derivation** — trusted-proxy / Cloudflare / ALB client-IP
  resolution. Easy to get wrong; worth owning once.
- **`tenant-context.ts` + `tenant/`** — multi-tenant scoping (resolver,
  IdP name derivation, tenant-aware auditing). Multi-tenancy is already
  declared a "first-class capability"; the *tenant-resolution layer* is
  generic SaaS infrastructure, not a social-network concern. Probably
  the second-biggest reuse win after the cloud shims.
- **`region-detection.ts` + `region-config.ts`** — data-residency
  routing. Generic if the Trellis feature-flag enum is stripped.

## 3. Worth a second look but probably keep

- **`database-connection-manager.ts`** (660 LOC) — feels heavy. Most of
  it would disappear if Prisma's built-in pool + a small region selector
  were adopted. Don't extract — simplify in place.
- **`validate-request.ts`** — 150 LOC of Zod-at-the-boundary. Fine as
  is; if the router is swapped, it folds into the router's request
  parsing.
- **`hook-dispatcher.ts`** (81 LOC) — too small to be a package; right
  size for in-repo.

## Cross-cutting observation

The strongest signal in this repo is that Trellis carries a complete
**"AWS-backed multi-tenant SaaS starter kit"** underneath the
social-network code: cloud-primitive shims, secrets, sessions, audit,
tenant resolution, region routing, feature toggles. That layer is what
gets re-typed every time a new project starts. If it were pulled out as
one package, Trellis would shrink noticeably and the next backend would
skip several weeks of plumbing.

Suggested order of execution:

1. Cloud shims (`kv`, `queue`, `storage`) — lowest coupling, highest reuse.
2. Secrets + session encryption.
3. Tenant context + audit logger.
4. Replace router with Hono.

Everything else can wait until one of those four lands and the package
boundary is real.
