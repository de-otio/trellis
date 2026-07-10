/**
 * Unit tests: events primitive pure seam helpers (seams.ts).
 *
 * `planCompanionPost` (visibility→radius, SEC-2) and `precisionFilteredLocation`
 * (LocationPrecision→exposed fields, SEC-6) are the shared PURE functions the
 * FeedAnnouncer and the detail serializer both rely on. Cover every enum arm
 * plus the defensive exhaustiveness `default` (an unknown enum value must fall
 * through the switch, never crash).
 */

import { describe, expect, it } from "vitest";

import {
  planCompanionPost,
  precisionFilteredLocation,
  type EventLocationSnapshot,
} from "../../../src/lib/events/seams.js";

describe("planCompanionPost", () => {
  it("PUBLIC → SHOUT, no group", () => {
    expect(planCompanionPost("PUBLIC")).toEqual({
      kind: "post",
      radius: "SHOUT",
      groupId: null,
    });
  });

  it("TENANT_ONLY → NORMAL, no group", () => {
    expect(planCompanionPost("TENANT_ONLY")).toEqual({
      kind: "post",
      radius: "NORMAL",
      groupId: null,
    });
  });

  it("GROUP_ONLY → no companion post", () => {
    expect(planCompanionPost("GROUP_ONLY")).toEqual({ kind: "none" });
  });

  it("unknown visibility falls through the exhaustiveness guard", () => {
    // The `default` arm is a compile-time `never` guard; at runtime an
    // out-of-enum value simply returns itself rather than throwing.
    expect(() => planCompanionPost("BOGUS" as never)).not.toThrow();
  });
});

function loc(overrides: Partial<EventLocationSnapshot>): EventLocationSnapshot {
  return {
    precision: "EXACT",
    locationName: "Riverbank",
    lat: 52.5,
    lng: 13.4,
    displayLat: 52.49,
    displayLng: 13.39,
    ...overrides,
  };
}

describe("precisionFilteredLocation", () => {
  it("HIDDEN → nothing", () => {
    expect(precisionFilteredLocation(loc({ precision: "HIDDEN" }))).toEqual({
      label: null,
      lat: null,
      lng: null,
    });
  });

  it("CITY → label only", () => {
    expect(precisionFilteredLocation(loc({ precision: "CITY" }))).toEqual({
      label: "Riverbank",
      lat: null,
      lng: null,
    });
  });

  it("NEIGHBORHOOD → label + fuzzed display coords", () => {
    expect(precisionFilteredLocation(loc({ precision: "NEIGHBORHOOD" }))).toEqual({
      label: "Riverbank",
      lat: 52.49,
      lng: 13.39,
    });
  });

  it("EXACT → label + true coords", () => {
    expect(precisionFilteredLocation(loc({ precision: "EXACT" }))).toEqual({
      label: "Riverbank",
      lat: 52.5,
      lng: 13.4,
    });
  });

  it("unknown precision falls through the exhaustiveness guard", () => {
    expect(() => precisionFilteredLocation(loc({ precision: "BOGUS" as never }))).not.toThrow();
  });
});
