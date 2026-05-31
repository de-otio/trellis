# On-Device AI: Hybrid Architecture Patterns

**Date:** April 2026
**Question:** What's the right split between on-device and server-side AI? How do we handle device capability differences?

---

## The Core Tension

Fully on-device generation quality (2-5 tokens/sec, limited reasoning with Gemma 2B) is **insufficient** for the nuanced risk assessments BSM requires. But fully server-side processing **undermines the privacy promise** that makes on-device AI valuable.

The answer is hybrid -- but there are several ways to split the work.

---

## Pattern 1: Local Retrieval, Server Generation (Recommended Default)

```
+------------------+       +-------------------+
|   USER'S PHONE   |       |   TRELLIS SERVER  |
|                  |       |                   |
| Posts index      |       |                   |
| Policy index     |       |  LLM (full-size)  |
| Embedding model  |       |                   |
| Vector store     |       |                   |
|                  |       |                   |
| 1. Embed query   |       |                   |
| 2. Retrieve top-k|       |                   |
|    chunks        | ----> | 3. Generate risk  |
|    (only these   |       |    assessment     |
|     leave device)|       |    from chunks    |
|                  | <---- | 4. Return result  |
+------------------+       +-------------------+
```

### Privacy Properties

- The server sees **only the retrieved snippets** (10-20 post excerpts + policy context), not the user's entire history.
- The user can **review what leaves the device** before sending. The approval screen shows exactly which posts/chunks will be transmitted.
- The server never sees the user's embeddings, search queries, or full content index.
- Server logs can be configured to not persist the snippets after generation.

### When to Use

- Full risk assessments with detailed explanations
- Cross-reference analysis that needs sophisticated reasoning
- Any feature where generation quality matters

### Limitations

- Requires network connectivity
- Server cost per assessment
- User must trust that the server handles snippets properly

---

## Pattern 2: Fully On-Device

For users who want **zero server contact** -- offline travel mode, high-risk jurisdictions, or simply maximum privacy.

### Architecture

Same as Pattern 1 but with a local generation model (Gemma 2B Q4 or Phi-3-mini Q4) replacing the server.

### Quality Tradeoffs

| Capability | Server (Claude/GPT-4 class) | On-Device (Gemma 2B Q4) |
|---|---|---|
| Risk classification (risky/neutral/safe) | Excellent | Adequate |
| Nuanced explanation of why content is risky | Excellent | Limited -- may miss subtlety |
| Multi-language content analysis | Excellent | Weak for non-English |
| Cross-platform correlation reasoning | Excellent | Poor -- too complex for small model |
| Policy interpretation | Excellent | Adequate for clear-cut cases |

### When to Use

- User is in a high-risk jurisdiction where network traffic is monitored
- User explicitly opts into offline mode before travel
- Triage-level classification ("3 posts flagged, 0 critical") without detailed explanations
- User can later opt into server-side analysis for full details when safe to do so

---

## Pattern 3: Tiered Approach (Best Overall)

Combines Patterns 1 and 2 with automatic escalation.

```
Tier 1: Instant, On-Device (always available)
├── Fast triage: "3 posts flagged, 0 critical"
├── Uses local model for basic classification
├── No server contact, no latency
├── Runs automatically when user opens travel safety check
└── Result: color-coded risk summary + flagged post list

         │ User taps "Get detailed assessment"
         v

Tier 2: User-Initiated Hybrid (requires network + consent)
├── Local retrieval selects relevant chunks
├── Approval screen: "These 15 post excerpts will be sent for analysis"
├── User reviews, can redact or exclude items
├── Server generates detailed assessment with explanations
└── Result: per-post risk explanations, remediation steps, preparation checklist

         │ User taps "Full security audit" (optional)
         v

Tier 3: Full Server Analysis (requires explicit opt-in)
├── Cross-platform correlation analysis
├── Network graph risk assessment
├── Behavioral pattern analysis
├── Requires more data than on-device can process
└── Result: comprehensive security audit report
```

### Why This Works

- **No waiting:** Tier 1 is instant. User gets actionable information immediately.
- **Progressive disclosure:** Users who want more detail can escalate, with informed consent at each step.
- **Graceful degradation:** If the network is unavailable, Tier 1 still works. If the user doesn't trust the server, they stop at Tier 1.
- **Cost-efficient:** Most users may be satisfied with Tier 1. Only those who need detail hit the server.

---

## Device Capability Gating

Not all phones can run on-device AI. The implementation must degrade gracefully.

| Device Tier | RAM | NPU/GPU | Available Capabilities | Trellis Behavior |
|---|---|---|---|---|
| **Flagship (2024+)** | 8+ GB | Yes | Full on-device RAG + generation | All tiers available. Tier 1 uses local generation |
| **Mid-range** | 4-6 GB | Maybe | On-device retrieval only | Tier 1 uses classification (no generation). Tier 2+ available via server |
| **Low-end / older** | <4 GB | No | No on-device AI | Server-only mode. All analysis server-side with consent flow |

### Detection Strategy

```dart
// Pseudocode for capability detection
enum DeviceAICapability {
  full,           // retrieval + generation
  retrievalOnly,  // embedding + vector search, no generation
  none,           // server-only mode
}

DeviceAICapability detectCapability() {
  final ram = getAvailableRAM();
  final hasNPU = checkNPUAvailability();
  
  if (ram >= 8.0 && hasNPU) return DeviceAICapability.full;
  if (ram >= 4.0) return DeviceAICapability.retrievalOnly;
  return DeviceAICapability.none;
}
```

### UX Implications

- **Don't promise features the device can't deliver.** If the device can't run local generation, don't show "offline travel mode" as an option.
- **Explain why.** "Your device supports on-device content search but needs a server connection for detailed risk analysis. [Learn more]"
- **Don't shame.** Avoid language that makes low-end device users feel insecure. Server-side analysis with proper consent is still valuable.

---

## Model Delivery Strategy

### Option A: Bundle Embedding Model, Download Generation Model

- **Bundle** the embedding model (~80MB) in the app binary. It's small enough and enables retrieval features immediately.
- **Download** the generation model (~1.5GB) on first use of BSM features, on WiFi, with progress indicator.
- **Advantage:** App size stays reasonable (~80MB overhead). Generation model only downloaded by users who need it.
- **Risk:** User may not have WiFi available when they first need BSM. Pre-travel download prompt needed.

### Option B: Download Everything On Demand

- Ship the app with no models bundled.
- Download embedding model on first use of semantic search or BSM.
- Download generation model on first use of offline mode.
- **Advantage:** Minimal app size impact.
- **Risk:** First-use latency. User needs to plan ahead.

### Option C: Platform-Native Where Possible

- **Android:** Use Gemini Nano (no download needed) for generation. Bundle only the embedding model.
- **iOS:** Bundle embedding model. Download Gemma 2B Q4 for generation.
- **Advantage:** Best experience on Android (no large download). Leverages platform capabilities.
- **Risk:** Platform divergence in behavior and quality.

### Recommendation

**Option A** for initial release. Bundle the embedding model (enables the most features with the least overhead), download the generation model on demand. Evaluate Option C later based on Gemini Nano quality benchmarks.

---

## Deeper Investigation Needed

- [ ] Benchmark Tier 1 triage quality: how accurate is Gemma 2B Q4 at classifying posts as risky/neutral/safe for specific countries?
- [ ] Design the Tier 2 approval screen UX -- what information does the user need to make an informed decision about sending data?
- [ ] Measure model download time and storage impact across device tiers
- [ ] Define the capability detection heuristic -- what specific device attributes determine the tier?
- [ ] Evaluate background model download on iOS (iOS restricts background downloads >30s)
- [ ] Test the tier escalation UX with target users -- do they understand the privacy tradeoffs at each tier?

---

**Last Updated:** April 2026
