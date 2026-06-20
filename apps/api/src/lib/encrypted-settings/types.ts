// WS5 — encrypted-settings state-sync types.
//
// The blob/store contract is OWNED by the frozen WS1 realtime contract
// (apps/api/src/lib/realtime/types.ts). We re-export the frozen shapes here so
// the encrypted-settings module has a single import surface and can NEVER drift
// from WS1. Do not redefine EncryptedBlob/PutResult/SettingStore — import them.

import type {
  EncryptedBlob,
  PutResult,
  SettingStore,
  ChangedSettingMeta,
  ChangeCursorStore,
} from "../realtime/types.js";

export type {
  EncryptedBlob,
  PutResult,
  SettingStore,
  ChangedSettingMeta,
  ChangeCursorStore,
};

/**
 * Resolved runtime configuration for the settings-sync surface. Sourced ONLY
 * from env (REALTIME_SETTING_NAMESPACES + REALTIME_SETTING_MAX_BYTES, read in
 * env.ts which is the single writer). No compiled-in thresholds at call sites
 * (CLAUDE.md threshold-secrecy rule).
 */
export interface SettingsConfig {
  /** Allowlisted namespaces. A namespace outside this set is a 404. */
  allowedNamespaces: ReadonlySet<string>;
  /** Max bytes for a single ciphertext blob; exceeded => 413. */
  maxSettingBytes: number;
}

/** Raised when a request names a namespace not in the allowlist. */
export class UnknownNamespaceError extends Error {
  constructor(public readonly namespace: string) {
    super(`Unknown setting namespace: ${namespace}`);
    this.name = "UnknownNamespaceError";
  }
}

/** Raised when a ciphertext blob exceeds the configured size cap. */
export class BlobTooLargeError extends Error {
  constructor(
    public readonly bytes: number,
    public readonly maxBytes: number,
  ) {
    super(`Encrypted setting blob too large: ${bytes} > ${maxBytes} bytes`);
    this.name = "BlobTooLargeError";
  }
}
