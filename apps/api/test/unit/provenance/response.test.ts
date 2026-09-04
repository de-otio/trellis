import { describe, expect, it } from "vitest";
import {
  attachmentProvenanceView,
  mediaProvenanceView,
  textProvenanceView,
} from "../../../src/lib/provenance/response.js";

describe("provenance response projection", () => {
  describe("textProvenanceView", () => {
    it("projects a declared value with its basis", () => {
      const v = textProvenanceView({
        textSourceType: "AI_ASSISTED",
        textBasis: "AUTHOR_DECLARED",
      });
      expect(v.sourceType).toBe("AI_ASSISTED");
      expect(v.basis).toBe("AUTHOR_DECLARED");
      expect(v.disclosureRequired).toBe(true);
      expect(v.labelKey).toBe("provenance.ai_assisted");
      expect(v.labelDetailKey).toBe("provenance.ai_assisted.detail");
    });

    it("an unselected column degrades to UNKNOWN, never throws", () => {
      // A response site that forgets to select the column must not 500 — but it
      // also must not silently claim human origin.
      const v = textProvenanceView({});
      expect(v.sourceType).toBe("UNKNOWN");
      expect(v.basis).toBeNull();
      expect(v.disclosureRequired).toBe(false);
    });

    it("UNKNOWN is emitted, not omitted", () => {
      // An absent field is indistinguishable from an old client; clients must be
      // able to tell "we don't know" from "we didn't ask".
      const v = textProvenanceView({ textSourceType: "UNKNOWN" });
      expect(v).toHaveProperty("sourceType", "UNKNOWN");
      expect(v).toHaveProperty("labelKey");
    });
  });

  describe("attachmentProvenanceView", () => {
    it("resolves the author declaration against the embedded reading", () => {
      const v = attachmentProvenanceView({
        declaredSourceType: "UNKNOWN",
        declaredBasis: null,
        media: { embeddedSourceType: "AI_GENERATED" },
      });
      expect(v.sourceType).toBe("AI_GENERATED");
      expect(v.basis).toBe("EMBEDDED_METADATA");
    });

    it("an author cannot suppress an embedded AI marking (D10)", () => {
      const v = attachmentProvenanceView({
        declaredSourceType: "HUMAN_CREATED",
        declaredBasis: "AUTHOR_DECLARED",
        media: { embeddedSourceType: "AI_GENERATED" },
      });
      expect(v.sourceType).toBe("AI_GENERATED");
      expect(v.disclosureRequired).toBe(true);
    });

    it("a declaration stands when the bytes say nothing", () => {
      const v = attachmentProvenanceView({
        declaredSourceType: "AI_GENERATED",
        declaredBasis: "AUTHOR_DECLARED",
        media: { embeddedSourceType: "UNKNOWN" },
      });
      expect(v.sourceType).toBe("AI_GENERATED");
      expect(v.basis).toBe("AUTHOR_DECLARED");
    });

    it("tolerates a missing media relation (site did not join it)", () => {
      const v = attachmentProvenanceView({ declaredSourceType: "AI_EDITED" });
      expect(v.sourceType).toBe("AI_EDITED");
    });
  });

  describe("mediaProvenanceView", () => {
    it("uses the intrinsic reading only", () => {
      const v = mediaProvenanceView({ embeddedSourceType: "AI_GENERATED" });
      expect(v.sourceType).toBe("AI_GENERATED");
      expect(v.basis).toBe("EMBEDDED_METADATA");
    });

    it("never exposes a confidence score (D6 anti-oracle)", () => {
      const v = mediaProvenanceView({ embeddedSourceType: "AI_GENERATED" });
      expect(Object.keys(v)).not.toContain("confidence");
    });
  });
});
