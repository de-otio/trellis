/**
 * Unit tests for the PostConfirmation Lambda (T2 — Cognito Lambda Triggers).
 *
 * Strategy: mock Prisma + Secrets Manager + DDB at the module boundary so
 * we never touch a real DB. The transaction callback is invoked with a mock
 * `tx` object that mirrors the methods we call.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnderMinimumAgeError } from "../../src/lib/age-gate.js";

const {
  mockSecretsSend,
  mockGetSecret,
  mockTransaction,
  mockUserFindFirst,
  mockUserFindUnique,
  mockUserCreate,
  mockUserUpdate,
  mockTenantCreate,
  mockTenantFindUnique,
  mockTenantMemberUpsert,
  mockTenantDomainFindUnique,
  mockParentalLinkUpsert,
  mockInvitationFindUnique,
  mockDdbSend,
} = vi.hoisted(() => ({
  mockSecretsSend: vi.fn(),
  mockGetSecret: vi.fn(),
  mockTransaction: vi.fn(),
  mockUserFindFirst: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockUserCreate: vi.fn(),
  mockUserUpdate: vi.fn(),
  mockTenantCreate: vi.fn(),
  mockTenantFindUnique: vi.fn(),
  mockTenantMemberUpsert: vi.fn(),
  mockTenantDomainFindUnique: vi.fn(),
  mockParentalLinkUpsert: vi.fn(),
  mockInvitationFindUnique: vi.fn(),
  mockDdbSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-secrets-manager", () => {
  const SecretsManagerClient = vi.fn();
  SecretsManagerClient.prototype.send = mockSecretsSend;
  return {
    SecretsManagerClient,
    GetSecretValueCommand: vi.fn(function (this: any, input: any) {
      this.input = input;
    }),
  };
});

// WS-2 §5.3: lambda-prisma resolves the DB secret via the foundation secrets
// port now (resolveSecret returns the raw JSON bytes as a Buffer).
vi.mock("@de-otio/saas-foundation/secrets", () => ({
  resolveSecret: mockGetSecret,
  resolveParameter: vi.fn(),
  secretRef: vi.fn((arn) => ({ arn })),
  SecretCache: class {
    get() {
      return null;
    }
    set() {}
    invalidate() {}
    clear() {}
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => {
  const DynamoDBClient = vi.fn();
  DynamoDBClient.prototype.send = mockDdbSend;
  return {
    DynamoDBClient,
    GetItemCommand: vi.fn(function (this: any, input: any) {
      this.input = input;
      this.kind = "GET";
    }),
    PutItemCommand: vi.fn(function (this: any, input: any) {
      this.input = input;
      this.kind = "PUT";
    }),
    DeleteItemCommand: vi.fn(function (this: any, input: any) {
      this.input = input;
      this.kind = "DEL";
    }),
  };
});

vi.mock("@aws-sdk/util-dynamodb", () => ({
  marshall: vi.fn((obj: any) => {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") out[k] = { S: v };
      else if (typeof v === "number") out[k] = { N: String(v) };
    }
    return out;
  }),
  unmarshall: vi.fn((item: any) => {
    const out: any = {};
    for (const [k, v] of Object.entries(item) as any) {
      if (v.S !== undefined) out[k] = v.S;
      else if (v.N !== undefined) out[k] = parseInt(v.N, 10);
    }
    return out;
  }),
}));

vi.mock("@prisma/client", () => {
  const PrismaClient = vi.fn(function (this: any) {
    this.$transaction = mockTransaction;
    this.user = { findUnique: mockUserFindUnique };
    this.parentalLink = { upsert: mockParentalLinkUpsert };
  });
  // S-CP2: post-confirmation now references Prisma.PrismaClientKnownRequestError
  // (handle-collision retry). Provide a minimal class for the instanceof check.
  class PrismaClientKnownRequestError extends Error {
    code: string;
    meta?: unknown;
    constructor(message: string, opts?: { code?: string; meta?: unknown }) {
      super(message);
      this.code = opts?.code ?? "";
      this.meta = opts?.meta;
    }
  }
  return { PrismaClient, Prisma: { PrismaClientKnownRequestError } };
});

function makeTx() {
  return {
    user: {
      findFirst: mockUserFindFirst,
      create: mockUserCreate,
      update: mockUserUpdate,
    },
    tenant: {
      create: mockTenantCreate,
      findUnique: mockTenantFindUnique,
    },
    tenantMember: {
      upsert: mockTenantMemberUpsert,
    },
    tenantDomain: {
      findUnique: mockTenantDomainFindUnique,
    },
    invitation: {
      findUnique: mockInvitationFindUnique,
    },
  };
}

function makeEvent(opts: {
  email?: string;
  emailVerified?: string;
  triggerSource?: string;
  identities?: string;
  idpGroups?: string;
  handle?: string;
  dateOfBirth?: string;
  guardianEmail?: string;
  invitationCode?: string;
} = {}) {
  const attrs: Record<string, string> = {
    sub: "cognito-sub-abc123",
    email: opts.email ?? "alice@example.com",
    email_verified: opts.emailVerified ?? "true",
  };
  if (opts.identities !== undefined) attrs["identities"] = opts.identities;
  if (opts.idpGroups !== undefined) attrs["custom:idpGroups"] = opts.idpGroups;
  if (opts.handle !== undefined) attrs["custom:handle"] = opts.handle;
  if (opts.dateOfBirth !== undefined) attrs["custom:dateOfBirth"] = opts.dateOfBirth;
  if (opts.guardianEmail !== undefined) attrs["custom:guardianEmail"] = opts.guardianEmail;
  return {
    triggerSource: opts.triggerSource ?? "PostConfirmation_ConfirmSignUp",
    userName: "cognito-sub-abc123",
    request: {
      userAttributes: attrs,
      ...(opts.invitationCode !== undefined
        ? { clientMetadata: { invitationCode: opts.invitationCode } }
        : {}),
    },
    response: {},
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env.AWS_REGION = "eu-central-1";
  process.env.DB_SECRET_ARN = "arn:aws:secretsmanager:eu-central-1:123:secret:db";
  process.env.DYNAMODB_TABLE = "dev-trellis";

  mockSecretsSend.mockResolvedValue({
    SecretString: JSON.stringify({
      username: "u",
      password: "p",
      host: "h",
      port: 5432,
      dbname: "d",
    }),
  });
  // The foundation resolver returns the credential JSON as bytes.
  mockGetSecret.mockResolvedValue(
    Buffer.from(
      JSON.stringify({ username: "u", password: "p", host: "h", port: 5432, dbname: "d" }),
      "utf-8",
    ),
  );
  mockTransaction.mockImplementation(async (cb: any) => cb(makeTx()));
  mockUserFindFirst.mockResolvedValue(null);
  mockUserCreate.mockImplementation(async (args: any) => ({
    id: "u_clxxxxxxxxxxxxxxxxxxxxxx",
    role: args.data.role,
    handle: args.data.handle,
    subject: args.data.subject,
    email: args.data.email,
    personalTenantId: null,
  }));
  mockUserUpdate.mockImplementation(async (args: any) => ({
    id: args.where.id,
    role: "B2B_PARTNER",
    handle: "alice",
    subject: args.data.subject ?? "cognito-sub-abc123",
    email: "alice@example.com",
    personalTenantId: args.data.personalTenantId ?? null,
  }));
  mockTenantCreate.mockImplementation(async (args: any) => ({
    id: "t_personal_001",
    slug: args.data.slug,
    type: args.data.type,
  }));
  mockTenantFindUnique.mockResolvedValue({ slug: "personal-existing" });
  mockTenantMemberUpsert.mockResolvedValue({ id: "tm_001" });
  mockTenantDomainFindUnique.mockResolvedValue(null);
  mockUserFindUnique.mockResolvedValue(null);
  mockParentalLinkUpsert.mockResolvedValue({});
  mockInvitationFindUnique.mockResolvedValue(null);
  mockDdbSend.mockResolvedValue({});
});

async function loadHandler() {
  const mod = await import("../../src/lambda/post-confirmation.js");
  // Hermetic by default: route the claims cache + invitation record through
  // MemoryKvStores so a handler run never reaches real AWS (the KvStore port
  // lives in @de-otio/saas-foundation, which the raw-SDK mock does not
  // intercept). Tests that assert on these stores override the seam AFTER
  // loadHandler with their own instance.
  const { ClaimsCache } = await import("../../src/lib/auth/claims-cache.js");
  const { MemoryKvStore } = await import("@de-otio/saas-foundation/kv");
  const { __setInvitationStoreForTest } = await import(
    "../../src/lib/invitation-presignup-record.js"
  );
  mod.__setClaimsCacheForTest(new ClaimsCache(new MemoryKvStore()));
  __setInvitationStoreForTest(new MemoryKvStore());
  return mod.handler;
}

describe("PostConfirmation Lambda — native sign-up", () => {
  it("creates User + personal Tenant + OWNER TenantMember", async () => {
    const handler = await loadHandler();
    const event = makeEvent();

    await handler(event, {} as any, () => {});

    expect(mockUserCreate).toHaveBeenCalledTimes(1);
    expect(mockUserCreate.mock.calls[0][0].data).toMatchObject({
      subject: "cognito-sub-abc123",
      email: "alice@example.com",
      role: "END_USER",
    });
    expect(mockTenantCreate).toHaveBeenCalledTimes(1);
    expect(mockTenantCreate.mock.calls[0][0].data).toMatchObject({
      type: "PERSONAL",
      personalOwnerUserId: "u_clxxxxxxxxxxxxxxxxxxxxxx",
    });
    expect(mockTenantMemberUpsert).toHaveBeenCalledTimes(1);
    expect(mockTenantMemberUpsert.mock.calls[0][0].create).toMatchObject({
      role: "OWNER",
      status: "ACTIVE",
    });
  });

  it("uses personal-{userId} as the slug", async () => {
    const handler = await loadHandler();
    await handler(makeEvent(), {} as any, () => {});
    expect(mockTenantCreate.mock.calls[0][0].data.slug).toBe(
      "personal-u_clxxxxxxxxxxxxxxxxxxxxxx",
    );
  });

  it("primes the claims cache after a successful transaction (outcome-equivalence)", async () => {
    // The write now goes through @de-otio/saas-foundation's KvStore port
    // (putIfFresher), not a raw DynamoDB PutItem, so assert the OUTCOME: inject
    // a MemoryKvStore-backed ClaimsCache and read back the primed claims.
    const { ClaimsCache } = await import("../../src/lib/auth/claims-cache.js");
    const { MemoryKvStore } = await import("@de-otio/saas-foundation/kv");
    const { __setClaimsCacheForTest } = await import("../../src/lambda/post-confirmation.js");
    const injected = new ClaimsCache(new MemoryKvStore());
    try {
      const handler = await loadHandler();
      __setClaimsCacheForTest(injected); // override loadHandler's hermetic default
      await handler(makeEvent(), {} as any, () => {});
      const primed = await injected.get("cognito-sub-abc123");
      expect(primed?.userId).toBe("u_clxxxxxxxxxxxxxxxxxxxxxx");
      expect(primed?.tenantRole).toBe("OWNER");
    } finally {
      __setClaimsCacheForTest(null);
    }
  });

  it("skips for unsupported trigger source", async () => {
    const handler = await loadHandler();
    await handler(makeEvent({ triggerSource: "PostConfirmation_Other" }), {} as any, () => {});
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockUserCreate).not.toHaveBeenCalled();
  });

  it("skips when email attribute is missing", async () => {
    const handler = await loadHandler();
    const event: any = {
      triggerSource: "PostConfirmation_ConfirmSignUp",
      userName: "sub",
      request: { userAttributes: {} },
      response: {},
    };
    await handler(event, {} as any, () => {});
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  // ── Minimum-age floor (18+) ────────────────────────────────────────────
  //
  // This trigger used to provision a CHILD account and link a guardian to it.
  // Minor accounts are not a supported account type; the client refuses an
  // under-18 date of birth at signup, and the server re-applies the floor here
  // because the Cognito trigger is reachable without the client (see
  // `src/lib/age-gate.ts`). The replaced test asserted the parental link was
  // created — a behaviour the product no longer wants.
  it.each([
    ["a child", 10],
    ["a teenager", 17],
    ["someone one day short of 18", 17.99],
  ])("refuses to provision %s", async (_label, yearsOld) => {
    mockUserFindUnique.mockResolvedValueOnce({ id: "guardian_id" });
    const handler = await loadHandler();
    const dob = new Date(Date.now() - yearsOld * 365.25 * 24 * 60 * 60 * 1000);

    // Matched by name and envelope rather than `instanceof`: `loadHandler`
    // re-imports the lambda through a fresh module registry, so its
    // `UnderMinimumAgeError` is a different class object from the one this
    // file imported even though it is the same declaration.
    const thrown = await handler(
      makeEvent({
        dateOfBirth: dob.toISOString().slice(0, 10),
        guardianEmail: "guardian@example.com",
      }),
      {} as any,
      () => {},
    ).then(
      () => null,
      (err: unknown) => err,
    );

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe(new UnderMinimumAgeError().name);
    expect((thrown as UnderMinimumAgeError).envelope).toEqual(
      new UnderMinimumAgeError().envelope,
    );

    // Fail closed: no user row, no guardian link, nothing half-written that a
    // later sign-in could heal into a working minor account.
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockUserCreate).not.toHaveBeenCalled();
    expect(mockParentalLinkUpsert).not.toHaveBeenCalled();
  });

  /**
   * B1 (quality sweep 2026-09-05). The minimum-age floor above is fail-closed;
   * the parse in front of it was not. It accepted whatever `new Date()`
   * accepted and required only `parsed < now`, so a malformed or future value
   * failed the `if` and fell straight through — account provisioned at the
   * `ADULT` default, no date of birth stored, no log line, no re-check. An age
   * tier assigned by accident from an input the caller got wrong.
   *
   * `/auth/register`'s strict parser never sees these paths: this trigger and
   * Keycloak JIT both reach provisioning directly.
   */
  it.each([
    ["a future date", "2099-01-01"],
    ["a non-date", "not-a-date"],
    ["an impossible day the Date constructor rolls over", "2025-02-31"],
    ["a year typo that a bare Date parse accepts", "0202-01-01"],
    ["a non-ISO shape", "01/01/1990"],
    ["an empty-ish string", "   "],
  ])("refuses to provision on %s rather than defaulting to ADULT", async (_label, dateOfBirth) => {
    const handler = await loadHandler();

    const thrown = await handler(
      makeEvent({ dateOfBirth }),
      {} as any,
      () => {},
    ).then(
      () => null,
      (err: unknown) => err,
    );

    // Matched by name for the same reason as the under-age case above.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("InvalidDateOfBirthError");

    // Fail closed: nothing written at all.
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockUserCreate).not.toHaveBeenCalled();
  });

  it("still provisions when no date of birth is supplied at all", async () => {
    // An ABSENT date of birth is a different case: nothing was claimed, so
    // there is nothing to fail on. Only a supplied-but-unreadable value throws.
    const handler = await loadHandler();

    await handler(makeEvent({}), {} as any, () => {});

    expect(mockTransaction).toHaveBeenCalled();
  });

  it("provisions an adult, and links no guardian even when one is supplied", async () => {
    mockUserFindUnique.mockResolvedValueOnce({ id: "guardian_id" });
    const handler = await loadHandler();
    const dob = new Date();
    dob.setUTCFullYear(dob.getUTCFullYear() - 30);

    await handler(
      makeEvent({
        dateOfBirth: dob.toISOString().slice(0, 10),
        guardianEmail: "guardian@example.com",
      }),
      {} as any,
      () => {},
    );

    expect(mockTransaction).toHaveBeenCalled();
    // `guardianEmail` is still accepted on the input and deliberately ignored.
    expect(mockParentalLinkUpsert).not.toHaveBeenCalled();
  });
});

describe("PostConfirmation Lambda — federated sign-up", () => {
  function federatedEvent(overrides: Parameters<typeof makeEvent>[0] = {}) {
    return makeEvent({
      identities: JSON.stringify([
        { providerName: "tenant-abc", userId: "alice@de-otio.org" },
      ]),
      idpGroups: "trellis-admins,trellis-employees",
      ...overrides,
    });
  }

  it("provisions org TenantMember when domain matches a verified tenant", async () => {
    mockTenantDomainFindUnique.mockResolvedValueOnce({
      tenantId: "t_org_001",
      domain: "example.com",
      verifiedAt: new Date(),
      tenant: {
        id: "t_org_001",
        slug: "acme",
        identityProvider: { status: "ACTIVE", defaultRole: "MEMBER" },
        roleMappings: [
          { idpGroupName: "trellis-admins", tenantRole: "ADMIN", priority: 10 },
          { idpGroupName: "trellis-employees", tenantRole: "MEMBER", priority: 100 },
        ],
      },
    });

    const handler = await loadHandler();
    await handler(federatedEvent(), {} as any, () => {});

    expect(mockUserCreate.mock.calls[0][0].data.role).toBe("B2B_PARTNER");
    expect(mockTenantMemberUpsert).toHaveBeenCalledTimes(2);
    const orgUpsert = mockTenantMemberUpsert.mock.calls.find(
      (c) => c[0].create.tenantId === "t_org_001",
    );
    expect(orgUpsert).toBeDefined();
    expect(orgUpsert![0].create).toMatchObject({
      role: "ADMIN",
      isJitProvisioned: true,
      status: "ACTIVE",
    });
  });

  it("only creates personal tenant when no domain match", async () => {
    mockTenantDomainFindUnique.mockResolvedValueOnce(null);

    const handler = await loadHandler();
    await handler(federatedEvent({ email: "bob@unknown.example" }), {} as any, () => {});

    expect(mockTenantCreate).toHaveBeenCalledTimes(1);
    expect(mockTenantMemberUpsert).toHaveBeenCalledTimes(1);
    expect(mockTenantMemberUpsert.mock.calls[0][0].create.role).toBe("OWNER");
  });

  it("only creates personal tenant when domain is unverified", async () => {
    mockTenantDomainFindUnique.mockResolvedValueOnce({
      tenantId: "t_org",
      domain: "example.com",
      verifiedAt: null,
      tenant: {
        id: "t_org",
        slug: "acme",
        identityProvider: { status: "ACTIVE", defaultRole: "MEMBER" },
        roleMappings: [],
      },
    });

    const handler = await loadHandler();
    await handler(federatedEvent(), {} as any, () => {});

    expect(mockTenantMemberUpsert).toHaveBeenCalledTimes(1);
    expect(mockTenantMemberUpsert.mock.calls[0][0].create.role).toBe("OWNER");
  });

  it("applies defaultRole when idpGroups don't match any mapping", async () => {
    mockTenantDomainFindUnique.mockResolvedValueOnce({
      tenantId: "t_org",
      domain: "example.com",
      verifiedAt: new Date(),
      tenant: {
        id: "t_org",
        slug: "acme",
        identityProvider: { status: "ACTIVE", defaultRole: "GUEST" },
        roleMappings: [
          { idpGroupName: "trellis-admins", tenantRole: "ADMIN", priority: 10 },
        ],
      },
    });

    const handler = await loadHandler();
    await handler(federatedEvent({ idpGroups: "unrelated-group" }), {} as any, () => {});

    const orgUpsert = mockTenantMemberUpsert.mock.calls.find(
      (c) => c[0].create.tenantId === "t_org",
    );
    expect(orgUpsert![0].create.role).toBe("GUEST");
  });

  it("skips org TenantMember when no role mapping AND no defaultRole", async () => {
    mockTenantDomainFindUnique.mockResolvedValueOnce({
      tenantId: "t_org",
      domain: "example.com",
      verifiedAt: new Date(),
      tenant: {
        id: "t_org",
        slug: "acme",
        identityProvider: { status: "ACTIVE", defaultRole: null },
        roleMappings: [
          { idpGroupName: "trellis-admins", tenantRole: "ADMIN", priority: 10 },
        ],
      },
    });

    const handler = await loadHandler();
    await handler(federatedEvent({ idpGroups: "unrelated-group" }), {} as any, () => {});

    expect(mockTenantMemberUpsert).toHaveBeenCalledTimes(1);
    expect(mockTenantMemberUpsert.mock.calls[0][0].create.role).toBe("OWNER");
  });

  it("skips org TenantMember when IdP status is not ACTIVE", async () => {
    mockTenantDomainFindUnique.mockResolvedValueOnce({
      tenantId: "t_org",
      domain: "example.com",
      verifiedAt: new Date(),
      tenant: {
        id: "t_org",
        slug: "acme",
        identityProvider: { status: "PENDING", defaultRole: "MEMBER" },
        roleMappings: [],
      },
    });

    const handler = await loadHandler();
    await handler(federatedEvent(), {} as any, () => {});

    expect(mockTenantMemberUpsert).toHaveBeenCalledTimes(1);
    expect(mockTenantMemberUpsert.mock.calls[0][0].create.role).toBe("OWNER");
  });

  it("does not match a similar-but-different domain (cross-tenant isolation)", async () => {
    const verifiedDomains = new Map<string, any>();
    verifiedDomains.set("domain-a.example", {
      tenantId: "t_a",
      domain: "domain-a.example",
      verifiedAt: new Date(),
      tenant: {
        id: "t_a",
        slug: "tenant-a",
        identityProvider: { status: "ACTIVE", defaultRole: "MEMBER" },
        roleMappings: [],
      },
    });
    verifiedDomains.set("domain-b.example", {
      tenantId: "t_b",
      domain: "domain-b.example",
      verifiedAt: new Date(),
      tenant: {
        id: "t_b",
        slug: "tenant-b",
        identityProvider: { status: "ACTIVE", defaultRole: "MEMBER" },
        roleMappings: [],
      },
    });
    mockTenantDomainFindUnique.mockImplementation(async (args: any) => {
      const lookup = args.where.domain;
      return verifiedDomains.get(lookup) ?? null;
    });

    const handler = await loadHandler();
    await handler(federatedEvent({ email: "alice@domain-a.example" }), {} as any, () => {});

    const orgUpsert = mockTenantMemberUpsert.mock.calls.find(
      (c) => c[0].create.tenantId === "t_a",
    );
    expect(orgUpsert).toBeDefined();
    const wrongTenantUpsert = mockTenantMemberUpsert.mock.calls.find(
      (c) => c[0].create.tenantId === "t_b",
    );
    expect(wrongTenantUpsert).toBeUndefined();
    expect(mockTenantDomainFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { domain: "domain-a.example" } }),
    );
  });

  it("treats federated emails with unverified or missing domain as personal-only", async () => {
    mockTenantDomainFindUnique.mockImplementationOnce(async () => ({
      tenantId: "t_unverified",
      domain: "unverified.example",
      verifiedAt: null,
      tenant: {
        id: "t_unverified",
        slug: "unverified",
        identityProvider: { status: "ACTIVE", defaultRole: "MEMBER" },
        roleMappings: [],
      },
    }));
    const handler = await loadHandler();
    await handler(federatedEvent({ email: "ghost@unverified.example" }), {} as any, () => {});
    expect(mockTenantMemberUpsert).toHaveBeenCalledTimes(1);
    expect(mockTenantMemberUpsert.mock.calls[0][0].create.role).toBe("OWNER");
  });

  it("skips federated provisioning when email cannot be parsed to a domain", async () => {
    const handler = await loadHandler();
    await handler(
      makeEvent({
        email: "no-at-sign",
        identities: JSON.stringify([{ providerName: "tenant-abc" }]),
      }),
      {} as any,
      () => {},
    );
    expect(mockTenantDomainFindUnique).not.toHaveBeenCalled();
  });

  it("skips org-tenant provisioning when email_verified is not 'true' (G2 H1)", async () => {
    mockTenantDomainFindUnique.mockResolvedValueOnce({
      tenantId: "t_org_001",
      domain: "example.com",
      verifiedAt: new Date(),
      tenant: {
        id: "t_org_001",
        slug: "acme",
        identityProvider: { status: "ACTIVE", defaultRole: "MEMBER" },
        roleMappings: [],
      },
    });
    const handler = await loadHandler();
    await handler(federatedEvent({ emailVerified: "false" }), {} as any, () => {});

    // Personal tenant still created; org TenantMember NOT created.
    expect(mockTenantMemberUpsert).toHaveBeenCalledTimes(1);
    expect(mockTenantMemberUpsert.mock.calls[0][0].create.role).toBe("OWNER");
    expect(mockTenantDomainFindUnique).not.toHaveBeenCalled();
  });

  it("skips org-tenant provisioning when email_verified attribute is missing", async () => {
    mockTenantDomainFindUnique.mockResolvedValueOnce({
      tenantId: "t_org_001",
      domain: "example.com",
      verifiedAt: new Date(),
      tenant: {
        id: "t_org_001",
        slug: "acme",
        identityProvider: { status: "ACTIVE", defaultRole: "MEMBER" },
        roleMappings: [],
      },
    });
    // Build event without email_verified at all.
    const event = federatedEvent();
    delete event.request.userAttributes.email_verified;
    const handler = await loadHandler();
    await handler(event, {} as any, () => {});
    expect(mockTenantMemberUpsert).toHaveBeenCalledTimes(1);
    expect(mockTenantDomainFindUnique).not.toHaveBeenCalled();
  });
});

describe("PostConfirmation Lambda — idempotency and failure", () => {
  it("idempotency: re-running on the same sub re-uses existing User + tenant", async () => {
    const existingUser = {
      id: "u_existing",
      email: "alice@example.com",
      subject: "cognito-sub-abc123",
      handle: "alice",
      role: "END_USER",
      personalTenantId: "t_existing_personal",
    };
    mockUserFindFirst.mockResolvedValue(existingUser);
    mockTenantFindUnique.mockResolvedValue({ slug: "personal-u_existing" });

    const handler = await loadHandler();
    await handler(makeEvent(), {} as any, () => {});
    await handler(makeEvent(), {} as any, () => {});

    expect(mockUserCreate).not.toHaveBeenCalled();
    expect(mockTenantCreate).not.toHaveBeenCalled();
    expect(mockTenantMemberUpsert).toHaveBeenCalledTimes(2);
    for (const call of mockTenantMemberUpsert.mock.calls) {
      expect(call[0].where.tenantId_userId.tenantId).toBe("t_existing_personal");
    }
  });

  it("transaction failure rolls back: nothing partially created (cache not primed)", async () => {
    mockTransaction.mockImplementationOnce(async (cb: any) => {
      const tx = makeTx();
      mockUserCreate.mockRejectedValueOnce(new Error("DB down"));
      return cb(tx);
    });
    const handler = await loadHandler();
    await expect(handler(makeEvent(), {} as any, () => {})).rejects.toThrow("DB down");
    const putCalls = mockDdbSend.mock.calls.filter(
      (c) => c[0].kind === "PUT",
    );
    expect(putCalls.length).toBe(0);
  });

  it("S-CP2: retries provisioning on a handle-collision (P2002) and succeeds", async () => {
    const { Prisma } = (await import("@prisma/client")) as unknown as {
      Prisma: {
        PrismaClientKnownRequestError: new (
          m: string,
          o: { code: string; meta: unknown },
        ) => Error;
      };
    };
    // First attempt loses the race on the unique `handle`; the wrapper retries
    // and the second attempt (default impl) succeeds.
    mockTransaction.mockImplementationOnce(async () => {
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint", {
        code: "P2002",
        meta: { target: ["handle"] },
      });
    });
    const handler = await loadHandler();
    await expect(
      handler(makeEvent(), {} as any, () => {}),
    ).resolves.toBeDefined();
    expect(mockTransaction).toHaveBeenCalledTimes(2);
  });

  it("S-CP2: does NOT retry on a non-handle unique violation", async () => {
    const { Prisma } = (await import("@prisma/client")) as unknown as {
      Prisma: {
        PrismaClientKnownRequestError: new (
          m: string,
          o: { code: string; meta: unknown },
        ) => Error;
      };
    };
    mockTransaction.mockImplementationOnce(async () => {
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint", {
        code: "P2002",
        meta: { target: ["email"] },
      });
    });
    const handler = await loadHandler();
    await expect(
      handler(makeEvent(), {} as any, () => {}),
    ).rejects.toThrow();
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it("links subject to an existing email-only user", async () => {
    mockUserFindFirst.mockResolvedValueOnce({
      id: "u_existing",
      email: "alice@example.com",
      subject: null,
      handle: "alice",
      role: "END_USER",
      personalTenantId: null,
    });
    const handler = await loadHandler();
    await handler(makeEvent(), {} as any, () => {});
    expect(mockUserUpdate).toHaveBeenCalled();
    const updateArgs = mockUserUpdate.mock.calls[0][0];
    expect(updateArgs.data.subject).toBe("cognito-sub-abc123");
  });

  it("derives a handle for an existing user that has none", async () => {
    mockUserFindFirst
      .mockResolvedValueOnce({
        id: "u_existing",
        email: "alice@example.com",
        subject: "cognito-sub-abc123",
        handle: null,
        role: "END_USER",
        personalTenantId: "t_personal",
      })
      .mockResolvedValue(null);
    mockTenantFindUnique.mockResolvedValue({ slug: "personal-u_existing" });
    const handler = await loadHandler();
    await handler(makeEvent(), {} as any, () => {});
    const updateArgs = mockUserUpdate.mock.calls.find((c) => c[0].data.handle);
    expect(updateArgs).toBeDefined();
    expect(updateArgs![0].data.handle).toBe("alice");
  });

  it("uses provided custom:handle when supplied", async () => {
    const handler = await loadHandler();
    await handler(makeEvent({ handle: "  customhandle  " }), {} as any, () => {});
    expect(mockUserCreate.mock.calls[0][0].data.handle).toBe("customhandle");
  });

  it("does not fail issuance when cache prime fails", async () => {
    mockDdbSend.mockImplementation(async (cmd: any) => {
      if (cmd.kind === "PUT") throw new Error("DDB throttled");
      return {};
    });
    const handler = await loadHandler();
    await expect(handler(makeEvent(), {} as any, () => {})).resolves.toBeDefined();
  });
});

describe("PostConfirmation Lambda — invitation gate", () => {
  // The PreSignUp invitation record now goes through @de-otio/saas-foundation's
  // KvStore port (not a raw DynamoDB PutItem), which the SDK mock cannot
  // intercept — so inject a MemoryKvStore and assert OUTCOME equivalence.
  it("burns the PreSignUp invitation record (used:true) when a code was presented", async () => {
    const { MemoryKvStore } = await import("@de-otio/saas-foundation/kv");
    const { __setInvitationStoreForTest } = await import(
      "../../src/lib/invitation-presignup-record.js"
    );
    const invStore = new MemoryKvStore();
    try {
      const handler = await loadHandler();
      __setInvitationStoreForTest(invStore); // override loadHandler's hermetic default
      await handler(makeEvent({ invitationCode: "invite99" }), {} as any, () => {});
      // The record is keyed to the UPPER-CASED code and marked used, so it
      // cannot be redeemed a second time.
      const rec = await invStore.get<{ used: boolean; usedBy?: string }>("INVITE99");
      expect(rec?.value.used).toBe(true);
      expect(rec?.value.usedBy).toBe("u_clxxxxxxxxxxxxxxxxxxxxxx");
    } finally {
      __setInvitationStoreForTest(null);
    }
  });

  it("does not touch the invitation record when no code was presented", async () => {
    const { MemoryKvStore } = await import("@de-otio/saas-foundation/kv");
    const { __setInvitationStoreForTest } = await import(
      "../../src/lib/invitation-presignup-record.js"
    );
    const invStore = new MemoryKvStore();
    try {
      const handler = await loadHandler();
      __setInvitationStoreForTest(invStore); // override loadHandler's hermetic default
      await handler(makeEvent(), {} as any, () => {});
      expect(await invStore.get("INVITE99")).toBeNull();
    } finally {
      __setInvitationStoreForTest(null);
    }
  });

  it("does not fail issuance when burning the invitation record fails", async () => {
    // Account provisioning has already committed; a store hiccup here must never
    // roll it back (best-effort, logged).
    const { MemoryKvStore } = await import("@de-otio/saas-foundation/kv");
    const { __setInvitationStoreForTest } = await import(
      "../../src/lib/invitation-presignup-record.js"
    );
    const failing = {
      ...new MemoryKvStore(),
      put: () => Promise.reject(new Error("KV store throttled")),
    } as unknown as import("@de-otio/saas-foundation/kv").KvStore;
    try {
      const handler = await loadHandler();
      __setInvitationStoreForTest(failing); // override loadHandler's hermetic default
      await expect(
        handler(makeEvent({ invitationCode: "invite99" }), {} as any, () => {}),
      ).resolves.toBeDefined();
    } finally {
      __setInvitationStoreForTest(null);
    }
  });
});
