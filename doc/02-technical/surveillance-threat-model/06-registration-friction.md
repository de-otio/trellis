# Gap: Registration Friction

## The gap

AI agents make account farming approximately free
([01 §3](./01-threat-landscape.md#3-avatar-infiltration--ai-agent-driven-fake-accounts)
— Blackscore advertises "operational 24 hours after deployment"). Trellis's
current signup friction is thin:

- **reCAPTCHA only on invitation signup, and only when configured** —
  enforced solely if `RECAPTCHA_SECRET_KEY` is set
  (`apps/api/src/lib/invitation-handler.ts`, `apps/api/src/lib/recaptcha.ts`).
- **No mandatory email verification** — magic-link auth exists, but email
  validation is not a required gate.
- **No signup throttling** by email domain, IP, or temporal pattern —
  endpoint rate limits exist, but nothing watches for "40 accounts from the
  same disposable-mail domain in an hour."
- WAF Bot Control is monitored (`apps/api/src/lib/abuse-metrics.ts`) but
  only warns if not enabled — it's an infrastructure-level option, not a
  platform guarantee.

## Proposal: per-tenant configurable signup friction

This fits the multi-tenant config model — different verticals and tenants
have legitimately different friction tolerances (a closed B2B tenant
provisions via IdP/JIT and may want public signup off entirely; a consumer
community wants low friction):

| Control | Default | Notes |
|---|---|---|
| Email verification required | **on** | Cheap, standard, breaks naive farming |
| CAPTCHA on signup | on when key configured | Today's behavior, but extended beyond invitations to all self-service signup |
| Signup velocity limit (per IP / per email domain) | on, generous | Distributed token-bucket infra already exists (`apps/api/src/lib/rate-limit.ts`) |
| Disposable-email-domain policy | off | Optional list-based block/flag; flag (not block) by default if enabled |
| Public signup enabled | per tenant | B2B tenants with IdP federation can disable self-service signup entirely |

Design notes:

- **Friction is a signal source, not just a gate.** Signups that barely pass
  (velocity near the limit, flagged email domain) are exactly the accounts
  the [coordinated-behavior signals](./03-coordinated-inauthentic-behavior.md)
  should weight higher. Record the signals at signup time.
- **Don't overcorrect.** Heavy friction harms exactly the at-risk users this
  threat model cares about (pseudonymous users can't pass identity
  verification — and identity verification would itself create a
  compellable data trove, see [07-data-minimization.md](./07-data-minimization.md)).
  The goal is raising the cost of *farms*, not of individual pseudonymous
  accounts.
