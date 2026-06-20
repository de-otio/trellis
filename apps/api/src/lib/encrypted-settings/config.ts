// WS5 — settings-sync runtime config resolution.
//
// env.ts is the SINGLE WRITER of the REALTIME_* env vars (frozen contract §4).
// This module only PROJECTS the already-resolved Env fields into the shape the
// handler needs. It never reads process.env — that would duplicate the env
// reader and defeat the single-writer rule. Thresholds are runtime config with
// defaults already applied in env.ts (CLAUDE.md threshold-secrecy rule 8).

import type { SettingsConfig } from "./types.js";

/** The Env fields this module depends on (structural subset of the real Env). */
export interface SettingsConfigEnv {
  REALTIME_SETTING_NAMESPACES: string[];
  REALTIME_SETTING_MAX_BYTES: number;
}

/**
 * Project the resolved Env into the settings-sync config. An empty namespace
 * allowlist means sync is effectively off (every namespace 404s) — the safe
 * default when a deployment has not opted in.
 */
export function resolveSettingsConfig(env: SettingsConfigEnv): SettingsConfig {
  return {
    allowedNamespaces: new Set(env.REALTIME_SETTING_NAMESPACES),
    maxSettingBytes: env.REALTIME_SETTING_MAX_BYTES,
  };
}
