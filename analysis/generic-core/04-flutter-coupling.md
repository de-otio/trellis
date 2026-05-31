# Flutter Frontend Coupling

## Current State

The Flutter app has a feature module at `apps/flutter/lib/features/dog_profiles/`
containing ~19 files:

- Data sources, repositories, entities, use cases, pages, widgets
- Class names: `DogProfile`, `DogProfileModel`, `CreateDogProfileUsecase`
- Route paths: `/dogs`, `/dogs/:id`
- Hardcoded `'entityType': 'dog'` in the remote data source

## Assessment

The coupling is **superficial, not structural.** The Flutter code calls generic
API endpoints (`/api/entities`) and receives generic `Entity` responses. The
dog-specificity is in:

1. Naming (folder, classes, variables)
2. UI copy and labels
3. Metadata field rendering (breed, breed size selectors)
4. The hardcoded `entityType: 'dog'` filter

## What Needs to Change

For a generic core:
- Rename `dog_profiles/` to `entity_profiles/` (or keep it as a domain module)
- Extract entity-type-specific UI widgets (breed selector, life stage display)
  into a domain module
- Make entity type a configuration parameter, not a hardcoded string
- UI copy should come from the terminology service, not hardcoded strings

The underlying architecture (Riverpod, feature folders, clean architecture
layers) is already well-suited for this. The work is renaming and extracting,
not redesigning.
