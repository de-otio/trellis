---
title: Organization Classification & Directory
description: How Trellis classifies organization tenants, filters feeds by organization category, and lets classified tenants opt into a searchable public directory.
sidebar: Org Classification & Directory
order: 18
---

# Organization Classification & Directory

As organizations join a Trellis-powered platform, two needs pull in opposite
directions: a human's feed shouldn't be crowded out by organization posts
they didn't ask for, and a human who *is* looking for a specific business or
non-profit should be able to find one. Both needs turn out to depend on the
same missing primitive — a representation of **what kind of organization a
tenant is** — which is what this page covers.

## Classification is independent of `TenantType`

`TenantType` (`PERSONAL` | `ORGANIZATION`) answers "does this tenant have one
member or many, and can it federate an IdP" — it says nothing about
commercial nature. A solo freelancer is a `PERSONAL` tenant but is a business
for feed-filtering purposes; a family sharing an account might be
`ORGANIZATION` without being a business or non-profit in any meaningful
sense. Classification is therefore its own model, `TenantClassification`,
applicable to any tenant regardless of type.

## A platform-curated category tree, not a fixed enum

Categories live in `PlatformCategory` — a single, platform-curated,
hierarchical tree (not tenant-scoped), mirroring the shape of the existing
tenant-scoped taxonomy system (`TaxonomyDimension`/`Category`/`Taxon`) but
answering a different question: a tenant-scoped taxonomy lets a tenant tag
*its own* content; a directory search needs one shared vocabulary so "find
all non-profits" means the same thing regardless of which tenant is being
searched.

A tenant's classification can point anywhere in the tree — a root
(`business`) or a specific leaf (`business:veterinary`) — whichever is
accurate. This release ships a small, hand-curated seed set
(`business`, `nonprofit`, `community-group`, `government`, `educational`,
`other`, plus a few illustrative leaves); an AI-assisted, tenant-facing
category-suggestion flow is planned for a future release, fail-closed by
design (a suggestion that would create a new top-level root always requires
platform-operator review, regardless of confidence — only a match to an
existing node, or a threshold-gated new leaf under an already-reviewed
parent, can ever auto-apply).

```prisma
model PlatformCategory {
  id               String  @id @default(cuid())
  code             String  @unique // e.g. "nonprofit", "nonprofit:animal-welfare"
  displayName      String
  parentCategoryId String?
  isActive         Boolean @default(true)
  synonyms         Json?   // alternative search terms
  // ...
}

model TenantClassification {
  id                 String @id @default(cuid())
  tenantId           String @unique
  categoryId         String // may be a root or any leaf
  verificationSource VerificationSource @default(SELF_DECLARED)
  verifiedAt         DateTime?
  verificationRevokedAt DateTime? // a verifier can delist an org after the fact
}

enum VerificationSource {
  SELF_DECLARED
  TECHSOUP           // reserved for a future integration
  HAUS_DES_STIFTENS   // reserved for a future integration
  PLATFORM_MANUAL_REVIEW
}
```

**Self-declared only in this release.** Classification carries the same
trust level as `displayName` today. `VerificationSource` and the
verification timestamps already exist in the schema so that adding real
third-party verification later — TechSoup, Haus des Stiftens, or a manual
platform-operator review — needs no migration. Wherever classification is
shown in the product, the UI must name the source when verified ("Verified
via TechSoup"), never a bare badge with no visible source.

## Feed filtering: a second axis alongside circle tier

[Circle tier](./graph-and-circles.md) answers "how close is this author to
me" and intentionally has nothing to do with organization type — folding
organization category into the scored relationship graph would mean scoring
an org's "closeness," which the entity-centric graph design already rejects
(organizations aren't graph nodes). Organization category is instead a
**second, independent filter predicate**, combinable with tier but not
derived from it.

`Post.authorOrgRootCategoryCode` is resolved and denormalized at
post-creation time (the root ancestor of the author's tenant's
classification — coarse on purpose, so the hot feed-filter path stays a
single indexed-column check even though the category tree can be several
levels deep), using the same pattern already established for
`dataRegion`/`sensitivityLevel`/`contentCategory` on `Post`.

This makes both directions of feed decluttering equally cheap:

- **Subtractive** ("no business posts") — exclude a set of root category
  codes.
- **Inclusive** ("non-profits only") — include only a set of root category
  codes, independent of tier.

Fine-grained category browsing (all `business:veterinary` posts
specifically) is a directory-search concern, not a feed-filter one — the
feed axis only ever operates at root-category granularity.

## The directory: opt-in, separate from classification

A tenant can be classified without being publicly discoverable — a business
that only wants classification for feed-filtering on its own posts, or a
private community that happens to have multiple members, shouldn't
necessarily show up in a public directory search. `TenantDirectoryProfile`
is a separate, explicitly opt-in model (`isDiscoverable`).

```prisma
model TenantDirectoryProfile {
  id                String  @id @default(cuid())
  tenantId          String  @unique
  isDiscoverable    Boolean @default(false)
  shortDescription  String?
  lat               Float?  // true coordinate — always stored, never returned raw below EXACT
  lng               Float?
  displayLat        Float?  // fuzzed/snapped — safe to return at NEIGHBORHOOD precision
  displayLng        Float?
  locationLabel     String? // e.g. "Berlin, Germany"
  locationPrecision LocationPrecision @default(CITY)
}

enum LocationPrecision {
  EXACT        // raw coordinate + full address; participates in "near me" search
  NEIGHBORHOOD // fuzzed pin + neighborhood label; participates in "near me" search
  CITY         // city-level label only, no pin — EXCLUDED from distance-sorted search
  HIDDEN       // no pin, no label — findable by name/category only
}
```

`ORGANIZATION` tenants default to `EXACT` (a storefront address is meant to
be found precisely); `PERSONAL` tenants (a home-based freelancer, a solo
consultant) default to `CITY`. Either can move the setting in either
direction per listing — nobody is locked into their tenant type's default.

### Why `CITY`/`HIDDEN` are excluded from the *query*, not just the response

The obvious-looking design — always rank by the true coordinate, only
withhold it from the API response below `EXACT` — has a real flaw: **the
sort order of a distance-ranked result set leaks the true coordinate even
when the coordinate itself is never returned.** Someone issuing repeated
"near me" queries from a grid of known points can watch when a target
listing enters or exits a radius filter, and where it sits in the
distance-sorted order relative to other results, and triangulate the true
location within a few hundred meters — fully defeating the point of
choosing `CITY` precision.

Trellis closes this by excluding `CITY`/`HIDDEN` rows from the
distance-sorted/radius query path entirely — not merely shaping what the
response returns. A `CITY`-precision listing is reachable through name or
category search, or an explicit "in this city" label match, but never
through a "near me" radius query. `HIDDEN` is excluded from every geo query
path, full stop. Proximity ranking for `EXACT`/`NEIGHBORHOOD` listings is
otherwise unaffected — this only changes what happens for the two precision
levels whose entire purpose is not participating in fine-grained proximity
discovery.

## API Surface

| Route | Method | Notes |
|---|---|---|
| `/api/tenants/:id/classification` | `PUT` | Create/update — requires `classification.edit` (`TenantRole >= ADMIN`) |
| `/api/tenants/:id/classification` | `GET` | Any tenant member |
| `/api/tenants/:id/classification/tags` | `POST` | Add a secondary tag — `classification.edit` |
| `/api/tenants/:id/classification/tags/:tagId` | `DELETE` | Remove a tag — `classification.edit` |
| `/api/tenants/:id/directory-profile` | `POST` / `PATCH` | Create/update — requires `directory.edit` (`TenantRole >= ADMIN`) |
| `/api/tenants/:id/directory-profile` | `GET` | Own-tenant members only |
| `/api/directory/search` | `GET` | Authenticated, rate-limited, name/category/location filters — at least one filter is required (no "list everything" shape) |
| `/api/admin/platform-categories` | `POST` | `SUPER_ADMIN` only — create a category node |
| `/api/admin/platform-categories/:id/deactivate` | `POST` | `SUPER_ADMIN` only — requires `reassignTo` if any tenant is still classified under the node or a descendant |
| `/api/admin/platform-categories/:id/reparent` | `POST` | `SUPER_ADMIN` only |

`classification.edit` and `directory.edit` are ordinary tenant capabilities
(see [Roles and Permissions](./roles-and-permissions.md)); the
`platform-categories` admin routes are gated on the platform-wide
`SUPER_ADMIN` global role, not a tenant capability — curating the shared
category tree is a platform-operator responsibility, not a tenant one.

## What's deliberately not in this release

- **Third-party verification** (TechSoup, Haus des Stiftens) and
  **AI-assisted category self-classification** — the schema anticipates both
  (`VerificationSource`, the fail-closed curation rules above) but neither
  integration ships yet.
- **Org-to-org relationships** (a Verein belonging to a Verband, a subsidiary
  of a parent company, mergers) and **cross-tenant access grants** (one
  organization granting another scoped access to its resources) are fully
  designed but not built — genuinely useful, but built against real demand
  rather than speculatively.
- **Paid directory ranking** is an open question, deliberately left
  undecided rather than defaulted either way.

## Related

- [Entity Graph & Circles](./graph-and-circles.md)
- [Roles and Permissions](./roles-and-permissions.md)
- [Classify and List Your Organization](../guides/classify-and-list-your-organization.md)
