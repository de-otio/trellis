/**
 * Unit Tests: ReportCategoryAdminHandler (compliance plan 08 §2.1).
 *
 * A4 (quality sweep 2026-09-05). This handler shipped with 239 lines and no
 * tests at all, and it is not an incidental surface: it owns the SUPER_ADMIN
 * gate on the report-category vocabulary and the `routingClass` validation that
 * decides what an intake DOES with a report. A category whose genuinely-illegal
 * offence is stored as `routingClass: "FEEDBACK"` never fires the
 * illegal-priority carve-out — no preservation, no authority report, and the
 * content stays appealable. Nothing in the suite would have caught it.
 *
 * So these pin the two things a mis-edit here costs:
 *   - the SUPER_ADMIN gate, on every method, in both directions;
 *   - `routingClass` as a CLOSED set — the one field core routes on.
 * Plus the upsert's create/update distinction (which decides the audit action
 * and the status code) and the deactivate conflict semantics.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";

const mockDb = {
  reportCategory: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
  },
};

vi.mock("../../src/db.js", () => ({
  createPrisma: vi.fn(() => mockDb),
}));

const mockLogSystemAction = vi.fn(async () => {});
vi.mock("../../src/lib/audit-composer.js", () => ({
  TrellisAuditLogger: class {
    logSystemAction = mockLogSystemAction;
  },
}));

const { ReportCategoryAdminHandler } = await import(
  "../../src/lib/report-category-admin-handler.js"
);

const env = { DEFAULT_REGION: "EU" } as unknown as Env;
const superAdmin = { userId: "admin-1", globalRole: "SUPER_ADMIN" } as any;
const endUser = { userId: "user-1", globalRole: "END_USER" } as any;

const post = (body: unknown) =>
  new Request("https://api.example.com/api/admin/report-categories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const VALID = {
  key: "csam",
  routingClass: "ILLEGAL_PRIORITY",
  labels: { en: "Child sexual abuse material" },
};

describe("ReportCategoryAdminHandler — the SUPER_ADMIN gate", () => {
  let handler: InstanceType<typeof ReportCategoryAdminHandler>;
  beforeEach(() => {
    vi.clearAllMocks();
    handler = new ReportCategoryAdminHandler();
  });

  it("refuses upsert for a non-SUPER_ADMIN, and touches no database", async () => {
    const res = await handler.handleUpsert(post(VALID), endUser, env);

    expect(res.status).toBe(403);
    expect(mockDb.reportCategory.upsert).not.toHaveBeenCalled();
    // The gate must run BEFORE the body is parsed or the row is read.
    expect(mockDb.reportCategory.findUnique).not.toHaveBeenCalled();
  });

  it("refuses deactivate for a non-SUPER_ADMIN, and touches no database", async () => {
    const res = await handler.handleDeactivate("csam", post({}), endUser, env);

    expect(res.status).toBe(403);
    expect(mockDb.reportCategory.update).not.toHaveBeenCalled();
  });

  it("refuses list for a non-SUPER_ADMIN", async () => {
    const res = await handler.handleList(endUser, env);

    expect(res.status).toBe(403);
    expect(mockDb.reportCategory.findMany).not.toHaveBeenCalled();
  });

  it("admits a SUPER_ADMIN on all three", async () => {
    mockDb.reportCategory.findUnique.mockResolvedValue(null);
    mockDb.reportCategory.upsert.mockResolvedValue({ ...VALID, active: true, sortOrder: 0 });
    mockDb.reportCategory.findMany.mockResolvedValue([]);

    expect((await handler.handleUpsert(post(VALID), superAdmin, env)).status).toBe(201);
    expect((await handler.handleList(superAdmin, env)).status).toBe(200);

    mockDb.reportCategory.findUnique.mockResolvedValue({ key: "csam", active: true });
    mockDb.reportCategory.update.mockResolvedValue({});
    expect(
      (await handler.handleDeactivate("csam", post({}), superAdmin, env)).status,
    ).toBe(200);
  });
});

describe("ReportCategoryAdminHandler — routingClass is a closed set", () => {
  let handler: InstanceType<typeof ReportCategoryAdminHandler>;
  beforeEach(() => {
    vi.clearAllMocks();
    handler = new ReportCategoryAdminHandler();
    mockDb.reportCategory.findUnique.mockResolvedValue(null);
    mockDb.reportCategory.upsert.mockResolvedValue({
      ...VALID, active: true, sortOrder: 0,
    });
  });

  it.each(["ILLEGAL_PRIORITY", "ILLEGAL", "POLICY_VIOLATION", "FEEDBACK"])(
    "accepts the routing class %s",
    async (routingClass) => {
      const res = await handler.handleUpsert(
        post({ ...VALID, routingClass }),
        superAdmin,
        env,
      );
      expect(res.status).toBe(201);
      expect(mockDb.reportCategory.upsert.mock.calls[0][0].create.routingClass).toBe(
        routingClass,
      );
    },
  );

  it.each(["illegal_priority", "ILLEGAL-PRIORITY", "URGENT", "", "ILLEGAL_PRIORITY "])(
    "refuses %p and writes nothing",
    async (routingClass) => {
      const res = await handler.handleUpsert(
        post({ ...VALID, routingClass }),
        superAdmin,
        env,
      );
      expect(res.status).toBe(400);
      expect(mockDb.reportCategory.upsert).not.toHaveBeenCalled();
    },
  );

  it("refuses a missing routingClass rather than defaulting one", async () => {
    const { routingClass: _omitted, ...noClass } = VALID;
    const res = await handler.handleUpsert(post(noClass), superAdmin, env);

    expect(res.status).toBe(400);
    expect(mockDb.reportCategory.upsert).not.toHaveBeenCalled();
  });
});

describe("ReportCategoryAdminHandler — upsert semantics", () => {
  let handler: InstanceType<typeof ReportCategoryAdminHandler>;
  beforeEach(() => {
    vi.clearAllMocks();
    handler = new ReportCategoryAdminHandler();
    mockDb.reportCategory.upsert.mockResolvedValue({
      ...VALID, active: true, sortOrder: 0,
    });
  });

  it("201 when the key is new, 200 when it already existed", async () => {
    mockDb.reportCategory.findUnique.mockResolvedValue(null);
    expect((await handler.handleUpsert(post(VALID), superAdmin, env)).status).toBe(201);

    mockDb.reportCategory.findUnique.mockResolvedValue({ key: "csam" });
    expect((await handler.handleUpsert(post(VALID), superAdmin, env)).status).toBe(200);
  });

  it("rejects malformed JSON with 400 before any database call", async () => {
    const bad = new Request("https://api.example.com/api/admin/report-categories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    const res = await handler.handleUpsert(bad, superAdmin, env);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_JSON");
    expect(mockDb.reportCategory.findUnique).not.toHaveBeenCalled();
  });

  it.each(["Csam", "1csam", "csam_case", "csam!"])(
    "refuses the malformed key %p",
    async (key) => {
      mockDb.reportCategory.findUnique.mockResolvedValue(null);
      const res = await handler.handleUpsert(post({ ...VALID, key }), superAdmin, env);

      expect(res.status).toBe(400);
      expect(mockDb.reportCategory.upsert).not.toHaveBeenCalled();
    },
  );

  it("stores labels opaquely — core never interprets category meaning", async () => {
    mockDb.reportCategory.findUnique.mockResolvedValue(null);
    const labels = { en: "anything at all", de: "beliebig", xx: "☃" };

    await handler.handleUpsert(post({ ...VALID, labels }), superAdmin, env);

    expect(mockDb.reportCategory.upsert.mock.calls[0][0].create.labels).toEqual(labels);
  });
});

describe("ReportCategoryAdminHandler — deactivate", () => {
  let handler: InstanceType<typeof ReportCategoryAdminHandler>;
  beforeEach(() => {
    vi.clearAllMocks();
    handler = new ReportCategoryAdminHandler();
  });

  it("404s an unknown key and writes nothing", async () => {
    mockDb.reportCategory.findUnique.mockResolvedValue(null);

    const res = await handler.handleDeactivate("nope", post({}), superAdmin, env);

    expect(res.status).toBe(404);
    expect(mockDb.reportCategory.update).not.toHaveBeenCalled();
  });

  it("409s an already-inactive category rather than re-deactivating it", async () => {
    mockDb.reportCategory.findUnique.mockResolvedValue({ key: "csam", active: false });

    const res = await handler.handleDeactivate("csam", post({}), superAdmin, env);

    expect(res.status).toBe(409);
    expect(mockDb.reportCategory.update).not.toHaveBeenCalled();
  });

  it("deactivates an active category by setting active:false only", async () => {
    mockDb.reportCategory.findUnique.mockResolvedValue({ key: "csam", active: true });
    mockDb.reportCategory.update.mockResolvedValue({});

    const res = await handler.handleDeactivate("csam", post({}), superAdmin, env);

    expect(res.status).toBe(200);
    expect(mockDb.reportCategory.update).toHaveBeenCalledWith({
      where: { key: "csam" },
      data: { active: false },
    });
  });
});
