import { describe, expect, it } from "vitest";
import { resolveSettingsConfig } from "../../src/lib/encrypted-settings/config.js";

describe("resolveSettingsConfig", () => {
  it("projects Env fields into the SettingsConfig shape", () => {
    const config = resolveSettingsConfig({
      REALTIME_SETTING_NAMESPACES: ["feed_filters", "read_state"],
      REALTIME_SETTING_MAX_BYTES: 12345,
    });
    expect(config.maxSettingBytes).toBe(12345);
    expect(config.allowedNamespaces.has("feed_filters")).toBe(true);
    expect(config.allowedNamespaces.has("read_state")).toBe(true);
    expect(config.allowedNamespaces.has("unknown")).toBe(false);
  });

  it("an empty allowlist means every namespace is disallowed (sync off)", () => {
    const config = resolveSettingsConfig({
      REALTIME_SETTING_NAMESPACES: [],
      REALTIME_SETTING_MAX_BYTES: 65536,
    });
    expect(config.allowedNamespaces.size).toBe(0);
  });

  it("treats the reserved __keyring namespace as an ordinary allowed namespace (Track A)", () => {
    // env.ts injects `__keyring` into REALTIME_SETTING_NAMESPACES (single-writer);
    // resolveSettingsConfig gives it no special handling — it is just allowlisted.
    const config = resolveSettingsConfig({
      REALTIME_SETTING_NAMESPACES: ["feed_filters", "__keyring"],
      REALTIME_SETTING_MAX_BYTES: 65536,
    });
    expect(config.allowedNamespaces.has("__keyring")).toBe(true);
  });
});
