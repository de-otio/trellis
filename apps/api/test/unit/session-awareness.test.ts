import { describe, expect, it } from "vitest";

import {
  getSessionNudge,
  getSessionThresholds,
} from "../../src/lib/session-awareness.js";

describe("getSessionThresholds", () => {
  it("should return correct thresholds for CHILD", () => {
    expect(getSessionThresholds("CHILD")).toEqual({
      firstNudgeMinutes: 15,
      secondNudgeMinutes: 25,
      hardLimitMinutes: 30,
    });
  });

  it("should return correct thresholds for TEEN", () => {
    expect(getSessionThresholds("TEEN")).toEqual({
      firstNudgeMinutes: 30,
      secondNudgeMinutes: 50,
      hardLimitMinutes: null,
    });
  });

  it("should return correct thresholds for ADULT", () => {
    expect(getSessionThresholds("ADULT")).toEqual({
      firstNudgeMinutes: 60,
      secondNudgeMinutes: null,
      hardLimitMinutes: null,
    });
  });
});

describe("getSessionNudge", () => {
  it("should return null for CHILD under first nudge threshold", () => {
    expect(getSessionNudge(10, "CHILD")).toBeNull();
  });

  it("should return first time_reminder for CHILD at 15 minutes", () => {
    const nudge = getSessionNudge(15, "CHILD");
    expect(nudge).toEqual({
      type: "time_reminder",
      message: "You've been browsing for 15 minutes. Consider taking a break!",
      sessionMinutes: 15,
    });
  });

  it("should return second time_reminder for CHILD at 25 minutes", () => {
    const nudge = getSessionNudge(25, "CHILD");
    expect(nudge).toEqual({
      type: "time_reminder",
      message: "You've been browsing for 25 minutes. Time for a break.",
      sessionMinutes: 25,
    });
  });

  it("should return session_limit for CHILD at 30 minutes", () => {
    const nudge = getSessionNudge(30, "CHILD");
    expect(nudge).toEqual({
      type: "session_limit",
      message:
        "You've reached your session limit of 30 minutes. Come back later!",
      sessionMinutes: 30,
    });
  });

  it("should return null for TEEN under first nudge threshold", () => {
    expect(getSessionNudge(20, "TEEN")).toBeNull();
  });

  it("should return first time_reminder for TEEN at 30 minutes", () => {
    const nudge = getSessionNudge(30, "TEEN");
    expect(nudge).toEqual({
      type: "time_reminder",
      message: "You've been browsing for 30 minutes. Consider taking a break!",
      sessionMinutes: 30,
    });
  });

  it("should return second time_reminder for TEEN at 50 minutes", () => {
    const nudge = getSessionNudge(50, "TEEN");
    expect(nudge).toEqual({
      type: "time_reminder",
      message: "You've been browsing for 50 minutes. Time for a break.",
      sessionMinutes: 50,
    });
  });

  it("should return null for ADULT under first nudge threshold", () => {
    expect(getSessionNudge(50, "ADULT")).toBeNull();
  });

  it("should return first time_reminder for ADULT at 60 minutes", () => {
    const nudge = getSessionNudge(60, "ADULT");
    expect(nudge).toEqual({
      type: "time_reminder",
      message: "You've been browsing for 60 minutes. Consider taking a break!",
      sessionMinutes: 60,
    });
  });
});
