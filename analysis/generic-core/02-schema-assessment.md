# Schema Coupling Assessment

## Entity Model

The `Entity` model in `prisma/schema.prisma` is the central coupling point.

**Good decisions already made:**
- Named `Entity`, not `Dog`
- Has an `entityType` field (supports multiple types)
- Uses flexible `Json?` metadata (not rigid columns for breed, etc.)
- ActivityPub fields are generic (actorUri, publicKey, etc.)

**Coupling that remains:**
- `entityType` defaults to `'dog'` in validation logic (`validation.ts:242`)
- Application code validates metadata assuming dog shape: `breed`, `birthdate`,
  `breedSize` fields
- Life-stage calculation (`life-stage-calculator.ts`) hardcodes dog-specific
  age thresholds and breed-size multipliers
- The `Follow` model uses `targetType: 'user' | 'dog'` -- not
  `'user' | 'entity'`

## Taxonomy Seed Data

The taxonomy schema (TaxonomyDimension, TaxonomyCategory, TaxonomyTaxon) is
fully generic and tenant-aware (`tenantId` on each model). But the seed data in
`taxonomy-seed.ts` is entirely dog-focused: socialization, service dog training,
agility, reactivity, anxiety.

**Impact:** The schema is ready for multiple domains. The seed data is an
extension concern, not a core concern, but it lives in core code today.

## What Needs to Change

1. Move metadata validation out of core -- each extension defines its own
   metadata schema (Zod) for the `Entity.metadata` JSON field.
2. Change `Follow.targetType` from `'dog'` to `'entity'` (data migration +
   app code update).
3. Move life-stage calculation into the dog extension.
4. Move taxonomy seed data into the dog extension.
5. Make `entityType` default configurable or required (no hardcoded `'dog'`).
