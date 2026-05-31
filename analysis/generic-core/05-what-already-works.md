# What Already Works Toward the Goal

Several design decisions already support a generic core. These should be
preserved and built upon.

## 1. Entity Model (not Dog Model)

The database model is named `Entity` with an `entityType` field and flexible
`Json?` metadata. This was an intentional step toward generality. The comment
in the schema says "replaces Dog model."

## 2. Terminology Service

`apps/api/src/lib/terminology.ts` provides a `getTerminology(tenantId?)`
function that returns display terms (`entity: "dog"`, `entityPlural: "dogs"`).
It currently returns hardcoded defaults but is explicitly designed for
multi-tenant white-labeling. The infrastructure is in place; it just needs a
database table.

## 3. Polymorphic Follow Model

The `Follow` model uses `targetType` + `targetId` instead of direct foreign
keys. This already supports following both users and entities. Extending to new
entity types requires no schema change.

## 4. Tenant-Aware Taxonomy

`TaxonomyDimension`, `TaxonomyCategory`, and `TaxonomyTaxon` all include a
`tenantId` field. Different tenants (deployments) can have entirely different
taxonomy trees. The schema is ready for multi-domain use.

## 5. Middleware Composition

Routes declare middleware as arrays (`[corsMiddleware(), csrfMiddleware()]`).
This is the one truly pluggable layer -- middleware can be mixed per route
without touching core code.

## 6. Feature Toggles

The `FeatureToggle` model and `FeatureToggleService` exist and support runtime
feature flags. Although handlers don't currently use them, the plumbing is
there.

## 7. Region-Aware Data Routing

The `DataRouter` class abstracts database access by region. This pattern
(abstracting infrastructure behind a service) is exactly what's needed for
domain logic too.

## 8. ActivityPub on Entity

Both `User` and `Entity` have full ActivityPub fields (actorUri, publicKey,
inbox, outbox). Federation is entity-type-agnostic at the data level -- only
the dispatcher code is dog-specific.
