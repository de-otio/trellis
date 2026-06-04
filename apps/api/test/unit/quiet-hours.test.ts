import { describe, expect, it } from "vitest";

import { getDefaultQuietHours, isInQuietHours } from "../../src/lib/quiet-hours.js";
import type { QuietHoursConfig } from "../../src/lib/quiet-hours.js";

describe("isInQuietHours", () => {
  it("should return true when time is inside a normal range", () => {
    const config: QuietHoursConfig = {
      quietHoursEnabled: true,
      quietHoursStart: 480, // 08:00
      quietHoursEnd: 720, // 12:00
    };
    expect(isInQuietHours(config, 600)).toBe(true); // 10:00
  });

  it("should return false when time is outside a normal range", () => {
    const config: QuietHoursConfig = {
      quietHoursEnabled: true,
      quietHoursStart: 480,
      quietHoursEnd: 720,
    };
    expect(isInQuietHours(config, 300)).toBe(false); // 05:00
  });

  it("should return true when time is after start in overnight wrap", () => {
    const config: QuietHoursConfig = {
      quietHoursEnabled: true,
      quietHoursStart: 1320, // 22:00
      quietHoursEnd: 420, // 07:00
    };
    expect(isInQuietHours(config, 1350)).toBe(true); // 22:30
  });

  it("should return true when time is before end in overnight wrap", () => {
    const config: QuietHoursConfig = {
      quietHoursEnabled: true,
      quietHoursStart: 1320,
      quietHoursEnd: 420,
    };
    expect(isInQuietHours(config, 300)).toBe(true); // 05:00
  });

  it("should return false when time is between end and start in overnight wrap", () => {
    const config: QuietHoursConfig = {
      quietHoursEnabled: true,
      quietHoursStart: 1320,
      quietHoursEnd: 420,
    };
    expect(isInQuietHours(config, 500)).toBe(false); // 08:20
  });

  it("should return false when quiet hours are disabled", () => {
    const config: QuietHoursConfig = {
      quietHoursEnabled: false,
      quietHoursStart: 480,
      quietHoursEnd: 720,
    };
    expect(isInQuietHours(config, 600)).toBe(false);
  });

  it("should return false when start is null", () => {
    const config: QuietHoursConfig = {
      quietHoursEnabled: true,
      quietHoursStart: null,
      quietHoursEnd: 720,
    };
    expect(isInQuietHours(config, 600)).toBe(false);
  });

  it("should return false when end is null", () => {
    const config: QuietHoursConfig = {
      quietHoursEnabled: true,
      quietHoursStart: 480,
      quietHoursEnd: null,
    };
    expect(isInQuietHours(config, 600)).toBe(false);
  });

  it("should return true when time is exactly at start", () => {
    const config: QuietHoursConfig = {
      quietHoursEnabled: true,
      quietHoursStart: 480,
      quietHoursEnd: 720,
    };
    expect(isInQuietHours(config, 480)).toBe(true);
  });

  it("should return false when time is exactly at end", () => {
    const config: QuietHoursConfig = {
      quietHoursEnabled: true,
      quietHoursStart: 480,
      quietHoursEnd: 720,
    };
    expect(isInQuietHours(config, 720)).toBe(false);
  });
});

describe("getDefaultQuietHours", () => {
  it("should return 20:00-07:00 enabled for CHILD", () => {
    const result = getDefaultQuietHours("CHILD");
    expect(result).toEqual({ start: 1200, end: 420, enabled: true });
  });

  it("should return 22:00-07:00 enabled for TEEN", () => {
    const result = getDefaultQuietHours("TEEN");
    expect(result).toEqual({ start: 1320, end: 420, enabled: true });
  });

  it("should return 23:00-06:00 disabled for ADULT", () => {
    const result = getDefaultQuietHours("ADULT");
    expect(result).toEqual({ start: 1380, end: 360, enabled: false });
  });
});
