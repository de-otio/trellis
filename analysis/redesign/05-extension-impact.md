# 05 — Extension Architecture Impact

How the circles-based redesign affects verticals built on Trellis.

---

## What Stays the Same

The extension architecture's **structural mechanisms** survive the redesign:

- **TrellisExtension interface**: Extensions still register with an ID, routes, metadata schema, hooks, etc.
- **ExtensionContext**: Scoped database access, config isolation, lifecycle management
- **Route wrapping**: Core still wraps extension routes with auth, CORS, security headers, error handling
- **Hook system**: 5-second timeout, circuit breaker, async execution
- **Discovery**: Static imports in `extensions.ts`

Extensions don't directly query `Follow` or build feeds — they use core APIs and hook points. So the internal replacement of Follow with Relationship doesn't break extension code structurally.

---

## What Changes

### 1. `FeedStrategy` Interface → `CircleStrategy` (or removed)

**Current**: Extensions can provide a `FeedStrategy` to customize feed ranking.

```typescript
// Current
interface FeedStrategy {
  rank(posts: Post[], context: FeedContext): Post[];
}
```

**New**: Circles are chronological within a tier. There's no ranking to customize. The extension's influence on content ordering is reduced to:

- **Content enrichment** (already exists via hooks): Add metadata to posts when displayed
- **Relationship scoring inputs** (new): Extensions can contribute signals to the score computation

Options:
1. **Remove `FeedStrategy` entirely** — circles are opinionated about no algorithmic ranking. Extensions shouldn't be able to reintroduce it.
2. **Replace with `RelationshipSignalProvider`** — extensions can contribute domain-specific signals to the score algorithm (e.g., "these two users co-own a dog" → relationship boost).

**Recommendation**: Option 2. The extension can't change the circle structure, but it can inform the relationship score with domain-specific data.

```typescript
// New
interface RelationshipSignalProvider {
  /** Return a score modifier (-0.5 to +0.5) for this relationship */
  computeSignal(
    userId: string,
    targetType: string,
    targetId: string,
    context: SignalContext,
  ): Promise<number | null>;
}
```

For entity-centric verticals, `RelationshipSignalProvider` is especially important — it lets extensions contribute domain-specific signals for user→entity scoring. Examples:
- Dog extension: breed similarity boost, shared dog park frequency, co-owned dog proximity
- Plant extension: same garden boost, same species boost
- Car extension: same model boost, same rally group

The scoring formula differs for entity targets (engagement depth replaces reciprocity, decay is slower). See [Trellis scoring without reciprocity](../../trellis/analysis/redesign/06-entities-over-people/09-scoring-without-reciprocity.md).

### 2. `RecommendationStrategy` → Unchanged but recontextualized

Recommendations ("people you might want to connect with") still make sense. But the output changes:
- **Before**: "Follow this user"
- **After**: "Add this person to your graph" (they start in the community/ambient tier)

The strategy interface itself doesn't need to change — it returns candidate user/entity IDs. The core handles how those recommendations are presented.

### 3. Extension Hooks — New hooks needed

**Existing hooks that survive unchanged:**
- `onPostCreated` — still fires when a post is created
- `onEntityCreated` — still fires
- `onPostDeleted` — still fires

**New hooks:**

```typescript
interface ExtensionHooks {
  // ... existing hooks ...

  /** Fired when a relationship is created. Extension can provide initial score signal. */
  onRelationshipCreated?: (event: {
    userId: string;
    targetType: string;
    targetId: string;
    connectionMethod: string;
  }) => Promise<{ scoreModifier?: number } | void>;

  /** Fired when relationship scores are recomputed. Extension provides domain signal. */
  onScoreRecompute?: (event: {
    userId: string;
    targetType: string;
    targetId: string;
  }) => Promise<{ scoreModifier?: number } | void>;
}
```

### 4. Extension Database Access (`ExtensionDb`)

**Current**: Extensions have scoped access to `entity`, `post`, `postEntity`, `follow`, `taxonomy`, `activity`.

**Change**: Replace `follow` with `relationship` in the scoped access.

```typescript
// Current
interface ExtensionDb {
  entity: PrismaClient['entity'];
  post: PrismaClient['post'];
  postEntity: PrismaClient['postEntity'];
  follow: PrismaClient['follow'];        // REMOVE
  taxonomy: PrismaClient['taxonomyTaxon'];
  activity: PrismaClient['activity'];
}

// New
interface ExtensionDb {
  entity: PrismaClient['entity'];
  post: PrismaClient['post'];
  postEntity: PrismaClient['postEntity'];
  relationship: PrismaClient['relationship'];  // ADD (read-only)
  taxonomy: PrismaClient['taxonomyTaxon'];
  activity: PrismaClient['activity'];
}
```

**Important**: Extension access to `relationship` should be **read-only**. Extensions can read relationship data (e.g., "is this user related to the entity owner?") but cannot modify scores or create/delete relationships. That's a core concern.

---

## Impact on the Dog Extension (Trellis)

The dog extension currently:
1. Provides a `FeedStrategy` for dog-specific feed personalization
2. Validates entity metadata (breed, age, etc.)
3. Seeds taxonomy data (breeds, activities)
4. Enriches ActivityPub actors with dog-specific fields

After the redesign:
1. **`FeedStrategy` removed** — replaced by `RelationshipSignalProvider` that boosts scores between users who co-own dogs, frequent the same dog parks, or have similar breeds
2. **Metadata validation** — unchanged
3. **Taxonomy seeding** — unchanged
4. **ActivityPub enrichment** — unchanged (if federation continues)

### Dog-specific relationship signals

The dog extension could provide meaningful relationship signals:

```typescript
// Example: dog extension's RelationshipSignalProvider
async computeSignal(userId, targetType, targetId, context) {
  if (targetType !== 'user') return null;

  const sharedDogParks = await countSharedDogParks(userId, targetId);
  const coOwnedDogs = await countCoOwnedEntities(userId, targetId);
  const breedOverlap = await computeBreedSimilarity(userId, targetId);

  // Each factor contributes a small boost
  let modifier = 0;
  if (coOwnedDogs > 0) modifier += 0.2;       // Strong signal
  if (sharedDogParks > 2) modifier += 0.1;     // Moderate signal
  if (breedOverlap > 0.5) modifier += 0.05;    // Weak signal

  return Math.min(modifier, 0.3); // Cap total extension contribution
}
```

---

## Impact on Future Verticals

Any vertical built on Trellis inherits the circles model automatically. The extension doesn't need to implement social graph logic — it just:

1. Defines its entity type and metadata schema
2. Optionally provides `RelationshipSignalProvider` for domain-specific score modifiers
3. Optionally provides `RecommendationStrategy` for discovery
4. Registers routes for domain-specific features

The core handles: relationships, circles, posting radius, read state, "caught up" signals.

This is a stronger extension model than the current one — the core does more, and extensions focus purely on domain logic.

---

## Migration Effort for Extensions

| Area | Effort | Description |
|------|--------|-------------|
| Remove `FeedStrategy` | Low | Delete the implementation, remove from extension registration |
| Add `RelationshipSignalProvider` | Medium | New code, but simple interface. Can be deferred. |
| Update `ExtensionDb` usage | Low | Replace `follow` references with `relationship` |
| Update extension routes | Low | Any routes that query follows need to query relationships instead |
| Update tests | Medium | Feed-related tests need rewriting for circle queries |
