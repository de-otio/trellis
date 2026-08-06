/**
 * Fedify Converters
 *
 * Helper functions to convert Fedify types to database/storage formats.
 * These conversions are necessary because the database schema expects plain objects,
 * but all ActivityPub serialization and creation uses Fedify types.
 */

import { Create, Note } from "@fedify/fedify/vocab";
import type { ActivityStreamsActivity } from "../activity-service.js";
import {
  provenanceToJsonLd,
  withProvenanceContext,
} from "../provenance-jsonld.js";
import type { Provenance } from "../../provenance/types.js";

/**
 * Data extracted from Fedify Create activity for conversion
 */
export interface CreateActivityData {
  id: string;
  actor: string;
  published: string;
  to?: string[];
  cc?: string[];
  bto?: string[];
  bcc?: string[];
  object: {
    id: string;
    attributedTo: string;
    content: string;
    published: string;
    to?: string[];
    cc?: string[];
    bto?: string[];
    bcc?: string[];
    /**
     * Synthetic-content provenance of the post text (AI Act Art. 50).
     *
     * Threaded through the extracted-data shape rather than read off the Fedify
     * `Note` because Fedify's vocab classes are typed and drop properties they do
     * not know — an extension term set with `(note as any).x = …` is not
     * guaranteed to survive its serialization. This plain object IS the outbound
     * payload we control, so carrying it here is what actually reaches the wire.
     */
    provenance?: Provenance | null;
  };
}

/**
 * Extract data from Fedify Create activity
 * This makes the converter more testable by separating extraction from conversion
 *
 * Since Fedify doesn't expose properties directly, we pass the known values
 */
export function extractCreateActivityData(
  activity: Create,
  note: Note,
  actorUri: string,
  activityId: string,
  noteId: string,
  provenance?: Provenance | null,
): CreateActivityData {
  // Helper to convert recipient arrays
  const convertRecipients = (
    recipients: any[] | undefined,
  ): string[] | undefined => {
    if (!recipients || !Array.isArray(recipients)) return undefined;
    return recipients.map((r: any) => {
      if (typeof r === "string") return r;
      if (r instanceof URL) return r.toString();
      return String(r);
    });
  };

  // Helper to convert published date (Temporal.Instant or Date) to ISO string
  const publishedToString = (value: any): string => {
    if (!value) return new Date().toISOString();
    // Handle Temporal.Instant (has epochSeconds property)
    if (value && typeof value === "object" && "epochSeconds" in value) {
      // Temporal.Instant.toString() returns ISO 8601 format
      return value.toString();
    }
    // Handle Date objects
    if (typeof value.toISOString === "function") {
      return value.toISOString();
    }
    // Fallback
    return new Date().toISOString();
  };

  const activityAny = activity as any;
  const noteAny = note as any;

  return {
    id: activityId,
    actor: actorUri,
    published: publishedToString(activityAny.published),
    to: convertRecipients(activityAny.to),
    cc: convertRecipients(activityAny.cc),
    bto: convertRecipients(activityAny.bto),
    bcc: convertRecipients(activityAny.bcc),
    object: {
      id: noteId,
      attributedTo: actorUri, // Note's attributedTo is the same as activity's actor
      content: noteAny.content || "",
      published: publishedToString(noteAny.published),
      to: convertRecipients(noteAny.to),
      cc: convertRecipients(noteAny.cc),
      bto: convertRecipients(noteAny.bto),
      bcc: convertRecipients(noteAny.bcc),
      provenance: provenance ?? null,
    },
  };
}

/**
 * Convert extracted Create activity data to ActivityStreamsActivity format
 * This is the testable core function - extraction is separate
 */
export function createActivityDataToActivityStreams(
  data: CreateActivityData,
): ActivityStreamsActivity {
  // Art. 50: the provenance terms and the `@context` entry that defines them.
  // Both are empty/unchanged when the provenance is UNKNOWN, so an undeclared
  // post's JSON-LD is byte-identical to what it was before this existed.
  const provenanceProps = provenanceToJsonLd(data.object.provenance);
  const hasProvenance = Object.keys(provenanceProps).length > 0;

  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    type: "Create",
    id: data.id,
    actor: data.actor,
    published: data.published,
    object: {
      // The extension context goes on the OBJECT, where the terms are, not on the
      // activity: a relaying instance may forward the object alone, and a term
      // whose definition stayed behind on the wrapper is an undefined term.
      "@context": hasProvenance
        ? withProvenanceContext("https://www.w3.org/ns/activitystreams")
        : "https://www.w3.org/ns/activitystreams",
      type: "Note",
      id: data.object.id,
      attributedTo: data.object.attributedTo,
      content: data.object.content,
      published: data.object.published,
      ...(data.object.to && { to: data.object.to }),
      ...(data.object.cc && { cc: data.object.cc }),
      ...(data.object.bto && { bto: data.object.bto }),
      ...(data.object.bcc && { bcc: data.object.bcc }),
      ...provenanceProps,
    },
    ...(data.to && { to: data.to }),
    ...(data.cc && { cc: data.cc }),
    ...(data.bto && { bto: data.bto }),
    ...(data.bcc && { bcc: data.bcc }),
  };
}

/**
 * Convert Fedify Create activity to ActivityStreamsActivity format for database storage
 *
 * This is necessary because the database schema stores activities as plain JSON objects.
 * All ActivityPub operations use Fedify types, but storage requires plain objects.
 */
export function fedifyCreateToActivityStreams(
  activity: Create,
  note: Note,
  actorUri: string,
  activityId: string,
  noteId: string,
  provenance?: Provenance | null,
): ActivityStreamsActivity {
  const data = extractCreateActivityData(
    activity,
    note,
    actorUri,
    activityId,
    noteId,
    provenance,
  );
  return createActivityDataToActivityStreams(data);
}
