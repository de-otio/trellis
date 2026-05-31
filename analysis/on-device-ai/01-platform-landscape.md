# On-Device AI: Platform Landscape

**Date:** April 2026
**Question:** What do Apple and Google provide for on-device AI that Trellis can use in a Flutter app?

---

## Apple (iOS 18+ / macOS 15+)

| Capability | API | Notes |
|---|---|---|
| Apple Intelligence (~3B param model) | **Not accessible to third-party apps** | Powers system Writing Tools, Smart Reply, notification summaries -- no public API for custom prompts |
| Text classification, NER, sentiment | `NaturalLanguage.framework` | Lightweight, on-device, available to all apps. Good for triage-level classification |
| Semantic text embeddings | `NaturalLanguage.framework` | Built-in embeddings usable for similarity/vector search |
| Custom model deployment | Core ML | Convert PyTorch/TF models to `.mlmodel`, runs on Neural Engine/GPU/CPU |
| Custom text classifiers | Create ML + Core ML | Train on Mac, deploy on-device |

### Key Limitation

Apple's on-device LLM is a walled garden. Third-party apps **cannot** call Apple Intelligence for custom text generation, summarization, or classification. We must bring our own model via Core ML for anything beyond the built-in NLP APIs.

### What's Useful for Trellis

- **NaturalLanguage framework** provides free, zero-overhead text embeddings and classification on iOS. Usable for the retrieval half of RAG without bundling any model.
- **Core ML** is the path for running custom models (quantized Gemma, Phi, etc.) on Apple hardware. Well-optimized for Neural Engine.
- **Create ML** could train lightweight, Trellis-specific classifiers (e.g., "is this post about a protest?") with small labeled datasets.

---

## Google (Android 14+/15+)

| Capability | API | Notes |
|---|---|---|
| Gemini Nano (multi-billion params) | AICore API via Google Play Services | **Available to third-party developers.** Summarization, smart reply, rewriting, basic reasoning |
| Custom LLM inference | MediaPipe LLM Inference API | Run Gemma 2B, Phi-3, etc. on-device via GPU/CPU delegates. Works on iOS too |
| Entity extraction, smart reply | ML Kit | Functional but not LLM-grade |
| On-device translation | ML Kit | 50+ languages, no server required |

### Key Advantage

Gemini Nano is directly accessible to third-party apps through Google Play Services -- no need to bundle a model. This is a significant asymmetry with Apple.

### What's Useful for Trellis

- **Gemini Nano** provides real text generation/reasoning on Android with zero bundling cost. Could power risk assessment summaries, content warnings, and smart replies.
- **MediaPipe LLM Inference** works cross-platform (Android + iOS) and supports open models (Gemma, Phi). This is the escape hatch when we need consistent behavior across platforms.
- **ML Kit translation** -- useful for analyzing posts in multiple languages without server calls.

---

## Cross-Platform Options (Flutter)

| Approach | How | Practical for Trellis? |
|---|---|---|
| **llama.cpp via FFI** | Flutter packages (`flutter_llama`, `lcpp_llm`) wrapping C++ inference. Runs GGUF-quantized models (Gemma 2B, Phi-3-mini) | Yes -- 1-4B param Q4 models need 1-3 GB RAM, feasible on modern phones |
| **ONNX Runtime Mobile** | Run embedding/classification models via ONNX on both platforms | Yes -- ideal for embedding models (80-150MB) |
| **MediaPipe Flutter** | Google's `mediapipe` Dart packages | Maturing -- LLM inference support available but less polished than native |
| **Platform channels** | Use native APIs (Core ML on iOS, AICore on Android) from Flutter | Most mature path for platform-specific models |

### Recommended Cross-Platform Strategy

The platform asymmetry (Google exposes Gemini Nano; Apple doesn't expose Apple Intelligence) creates a decision point:

**Option A: Standardize on llama.cpp**
- Same model (Gemma 2B Q4) on both platforms
- Consistent behavior, single codebase
- Must bundle ~1.5 GB model on both platforms

**Option B: Platform-native where possible**
- Gemini Nano on Android (free, no bundling)
- llama.cpp with Gemma on iOS (must bundle model)
- Different capabilities per platform; more complex code

**Option C: Hybrid**
- ONNX Runtime for embeddings (cross-platform, small models)
- Platform channels for generation (Gemini Nano on Android, Core ML + quantized model on iOS)
- Best performance per platform, highest implementation complexity

For embedding models (the retrieval half of RAG), **ONNX Runtime** is the clear cross-platform choice. For generation, the decision depends on how much platform divergence is acceptable.

---

## Deeper Investigation Needed

- [ ] Benchmark Gemini Nano vs. Gemma 2B Q4 on representative BSM tasks (risk classification, content summarization)
- [ ] Test Apple NaturalLanguage embeddings quality for policy document retrieval vs. MiniLM/BGE
- [ ] Evaluate Flutter package maturity: `flutter_llama` vs. `mediapipe` for production readiness
- [ ] Measure cold-start latency for model loading on mid-range devices
- [ ] Assess App Store / Play Store policies on bundling large models (app size limits, on-demand download)

---

**Last Updated:** April 2026
