import { beforeEach, describe, expect, it, vi } from "vitest";
import { EncryptedSettingsHandler } from "../../src/lib/encrypted-settings/encrypted-settings-handler.js";
import type { SettingsConfig } from "../../src/lib/encrypted-settings/types.js";
import type {
  EncryptedBlob,
  PutResult,
  RealtimeTransport,
  SettingStore,
} from "../../src/lib/realtime/types.js";
import { decodeWakeup } from "../../src/lib/realtime/types.js";

const NS = "feed_filters";
const USER = "user-1";
const TENANT = "tenant-1";

const config: SettingsConfig = {
  allowedNamespaces: new Set([NS]),
  maxSettingBytes: 64,
};

/** A controllable in-test store implementing the frozen SettingStore port. */
function makeStore() {
  return {
    get: vi.fn<SettingStore["get"]>(),
    put: vi.fn<SettingStore["put"]>(),
  };
}

/** A spying transport. deliver resolves {delivered:true} unless overridden. */
function makeTransport(): RealtimeTransport & { deliver: ReturnType<typeof vi.fn> } {
  return {
    kind: "poll",
    deliver: vi.fn().mockResolvedValue({ delivered: true }),
    getSetting: vi.fn(),
    putSetting: vi.fn(),
  } as unknown as RealtimeTransport & { deliver: ReturnType<typeof vi.fn> };
}

function blob(ciphertext: string, version: number): EncryptedBlob {
  return { ciphertext, version, updatedAt: "2026-06-20T00:00:00.000Z" };
}

describe("EncryptedSettingsHandler.handleGet", () => {
  let store: ReturnType<typeof makeStore>;
  let handler: EncryptedSettingsHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeStore();
    handler = new EncryptedSettingsHandler(store, config);
  });

  it("throws UnknownNamespaceError before touching the store (route maps to 404)", async () => {
    await expect(handler.handleGet(USER, "unknown_ns", null)).rejects.toMatchObject({
      name: "UnknownNamespaceError",
    });
    expect(store.get).not.toHaveBeenCalled();
  });

  it("404s when no blob exists", async () => {
    store.get.mockResolvedValue(null);
    const res = await handler.handleGet(USER, NS, null);
    expect(res.status).toBe(404);
  });

  it("returns 200 with ciphertext/version and an ETag of the version", async () => {
    store.get.mockResolvedValue(blob("CT", 7));
    const res = await handler.handleGet(USER, NS, null);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe("7");
    const body = await res.json();
    expect(body).toEqual({
      ciphertext: "CT",
      version: 7,
      updatedAt: "2026-06-20T00:00:00.000Z",
    });
  });

  it("returns 304 with an empty body when If-None-Match matches the version", async () => {
    store.get.mockResolvedValue(blob("CT", 7));
    const res = await handler.handleGet(USER, NS, "7");
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe("7");
    expect(await res.text()).toBe("");
  });

  it("returns 200 (not 304) when If-None-Match is stale", async () => {
    store.get.mockResolvedValue(blob("CT", 8));
    const res = await handler.handleGet(USER, NS, "7");
    expect(res.status).toBe(200);
  });

  it("scopes get strictly to the caller userId", async () => {
    store.get.mockResolvedValue(blob("CT", 1));
    await handler.handleGet(USER, NS, null);
    expect(store.get).toHaveBeenCalledWith(USER, NS);
  });
});

describe("EncryptedSettingsHandler.handlePut", () => {
  let store: ReturnType<typeof makeStore>;
  let transport: ReturnType<typeof makeTransport>;
  let handler: EncryptedSettingsHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeStore();
    transport = makeTransport();
    handler = new EncryptedSettingsHandler(store, config, transport);
  });

  it("throws UnknownNamespaceError before validating or storing (route maps to 404)", async () => {
    await expect(
      handler.handlePut(USER, TENANT, "unknown_ns", { ciphertext: "x", expectVersion: 0 }),
    ).rejects.toMatchObject({ name: "UnknownNamespaceError" });
    expect(store.put).not.toHaveBeenCalled();
  });

  it("400s an invalid body", async () => {
    const res = await handler.handlePut(USER, TENANT, NS, { ciphertext: 5 });
    expect(res.status).toBe(400);
    expect(store.put).not.toHaveBeenCalled();
  });

  it("happy path: 200 with new version + changeToken, calls deliver exactly once", async () => {
    store.put.mockResolvedValue({ ok: true, stored: blob("CT", 1) } as PutResult);
    const res = await handler.handlePut(USER, TENANT, NS, {
      ciphertext: "CT",
      expectVersion: 0,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe("1");
    const body = await res.json();
    expect(body).toEqual({ version: 1, changeToken: "1" });
    expect(transport.deliver).toHaveBeenCalledTimes(1);
  });

  it("wakeup payload carries the version (changeToken) and NOT the ciphertext", async () => {
    const secret = "SUPER-SECRET-CIPHERTEXT-NEVER-ON-THE-WIRE";
    store.put.mockResolvedValue({ ok: true, stored: blob(secret, 9) } as PutResult);
    await handler.handlePut(USER, TENANT, NS, {
      ciphertext: secret,
      expectVersion: 8,
    });
    expect(transport.deliver).toHaveBeenCalledTimes(1);
    const [target, channel, payload] = transport.deliver.mock.calls[0];
    expect(target).toEqual({ userId: USER, tenantId: TENANT });
    expect(channel).toEqual({
      kind: "setting_sync",
      tenantId: TENANT,
      scopeType: "user",
      scopeId: USER,
    });
    // Decode the wakeup: it is content-free, version-only, no ciphertext.
    const env = decodeWakeup(payload as Uint8Array);
    expect(env).toEqual({ v: 1, kind: "setting_sync", changeToken: "9" });
    const wireText = new TextDecoder().decode(payload as Uint8Array);
    expect(wireText).not.toContain(secret);
  });

  it("version mismatch: 409 with the server's current blob", async () => {
    store.put.mockResolvedValue({
      ok: false,
      reason: "version_conflict",
      current: blob("SERVER", 5),
    } as PutResult);
    const res = await handler.handlePut(USER, TENANT, NS, {
      ciphertext: "STALE",
      expectVersion: 3,
    });
    expect(res.status).toBe(409);
    expect(res.headers.get("etag")).toBe("5");
    const body = await res.json();
    expect(body.error).toBe("VERSION_CONFLICT");
    expect(body.current).toEqual({
      ciphertext: "SERVER",
      version: 5,
      updatedAt: "2026-06-20T00:00:00.000Z",
    });
    expect(transport.deliver).not.toHaveBeenCalled();
  });

  it("not_found CAS: 409 with null current, no wakeup", async () => {
    store.put.mockResolvedValue({
      ok: false,
      reason: "not_found",
      current: null,
    } as PutResult);
    const res = await handler.handlePut(USER, TENANT, NS, {
      ciphertext: "X",
      expectVersion: 2,
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.current).toBeNull();
    expect(transport.deliver).not.toHaveBeenCalled();
  });

  it("over the size cap: 413 and the store is NEVER called", async () => {
    const tooBig = "x".repeat(config.maxSettingBytes + 1);
    await expect(
      handler.handlePut(USER, TENANT, NS, { ciphertext: tooBig, expectVersion: 0 }),
    ).rejects.toMatchObject({ name: "BlobTooLargeError" });
    expect(store.put).not.toHaveBeenCalled();
  });

  it("best-effort publish: a deliver throw does NOT fail the PUT (still 200)", async () => {
    store.put.mockResolvedValue({ ok: true, stored: blob("CT", 1) } as PutResult);
    transport.deliver.mockRejectedValue(new Error("transport down"));
    const res = await handler.handlePut(USER, TENANT, NS, {
      ciphertext: "CT",
      expectVersion: 0,
    });
    expect(res.status).toBe(200);
  });

  it("REST-only degradation: no transport wired -> PUT still 200", async () => {
    const noTransport = new EncryptedSettingsHandler(store, config);
    store.put.mockResolvedValue({ ok: true, stored: blob("CT", 1) } as PutResult);
    const res = await noTransport.handlePut(USER, TENANT, NS, {
      ciphertext: "CT",
      expectVersion: 0,
    });
    expect(res.status).toBe(200);
  });

  it("server-blindness: ciphertext round-trips byte-identical through PUT then GET", async () => {
    const opaque = '{"looks":"like json"} but-treated-as-bytes';
    let saved: EncryptedBlob | null = null;
    store.put.mockImplementation(async (_u, _ns, b) => {
      saved = { ciphertext: b.ciphertext, version: 1, updatedAt: "2026-06-20T00:00:00.000Z" };
      return { ok: true, stored: saved } as PutResult;
    });
    store.get.mockImplementation(async () => saved);

    const putRes = await handler.handlePut(USER, TENANT, NS, {
      ciphertext: opaque,
      expectVersion: 0,
    });
    expect(putRes.status).toBe(200);

    const getRes = await handler.handleGet(USER, NS, null);
    const body = await getRes.json();
    expect(body.ciphertext).toBe(opaque);
  });
});

describe("EncryptedSettingsHandler.handleChanges (Track C)", () => {
  /** A store that ALSO implements the optional ChangeCursorStore capability. */
  function makeCursorStore() {
    return {
      get: vi.fn<SettingStore["get"]>(),
      put: vi.fn<SettingStore["put"]>(),
      listChangedSince: vi.fn(),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("501s when the store lacks the change-cursor capability", async () => {
    // A plain SettingStore (no listChangedSince).
    const plain = { get: vi.fn(), put: vi.fn() };
    const handler = new EncryptedSettingsHandler(plain, config);
    const res = await handler.handleChanges(USER, 0);
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error).toBe("NOT_IMPLEMENTED");
  });

  it("returns metadata-only changes + the advanced cursor high-watermark", async () => {
    const store = makeCursorStore();
    store.listChangedSince.mockResolvedValue([
      { namespace: "feed_filters", version: 4, updatedAt: "2026-06-20T00:00:00.000Z" },
      { namespace: "read_state", version: 7, updatedAt: "2026-06-20T00:00:00.000Z" },
    ]);
    const handler = new EncryptedSettingsHandler(store, config);

    const res = await handler.handleChanges(USER, 3);
    expect(res.status).toBe(200);
    expect(store.listChangedSince).toHaveBeenCalledWith(USER, 3);

    const body = await res.json();
    // Cursor advances to the max version observed.
    expect(body.cursor).toBe(7);
    expect(body.changes).toEqual([
      { namespace: "feed_filters", version: 4, updatedAt: "2026-06-20T00:00:00.000Z" },
      { namespace: "read_state", version: 7, updatedAt: "2026-06-20T00:00:00.000Z" },
    ]);
  });

  it("the cursor response carries NO ciphertext (server stays blind)", async () => {
    const store = makeCursorStore();
    store.listChangedSince.mockResolvedValue([
      { namespace: "feed_filters", version: 9, updatedAt: "2026-06-20T00:00:00.000Z" },
    ]);
    const handler = new EncryptedSettingsHandler(store, config);

    const res = await handler.handleChanges(USER, 0);
    const raw = await res.text();
    // The serialized response body must not contain a ciphertext field at all.
    expect(raw).not.toContain("ciphertext");
    const body = JSON.parse(raw);
    for (const c of body.changes) {
      expect(c).not.toHaveProperty("ciphertext");
    }
  });

  it("echoes the input cursor unchanged when nothing advanced", async () => {
    const store = makeCursorStore();
    store.listChangedSince.mockResolvedValue([]);
    const handler = new EncryptedSettingsHandler(store, config);

    const res = await handler.handleChanges(USER, 42);
    const body = await res.json();
    expect(body.changes).toEqual([]);
    expect(body.cursor).toBe(42);
  });
});
