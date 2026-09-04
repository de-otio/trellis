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

    describe("C2PA manifest summary", () => {
      it("is null when no manifest was kept", () => {
        expect(mediaProvenanceView({ embeddedSourceType: "UNKNOWN" }).c2pa).toBeNull();
      });

      it("is null on a row that predates the sidecar columns", () => {
        // Old rows select as undefined, not false. "No manifest for these
        // bytes" is the correct answer for both.
        expect(mediaProvenanceView({}).c2pa).toBeNull();
      });

      it("projects the stored summary", () => {
        const v = mediaProvenanceView({
          embeddedSourceType: "UNKNOWN",
          c2paManifestPresent: true,
          c2paContainer: "jpeg-app11",
          c2paSidecarKey: "cas/t/h.c2pa",
          c2paSidecarBytes: 4096,
          c2paSidecarSha256: "a".repeat(64),
        });
        expect(v.c2pa).toEqual({
          present: true,
          container: "jpeg-app11",
          sidecarKey: "cas/t/h.c2pa",
          byteLength: 4096,
          sha256: "a".repeat(64),
          verified: false,
        });
      });

      it("reports presence with no bytes when the manifest could not be located", () => {
        const v = mediaProvenanceView({
          c2paManifestPresent: true,
          c2paContainer: "unidentified",
        });
        expect(v.c2pa).toEqual({
          present: true,
          container: "unidentified",
          sidecarKey: null,
          byteLength: null,
          sha256: null,
          verified: false,
        });
      });

      it("NEVER reports verified — there is no code path that can set it true", () => {
        // Trellis extracts the manifest and does not check its signature. A
        // client rendering "Content Credentials verified" from this object
        // would be publishing a claim the platform never made.
        for (const container of ["jpeg-app11", "png-cabx", "unidentified"]) {
          const v = mediaProvenanceView({
            c2paManifestPresent: true,
            c2paContainer: container,
            c2paSidecarKey: "cas/t/h.c2pa",
          });
          expect(v.c2pa?.verified).toBe(false);
        }
      });

      it("does not leak a manifest summary onto text or attachment views", () => {
        // The C2PA summary belongs to the bytes, so it lives on the media view
        // only. Text has no container to carry a manifest.
        expect(
          Object.keys(textProvenanceView({ textSourceType: "AI_EDITED" })),
        ).not.toContain("c2pa");
        expect(
          Object.keys(attachmentProvenanceView({ declaredSourceType: "AI_EDITED" })),
        ).not.toContain("c2pa");
      });
    });
  });
});
