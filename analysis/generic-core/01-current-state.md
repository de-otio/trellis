# Current State Overview

## The Goal

A generic social-network core ("Trellis Core") that can be extended with
domain-specific features. The current domain is dogs. A different deployment
could swap in plants, cars, horses, or any other community-forming entity.

## Model Inventory

### Clearly Generic (17 models, ~80% of schema)

User, Post, PostMedia, MediaFile, PostComment, PostCommentMedia, PostSentiment,
CommentSentiment, Follow, Friendship, DirectMessage, Group, GroupMember,
Activity, CustomAudience, CustomAudienceMember, SecurityEvent.

These models have no dog-specific fields or assumptions.

### Domain-Specific (3 models)

- **Entity** -- generic name, but metadata JSON contains `breed`, `birthdate`,
  `breedSize`. The `entityType` field defaults to `'dog'`.
- **PostEntity** -- junction table, inherently generic.
- **EntityTaxonomyTag** -- junction table, inherently generic.

### Taxonomy System (5 models)

The schema is generic (dimensions, categories, taxons). The *seed data* is
dog-specific (behavior, training, breed taxonomy).

### Infrastructure (15 models)

MFA, encryption keys, link checks, feature toggles, upload sessions, etc. Fully
generic.

## Route / Handler Inventory

| Category | Route files | Handler files |
|----------|------------|---------------|
| Generic social | 13 | 14 |
| Domain-specific (dog) | 6 | 4 |
| Media | 5 | 4 |
| ActivityPub | 8 | (in services) |
| Admin / moderation | 3 | 1 |
| Internal / ops | 8 | 2 |

## Verdict

Roughly **75-80% of the code is already domain-agnostic.** The remaining 20% is
concentrated in a small number of files that either contain dog-specific logic
or assume dog-shaped metadata. The separation work is bounded and tractable.
