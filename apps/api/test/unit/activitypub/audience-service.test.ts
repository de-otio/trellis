/**
 * Unit Tests: CustomAudienceService
 *
 * Covers validation guards and member CRUD for the ActivityPub custom audience service.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before the SUT import so vi.mock hoisting
// fires in the right order.
// ---------------------------------------------------------------------------

const { mockGetActivityPubBaseUrl, MockOrderedCollection, mockGenerateActorUri } =
  vi.hoisted(() => {
    const mockGetActivityPubBaseUrl = vi.fn(() => "https://ap.example.org");
    class MockOrderedCollection {
      constructor(opts: Record<string, unknown>) {
        Object.assign(this, opts);
      }
    }
    const mockGenerateActorUri = vi.fn(
      (username: string) => `https://ap.example.org/users/${username}`,
    );
    return { mockGetActivityPubBaseUrl, MockOrderedCollection, mockGenerateActorUri };
  });

// fedify 2 moved vocab classes to the `/vocab` subpath; mock that, not the root.
vi.mock("@fedify/fedify/vocab", () => ({
  OrderedCollection: MockOrderedCollection,
}));

vi.mock("../../../src/lib/activitypub/fedify/context.js", () => ({
  getActivityPubBaseUrl: mockGetActivityPubBaseUrl,
}));

vi.mock("../../../src/lib/activitypub/dispatchers/user-actor.js", () => ({
  UserActorDispatcher: {
    generateActorUri: mockGenerateActorUri,
  },
}));

vi.mock("../../../src/lib/logger.js", () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  Logger: class {
    debug = vi.fn();
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks are registered
// ---------------------------------------------------------------------------

import { CustomAudienceService } from "../../../src/lib/activitypub/audience-service.js";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

function makePrisma() {
  return {
    user: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    customAudience: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    customAudienceMember: {
      createMany: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
  } as any;
}

const env = {} as any;

/** A fully-provisioned ActivityPub creator user */
const creator = {
  id: "u1",
  actorUri: "https://ap.example.org/users/alice",
  publicKey: "PUBKEY",
} as any;

// ---------------------------------------------------------------------------
// generateCollectionUri
// ---------------------------------------------------------------------------

describe("generateCollectionUri", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActivityPubBaseUrl.mockReturnValue("https://ap.example.org");
  });

  it("returns <baseUrl>/audiences/<id>", () => {
    const uri = CustomAudienceService.generateCollectionUri("aud-42", env);
    expect(uri).toBe("https://ap.example.org/audiences/aud-42");
  });

  it("delegates to getActivityPubBaseUrl with the supplied env and requestUrl", () => {
    CustomAudienceService.generateCollectionUri("aud-1", env, "https://req.example.org/path");
    expect(mockGetActivityPubBaseUrl).toHaveBeenCalledWith(
      env,
      "https://req.example.org/path",
    );
  });
});

// ---------------------------------------------------------------------------
// createAudience — validation guards
// ---------------------------------------------------------------------------

describe("createAudience — validation guards", () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
    mockGetActivityPubBaseUrl.mockReturnValue("https://ap.example.org");
  });

  it("throws when creator lacks actorUri", async () => {
    const badCreator = { ...creator, actorUri: null };
    await expect(
      CustomAudienceService.createAudience(prisma, badCreator, "My list", ["uid1"], env),
    ).rejects.toThrow("Creator does not have ActivityPub fields set");
  });

  it("throws when creator lacks publicKey", async () => {
    const badCreator = { ...creator, publicKey: null };
    await expect(
      CustomAudienceService.createAudience(prisma, badCreator, "My list", ["uid1"], env),
    ).rejects.toThrow("Creator does not have ActivityPub fields set");
  });

  it("throws when name is empty string", async () => {
    await expect(
      CustomAudienceService.createAudience(prisma, creator, "", ["uid1"], env),
    ).rejects.toThrow("Audience name is required");
  });

  it("throws when name is whitespace only", async () => {
    await expect(
      CustomAudienceService.createAudience(prisma, creator, "   ", ["uid1"], env),
    ).rejects.toThrow("Audience name is required");
  });

  it("throws when name exceeds 100 characters", async () => {
    const longName = "a".repeat(101);
    await expect(
      CustomAudienceService.createAudience(prisma, creator, longName, ["uid1"], env),
    ).rejects.toThrow("Audience name must be 100 characters or less");
  });

  it("accepts a name that is exactly 100 characters (boundary)", async () => {
    const name100 = "a".repeat(100);
    // findMany returns 1 row so the member check passes
    prisma.user.findMany.mockResolvedValue([{ id: "uid1" }]);
    prisma.customAudience.create.mockResolvedValue({
      id: "aud-1",
      name: name100,
      creatorId: creator.id,
      collectionId: "",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.customAudience.update.mockResolvedValue({
      id: "aud-1",
      name: name100,
      creatorId: creator.id,
      collectionId: "https://ap.example.org/audiences/aud-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.customAudienceMember.createMany.mockResolvedValue({ count: 1 });

    await expect(
      CustomAudienceService.createAudience(prisma, creator, name100, ["uid1"], env),
    ).resolves.toBeDefined();
  });

  it("throws when memberIds is empty", async () => {
    await expect(
      CustomAudienceService.createAudience(prisma, creator, "Audience A", [], env),
    ).rejects.toThrow("Audience must have at least one member");
  });

  it("throws when memberIds exceeds 1000", async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `uid-${i}`);
    await expect(
      CustomAudienceService.createAudience(prisma, creator, "Audience B", ids, env),
    ).rejects.toThrow("Audience cannot have more than 1000 members");
  });

  it("throws when some members are not found (fewer rows than ids)", async () => {
    // Two ids but only one row back — one member is deleted/suspended/missing AP fields
    prisma.user.findMany.mockResolvedValue([{ id: "uid1" }]);
    await expect(
      CustomAudienceService.createAudience(
        prisma,
        creator,
        "Audience C",
        ["uid1", "uid2"],
        env,
      ),
    ).rejects.toThrow("Some members not found or not configured for ActivityPub");
  });
});

// ---------------------------------------------------------------------------
// createAudience — happy path
// ---------------------------------------------------------------------------

describe("createAudience — happy path", () => {
  let prisma: ReturnType<typeof makePrisma>;
  const createdAt = new Date("2024-01-01T00:00:00Z");
  const updatedAt = new Date("2024-01-01T00:00:01Z");

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
    mockGetActivityPubBaseUrl.mockReturnValue("https://ap.example.org");

    prisma.user.findMany.mockResolvedValue([{ id: "uid1" }, { id: "uid2" }]);
    prisma.customAudience.create.mockResolvedValue({
      id: "aud-99",
      name: "Friends",
      creatorId: creator.id,
      collectionId: "",
      createdAt,
      updatedAt,
    });
    prisma.customAudience.update.mockResolvedValue({
      id: "aud-99",
      name: "Friends",
      creatorId: creator.id,
      collectionId: "https://ap.example.org/audiences/aud-99",
      createdAt,
      updatedAt,
    });
    prisma.customAudienceMember.createMany.mockResolvedValue({ count: 2 });
  });

  it("creates audience and returns shaped object with collectionId", async () => {
    const result = await CustomAudienceService.createAudience(
      prisma,
      creator,
      "Friends",
      ["uid1", "uid2"],
      env,
    );

    expect(result).toEqual({
      id: "aud-99",
      name: "Friends",
      creatorId: creator.id,
      collectionId: "https://ap.example.org/audiences/aud-99",
      createdAt,
      updatedAt,
    });
  });

  it("calls user.findMany with the supplied memberIds", async () => {
    await CustomAudienceService.createAudience(
      prisma,
      creator,
      "Friends",
      ["uid1", "uid2"],
      env,
    );

    expect(prisma.user.findMany).toHaveBeenCalledOnce();
    const call = prisma.user.findMany.mock.calls[0][0];
    expect(call.where.id).toEqual({ in: ["uid1", "uid2"] });
    expect(call.where.suspended).toBe(false);
    expect(call.where.deletionConfirmedAt).toBeNull();
  });

  it("calls customAudience.create with trimmed name and creatorId", async () => {
    await CustomAudienceService.createAudience(
      prisma,
      creator,
      "  Friends  ",
      ["uid1", "uid2"],
      env,
    );

    expect(prisma.customAudience.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: "Friends", creatorId: creator.id }),
    });
  });

  it("calls customAudience.update with generated collectionId", async () => {
    await CustomAudienceService.createAudience(
      prisma,
      creator,
      "Friends",
      ["uid1", "uid2"],
      env,
    );

    expect(prisma.customAudience.update).toHaveBeenCalledWith({
      where: { id: "aud-99" },
      data: { collectionId: "https://ap.example.org/audiences/aud-99" },
    });
  });

  it("calls customAudienceMember.createMany with skipDuplicates", async () => {
    await CustomAudienceService.createAudience(
      prisma,
      creator,
      "Friends",
      ["uid1", "uid2"],
      env,
    );

    expect(prisma.customAudienceMember.createMany).toHaveBeenCalledWith({
      data: [
        { audienceId: "aud-99", memberId: "uid1" },
        { audienceId: "aud-99", memberId: "uid2" },
      ],
      skipDuplicates: true,
    });
  });
});

// ---------------------------------------------------------------------------
// addMember
// ---------------------------------------------------------------------------

describe("addMember", () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
  });

  const validMember = {
    id: "uid5",
    actorUri: "https://ap.example.org/users/bob",
    publicKey: "BOBKEY",
    suspended: false,
    deletionConfirmedAt: null,
  };

  it("throws when user is not found (null)", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(
      CustomAudienceService.addMember(prisma, "aud-1", "uid5"),
    ).rejects.toThrow("Member not found or not configured for ActivityPub");
  });

  it("throws when user lacks actorUri", async () => {
    prisma.user.findUnique.mockResolvedValue({ ...validMember, actorUri: null });
    await expect(
      CustomAudienceService.addMember(prisma, "aud-1", "uid5"),
    ).rejects.toThrow("Member not found or not configured for ActivityPub");
  });

  it("throws when user lacks publicKey", async () => {
    prisma.user.findUnique.mockResolvedValue({ ...validMember, publicKey: null });
    await expect(
      CustomAudienceService.addMember(prisma, "aud-1", "uid5"),
    ).rejects.toThrow("Member not found or not configured for ActivityPub");
  });

  it("throws when user is suspended", async () => {
    prisma.user.findUnique.mockResolvedValue({ ...validMember, suspended: true });
    await expect(
      CustomAudienceService.addMember(prisma, "aud-1", "uid5"),
    ).rejects.toThrow("Cannot add suspended or deleted user to audience");
  });

  it("throws when user has deletionConfirmedAt set", async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...validMember,
      deletionConfirmedAt: new Date(),
    });
    await expect(
      CustomAudienceService.addMember(prisma, "aud-1", "uid5"),
    ).rejects.toThrow("Cannot add suspended or deleted user to audience");
  });

  it("happy path: calls customAudienceMember.create with audienceId + memberId", async () => {
    prisma.user.findUnique.mockResolvedValue(validMember);
    prisma.customAudienceMember.create.mockResolvedValue({ audienceId: "aud-1", memberId: "uid5" });

    await CustomAudienceService.addMember(prisma, "aud-1", "uid5");

    expect(prisma.customAudienceMember.create).toHaveBeenCalledWith({
      data: { audienceId: "aud-1", memberId: "uid5" },
    });
  });

  it("swallows a P2002 unique-constraint violation (idempotent re-add)", async () => {
    prisma.user.findUnique.mockResolvedValue(validMember);
    const p2002 = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    prisma.customAudienceMember.create.mockRejectedValue(p2002);

    // Should not throw
    await expect(
      CustomAudienceService.addMember(prisma, "aud-1", "uid5"),
    ).resolves.toBeUndefined();
  });

  it("rethrows non-P2002 errors", async () => {
    prisma.user.findUnique.mockResolvedValue(validMember);
    const dbError = Object.assign(new Error("Connection error"), { code: "P2021" });
    prisma.customAudienceMember.create.mockRejectedValue(dbError);

    await expect(
      CustomAudienceService.addMember(prisma, "aud-1", "uid5"),
    ).rejects.toThrow("Connection error");
  });
});

// ---------------------------------------------------------------------------
// removeMember
// ---------------------------------------------------------------------------

describe("removeMember", () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
  });

  it("calls deleteMany with audienceId and memberId", async () => {
    prisma.customAudienceMember.deleteMany.mockResolvedValue({ count: 1 });

    await CustomAudienceService.removeMember(prisma, "aud-1", "uid5");

    expect(prisma.customAudienceMember.deleteMany).toHaveBeenCalledWith({
      where: { audienceId: "aud-1", memberId: "uid5" },
    });
  });

  it("does not throw when the member is not in the audience (deleteMany returns 0)", async () => {
    prisma.customAudienceMember.deleteMany.mockResolvedValue({ count: 0 });
    await expect(
      CustomAudienceService.removeMember(prisma, "aud-1", "uid-missing"),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getMembers
// ---------------------------------------------------------------------------

describe("getMembers", () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
    mockGenerateActorUri.mockImplementation(
      (username: string) => `https://ap.example.org/users/${username}`,
    );
  });

  it("returns [] when audience is not found", async () => {
    prisma.customAudience.findUnique.mockResolvedValue(null);
    const result = await CustomAudienceService.getMembers(prisma, "aud-x", env);
    expect(result).toEqual([]);
  });

  it("maps members to actor URIs via UserActorDispatcher", async () => {
    prisma.customAudience.findUnique.mockResolvedValue({
      id: "aud-1",
      members: [
        { member: { id: "u2", actorUri: "https://ap.example.org/users/bob", username: "bob" } },
        { member: { id: "u3", actorUri: "https://ap.example.org/users/carol", username: "carol" } },
      ],
    });

    const result = await CustomAudienceService.getMembers(prisma, "aud-1", env);

    expect(result).toEqual([
      "https://ap.example.org/users/bob",
      "https://ap.example.org/users/carol",
    ]);
    expect(mockGenerateActorUri).toHaveBeenCalledWith("bob", env);
    expect(mockGenerateActorUri).toHaveBeenCalledWith("carol", env);
  });

  it("filters out members missing actorUri", async () => {
    prisma.customAudience.findUnique.mockResolvedValue({
      id: "aud-1",
      members: [
        { member: { id: "u2", actorUri: null, username: "bob" } },
        { member: { id: "u3", actorUri: "https://ap.example.org/users/carol", username: "carol" } },
      ],
    });

    const result = await CustomAudienceService.getMembers(prisma, "aud-1", env);
    expect(result).toEqual(["https://ap.example.org/users/carol"]);
  });

  it("filters out members missing username", async () => {
    prisma.customAudience.findUnique.mockResolvedValue({
      id: "aud-1",
      members: [
        { member: { id: "u2", actorUri: "https://ap.example.org/users/bob", username: null } },
        { member: { id: "u3", actorUri: "https://ap.example.org/users/carol", username: "carol" } },
      ],
    });

    const result = await CustomAudienceService.getMembers(prisma, "aud-1", env);
    expect(result).toEqual(["https://ap.example.org/users/carol"]);
  });

  it("returns [] when all members are missing AP fields", async () => {
    prisma.customAudience.findUnique.mockResolvedValue({
      id: "aud-1",
      members: [
        { member: { id: "u2", actorUri: null, username: null } },
      ],
    });

    const result = await CustomAudienceService.getMembers(prisma, "aud-1", env);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveCollection
// ---------------------------------------------------------------------------

describe("resolveCollection", () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
    mockGenerateActorUri.mockImplementation(
      (username: string) => `https://ap.example.org/users/${username}`,
    );
  });

  it("returns [] for a URI that does not contain /audiences/<id>", async () => {
    const result = await CustomAudienceService.resolveCollection(
      prisma,
      "https://ap.example.org/other/path",
      env,
    );
    expect(result).toEqual([]);
    expect(prisma.customAudience.findUnique).not.toHaveBeenCalled();
  });

  it("extracts audience id and delegates to getMembers", async () => {
    prisma.customAudience.findUnique.mockResolvedValue({
      id: "aud-77",
      members: [
        { member: { id: "u1", actorUri: "https://ap.example.org/users/alice", username: "alice" } },
      ],
    });

    const result = await CustomAudienceService.resolveCollection(
      prisma,
      "https://ap.example.org/audiences/aud-77",
      env,
    );

    expect(prisma.customAudience.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "aud-77" } }),
    );
    expect(result).toEqual(["https://ap.example.org/users/alice"]);
  });

  it("handles query params in collection URI (id stops at ?)", async () => {
    prisma.customAudience.findUnique.mockResolvedValue({
      id: "aud-88",
      members: [],
    });

    await CustomAudienceService.resolveCollection(
      prisma,
      "https://ap.example.org/audiences/aud-88?page=2",
      env,
    );

    expect(prisma.customAudience.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "aud-88" } }),
    );
  });
});

// ---------------------------------------------------------------------------
// createOrderedCollection
// ---------------------------------------------------------------------------

describe("createOrderedCollection", () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
    mockGenerateActorUri.mockImplementation(
      (username: string) => `https://ap.example.org/users/${username}`,
    );
  });

  it("throws when audience is not found", async () => {
    prisma.customAudience.findUnique.mockResolvedValue(null);
    await expect(
      CustomAudienceService.createOrderedCollection(prisma, "aud-x", env),
    ).rejects.toThrow("Audience not found");
  });

  it("throws when audience has no collectionId", async () => {
    prisma.customAudience.findUnique.mockResolvedValue({
      id: "aud-2",
      collectionId: null,
      members: [],
    });
    await expect(
      CustomAudienceService.createOrderedCollection(prisma, "aud-2", env),
    ).rejects.toThrow("Audience not found");
  });

  it("returns an OrderedCollection with totalItems set", async () => {
    prisma.customAudience.findUnique.mockResolvedValue({
      id: "aud-3",
      collectionId: "https://ap.example.org/audiences/aud-3",
      members: [
        { member: { id: "u1", actorUri: "https://ap.example.org/users/alice", username: "alice" }, addedAt: new Date() },
      ],
    });
    prisma.customAudienceMember.count.mockResolvedValue(1);

    const collection = await CustomAudienceService.createOrderedCollection(
      prisma,
      "aud-3",
      env,
    );

    expect((collection as any).totalItems).toBe(1);
    // Verify it is an instance of our mock class (not real Fedify)
    expect(collection).toBeInstanceOf(MockOrderedCollection);
  });

  it("sets orderedItems from member actor URIs", async () => {
    prisma.customAudience.findUnique.mockResolvedValue({
      id: "aud-4",
      collectionId: "https://ap.example.org/audiences/aud-4",
      members: [
        { member: { id: "u1", actorUri: "https://ap.example.org/users/alice", username: "alice" }, addedAt: new Date() },
        { member: { id: "u2", actorUri: null, username: null }, addedAt: new Date() }, // filtered
      ],
    });
    prisma.customAudienceMember.count.mockResolvedValue(1);

    const collection = await CustomAudienceService.createOrderedCollection(
      prisma,
      "aud-4",
      env,
    );

    const items: URL[] = (collection as any).orderedItems;
    expect(items).toHaveLength(1);
    expect(items[0]).toBeInstanceOf(URL);
    expect(items[0].toString()).toBe("https://ap.example.org/users/alice");
  });
});
