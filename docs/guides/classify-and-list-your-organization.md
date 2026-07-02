---
title: Classify and list your organization
description: How a tenant admin declares an organization category, controls how much organization content appears in feeds, and opts into the public directory.
sidebar: Classify Your Org
order: 25
---

# Classify and list your organization

This guide walks a tenant **owner or admin** through declaring what kind of
organization a tenant is, and — optionally — making it findable in the
public directory. See [Organization Classification & Directory](../concepts/org-classification-and-directory.md)
for the design behind these features.

## Prerequisites

- You are signed in as a tenant **owner** or **admin** (`classification.edit`
  and `directory.edit` are both `ADMIN`-and-above capabilities).
- You know which category best describes your organization. This release
  ships a small starting set (`business`, `nonprofit`, `community-group`,
  `government`, `educational`, `other`, plus a few illustrative leaves under
  `business`/`nonprofit`) — list the current tree with
  `GET /api/admin/platform-categories` if you're unsure what's available, or
  ask a platform operator to add a category that's missing (see
  **Requesting a new category**, below).

## 1. Declare your organization's category

```http
PUT /api/tenants/{tenantId}/classification
Content-Type: application/json

{ "categoryId": "cat_business_veterinary" }
```

`categoryId` can point anywhere in the category tree — a top-level root
(`business`) or a specific leaf (`business:veterinary`), whichever is
accurate. This is **self-declared** in the current release: there is no
verification step yet, the same trust level the platform already extends to
your display name. Third-party verification (for non-profits, via TechSoup
or Haus des Stiftens) is planned for a future release — declaring now costs
nothing and needs no re-declaration once verification ships.

Add secondary tags for richer directory search (these don't affect feed
filtering, only how your listing surfaces in category search):

```http
POST /api/tenants/{tenantId}/classification/tags
Content-Type: application/json

{ "categoryId": "cat_nonprofit_animal_welfare" }
```

Read your current classification and tags with `GET
/api/tenants/{tenantId}/classification`, available to any tenant member (not
just admins).

## 2. Understand how this affects other people's feeds

Once classified, your posts carry that category into other users' circle
feeds. This is not something you configure — it's how *other* users control
what they see:

- A user viewing their feed can choose to exclude posts from a category
  (e.g., "no business posts") or narrow their view to just one (e.g.,
  "non-profits only"), independent of how close they are to you in their
  circles.
- This has no effect on posts already delivered, and it isn't a ranking
  change — a filtered-out post simply isn't in the result set, same as any
  other feed-view toggle.

There's nothing to opt out of here: classification is what lets *other
users* declutter their own feeds, the same way it lets them find you if
they're specifically looking for an organization like yours.

## 3. (Optional) List your organization in the public directory

Classification alone doesn't make you publicly searchable — that's a
separate, explicit opt-in:

```http
POST /api/tenants/{tenantId}/directory-profile
Content-Type: application/json

{
  "isDiscoverable": true,
  "shortDescription": "Neighborhood veterinary clinic, walk-ins welcome.",
  "lat": 52.5,
  "lng": 13.4,
  "locationLabel": "Berlin, Germany"
}
```

If you don't set `isDiscoverable`, your listing is created but stays
private — useful if you only want classification for feed-filtering and
aren't ready to be found by strangers yet. Update the same resource with
`PATCH /api/tenants/{tenantId}/directory-profile`; read it back with `GET`
(visible only to your own tenant's members, regardless of `isDiscoverable`).

### Choosing a location precision

`locationPrecision` defaults based on your tenant type — `EXACT` for
`ORGANIZATION` tenants (a storefront address is meant to be found
precisely), `CITY` for `PERSONAL` tenants (a home-based freelancer's exact
address isn't exposed by default). You can move it in either direction:

| Precision | What a searcher sees | When to choose it |
|---|---|---|
| `EXACT` | Full address, exact pin | A storefront, office, or anywhere you want to be found precisely |
| `NEIGHBORHOOD` | A fuzzed pin + neighborhood label, never your exact coordinate | You want approximate "near me" discoverability without publishing your exact address |
| `CITY` | City name only, no pin | You want to be found by name/category, but not by proximity search |
| `HIDDEN` | No location shown at all | You want your listing findable only by people who already know your name |

`CITY` and `HIDDEN` aren't just "the pin is hidden" — they genuinely don't
participate in "near me" radius search, by design (see the concept doc's
note on why hiding a coordinate from the response isn't enough on its own).
If you choose `CITY` expecting to still show up in a nearby-businesses
search, you won't — that's the deliberate tradeoff of that precision level,
not a bug.

## Requesting a new category

If none of the existing categories fit, ask a platform operator to add one
via `POST /api/admin/platform-categories` (a `SUPER_ADMIN`-only endpoint in
this release — a self-service, AI-assisted suggestion flow is planned for a
future release). A platform operator deactivating or reparenting a category
later (`POST /api/admin/platform-categories/:id/deactivate` /
`/:id/reparent`) never silently orphans your classification — deactivating a
category that's still in use requires the operator to specify a replacement
category, or the deactivation is rejected.

## Related

- [Organization Classification & Directory](../concepts/org-classification-and-directory.md)
- [Roles and Permissions](../concepts/roles-and-permissions.md)
