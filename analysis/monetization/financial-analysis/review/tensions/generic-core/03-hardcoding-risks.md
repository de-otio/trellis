# Hardcoding Risks: Monetization Code

Specific ways domain assumptions could leak into monetization code during implementation, and how to prevent each one.

> **Related**: For hardcoding risks in the core social features (Entity model, Follow, feeds, ActivityPub URIs), see [analysis/generic-core/06-gaps.md](../../../../../generic-core/06-gaps.md). This document covers only the monetization-specific risks (action prompts, brand categories, quality scoring, pricing).

---

## Risk 1: Pet-Specific Value Action Types

### How It Happens

A developer implementing the value-action completion flow adds helpful prompts:

```typescript
// BAD: Domain-specific
const prompts: Record<ValueActionType, string> = {
  PRODUCT_REVIEW: "How does your dog like this food?",
  PEER_QA: "Would you recommend this to other dog owners?",
  FEEDBACK_SURVEY: "Rate this pet product on a scale of 1-5",
  ENDORSED_RECOMMENDATION: "Tell other dog fans why you love this brand",
  PRODUCT_PHOTO: "Share a photo of your dog with this product",
};
```

### Prevention

Action prompts must be configurable, not hardcoded. The extension system provides domain-specific templates; the core provides generic defaults:

```typescript
// GOOD: Generic core defaults
const defaultPrompts: Record<ValueActionType, string> = {
  PRODUCT_REVIEW: "Share your experience with this product",
  PEER_QA: "Would you recommend this to others?",
  FEEDBACK_SURVEY: "Rate this product on a scale of 1-5",
  ENDORSED_RECOMMENDATION: "Tell others why you appreciate this brand",
  PRODUCT_PHOTO: "Share a photo featuring this product",
};

// Extension can override:
const prompts = extension.getActionPrompts?.() ?? defaultPrompts;
```

### Detection

Code review should flag any string literal in monetization code that contains "dog", "pet", "food", "vet", "breed", or other domain-specific terms. A lint rule or grep check in CI could catch this.

---

## Risk 2: Pet-Category Brand Enum

### How It Happens

A developer implementing the brand directory adds a category filter:

```typescript
// BAD: Domain-specific enum
enum BrandCategory {
  PET_FOOD = "pet-food",
  PET_ACCESSORIES = "pet-accessories",
  PET_HEALTH = "pet-health",
  PET_INSURANCE = "pet-insurance",
  PET_SERVICES = "pet-services",
}
```

### Prevention

`Brand.category` is a free-form String field. Category values should come from the taxonomy system (which is already tenant-specific with `tenantId`), not from a hardcoded enum:

```typescript
// GOOD: Taxonomy-driven categories
const categories = await prisma.taxonomyCategory.findMany({
  where: { dimensionId: "brand-categories", tenantId },
});
```

### Detection

Any enum or constant named `*Category` in monetization code should be reviewed for domain specificity.

---

## Risk 3: Pet-Industry Brand Verification

### How It Happens

Brand onboarding includes verification checks:

```typescript
// BAD: Domain-specific verification
async function verifyBrand(brand: Brand): Promise<boolean> {
  // Check against pet industry database
  const isPetBrand = await checkPetIndustryRegistry(brand.name);
  // Verify pet product safety certifications
  const hasCertification = await checkFEDIAF(brand.name);
  return isPetBrand && hasCertification;
}
```

### Prevention

Brand verification should check generic legitimacy signals. Domain-specific checks belong in extensions:

```typescript
// GOOD: Generic core verification
async function verifyBrand(brand: Brand): Promise<boolean> {
  const hasWebsite = await checkWebsiteExists(brand.slug);
  const hasBusinessRegistration = brand.metadata?.registrationNumber != null;
  return hasWebsite && hasBusinessRegistration;
}

// Extension can add domain-specific checks:
const extensionChecks = await extension.verifyBrand?.(brand) ?? true;
return coreVerified && extensionChecks;
```

### Detection

Any import of an industry-specific database, registry, or certification API in monetization code should be reviewed.

---

## Risk 4: Pet-Specific Quality Scoring

### How It Happens

The quality scoring algorithm for value actions is trained on pet product review data:

```typescript
// BAD: Calibrated on pet reviews
const MINIMUM_REVIEW_LENGTH = 50; // Based on avg pet food review
const QUALITY_KEYWORDS = ["breed", "size", "age", "health", "vet"];
const SPAM_PATTERNS = [/buy.*cheap.*pet/i, /best.*dog.*food/i];
```

### Prevention

Quality scoring should use generic signals:

```typescript
// GOOD: Generic quality signals
const MINIMUM_REVIEW_LENGTH = 50; // Generic minimum
const qualitySignals = {
  length: text.length >= MINIMUM_REVIEW_LENGTH,
  specificity: containsSpecificDetails(text), // NLP-based, not keyword-based
  helpfulnessVotes: helpfulCount >= 2,
  notSpam: !isGenericSpam(text), // Generic spam detection
};
```

Domain-specific quality signals (e.g., "mentions breed" for pet reviews) should come from extensions.

### Detection

Any hardcoded keyword list or scoring threshold that references domain-specific terms should be flagged.

---

## Risk 5: Pet-Specific Financial Assumptions in Code

### How It Happens

Constants in the codebase reflect pet-industry economics:

```typescript
// BAD: Pet-industry pricing baked into code
const DEFAULT_BRAND_PAYMENT_RATE = 3.00; // Based on pet industry analysis
const PLATFORM_TAKE_RATE = 0.35;
const PREMIUM_UNLOCK_THRESHOLD = 6.99; // Matches pet-vertical premium price
```

### Prevention

Financial constants should come from configuration, not code:

```typescript
// GOOD: Configuration-driven
const { brandPaymentRate, platformTakeRate, premiumUnlockThreshold } =
  await getMonetizationConfig(env);
```

Different verticals might need different pricing. A classic car community might charge $9.99/month premium and have $5-15 brand payment rates. These should be configurable per deployment.

### Detection

Any hardcoded dollar amount or percentage in monetization code should be reviewed and moved to configuration.

---

## Risk 6: Pet-Specific Ambient Attribution

### How It Happens

The Phase 4 attribution engine is built with pet product recognition:

```typescript
// BAD: Pet-specific recognition
const model = await loadModel("pet-product-recognition-v2");
const brands = await model.identifyProducts(image);
```

### Prevention

The attribution engine should have a pluggable model interface:

```typescript
// GOOD: Pluggable model
interface AttributionModel {
  identifyBrands(image: Buffer): Promise<BrandMention[]>;
  identifyBrands(text: string): Promise<BrandMention[]>;
}

// Extension provides the model:
const model = extension.getAttributionModel?.() ?? genericTextOnlyModel;
```

The text-based model (keyword/NER brand detection) is inherently generic. The image model is inherently domain-specific and must be provided by the extension.

### Detection

This is a Phase 4 concern. When Phase 4 is implemented, the model loading mechanism should be reviewed for pluggability.

---

## Implementation Checklist

Use this checklist during code review for any monetization-related PR:

- [ ] No domain-specific string literals (dog, pet, breed, vet, etc.) in monetization code
- [ ] No hardcoded category enums — categories come from taxonomy or configuration
- [ ] No industry-specific verification or certification checks in core code
- [ ] No keyword-based quality scoring with domain-specific terms
- [ ] No hardcoded financial constants — all pricing comes from configuration
- [ ] UI prompts and templates are generic or extension-provided
- [ ] Image analysis (Phase 4) uses pluggable model interface
