/**
 * Unit Tests: Activity Processor
 *
 * Tests for ActivityPub activity processing.
 *
 * Logger note (1.B.3 Track C): wherever the production code performs a
 * DB write or invokes `FriendshipService`, that is the outcome we
 * assert on. Where the code path is "validate inputs and bail" (e.g.
 * missing actor/object, unknown activity type), there's no other
 * side-effect than a warn log — those branches use
 * `createTestLogCapture` from `@de-otio/saas-foundation/logger`
 * (0.2.3+) and assert on the captured record's level + msg pattern.
 * A few cases (Phase 1 stub processors like Announce/Reject) only log
 * an "I saw this activity" info record; those also use the capture.
 *
 * The deliberate non-mock is `FriendshipService`, which we DO mock —
 * it is a real outcome surface (it's the boundary the processor calls
 * across), and the alternative (running the real service over an
 * in-memory store) belongs to phase 1.C.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogCapture } from "@de-otio/saas-foundation/logger";
import { ActivityProcessor } from "../../../src/lib/activitypub/activity-processor.js";
import type { ActivityStreamsActivity } from "../../../src/lib/activitypub/activity-service.js";
import type { PrismaClient, User } from "@prisma/client";

// Mock FriendshipService — a real outcome surface (boundary call).
vi.mock("../../../src/lib/activitypub/friendship-service", () => ({
  FriendshipService: {
    acceptFriendship: vi.fn().mockResolvedValue({}),
    createFriendship: vi.fn().mockResolvedValue({}),
  },
}));

type MockPrisma = {
  user: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  post: { findFirst: ReturnType<typeof vi.fn> };
  postSentiment: { upsert: ReturnType<typeof vi.fn> };
  follow: { upsert: ReturnType<typeof vi.fn> };
  entity: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  group: { findUnique: ReturnType<typeof vi.fn> };
  groupMember: {
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  directMessage: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
};

describe("ActivityProcessor", () => {
  let mockPrisma: MockPrisma;
  let mockUser: User;
  let mockEnv: { LOG_LEVEL: string };
  let capture: ReturnType<typeof createTestLogCapture>;

  beforeEach(() => {
    mockPrisma = {
      user: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
      },
      post: {
        findFirst: vi.fn(),
      },
      postSentiment: {
        upsert: vi.fn(),
      },
      follow: {
        upsert: vi.fn(),
      },
      entity: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
      },
      group: {
        findUnique: vi.fn(),
      },
      groupMember: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
      directMessage: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
    };
    mockUser = {
      id: "user-1",
      email: "alice@example.com",
      username: "alice",
      role: "END_USER",
      createdAt: new Date(),
      actorUri: "https://example.com/users/alice",
      inboxUrl: "https://example.com/users/alice/inbox",
      outboxUrl: "https://example.com/users/alice/outbox",
      followersUrl: "https://example.com/users/alice/followers",
      followingUrl: "https://example.com/users/alice/following",
      friendsUrl: null,
      publicKey: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
      privateKey:
        "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
    } as User;

    mockEnv = {
      LOG_LEVEL: "info",
    };

    capture = createTestLogCapture();
    capture.installAsRoot();
  });

  afterEach(() => {
    capture.restore();
    vi.clearAllMocks();
  });

  const runActivity = (
    activity: Record<string, unknown>,
    user: User = mockUser,
  ) =>
    ActivityProcessor.processActivity(
      mockPrisma as unknown as PrismaClient,
      activity as unknown as ActivityStreamsActivity,
      user,
      mockEnv,
    );

  describe("processActivity", () => {
    it("should process Create activity", async () => {
      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        type: "Create",
        id: "https://example.com/activities/1",
        actor: "https://example.com/users/bob",
        object: {
          id: "https://example.com/posts/123",
          type: "Note",
          content: "Hello world",
        },
      };

      // Phase-1 Create with no bto is a stub that only emits a log;
      // the log emission IS the only observable behaviour.
      await runActivity(activity);

      expect(capture.entries()).toContainEqual(
        expect.objectContaining({
          level: "info",
          msg: expect.stringMatching(/Processing Create activity/),
          activityId: "https://example.com/activities/1",
          actorUri: "https://example.com/users/bob",
        }),
      );
    });

    it("should process Follow activity", async () => {
      const activity = {
        type: "Follow",
        id: "https://example.com/activities/2",
        actor: "https://example.com/users/bob",
        object: "https://example.com/users/alice",
      };

      // Mock Prisma calls for Follow processing
      mockPrisma.group.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "user-bob",
        actorUri: "https://example.com/users/bob",
      });
      mockPrisma.follow.upsert.mockResolvedValue({});

      await runActivity(activity);

      // Outcome: the Follow code path reads the target user.
      expect(mockPrisma.user.findUnique).toHaveBeenCalled();
    });

    describe("Like activity processing", () => {
      it("should process Like activity with sentiment", async () => {
        const activity = {
          type: "Like",
          id: "https://example.com/activities/3",
          actor: "https://example.com/users/bob",
          object: "https://example.com/posts/123",
          "trellis:sentiment": "joy",
        };

        // Mock post lookup
        mockPrisma.post.findFirst.mockResolvedValue({
          id: "post-123",
          objectId: "https://example.com/posts/123",
          authorId: "user-1",
        });

        // Mock actor lookup
        mockPrisma.user.findUnique.mockResolvedValue({
          id: "user-bob",
        });

        // Mock sentiment upsert
        mockPrisma.postSentiment.upsert.mockResolvedValue({
          id: "sentiment-1",
          postId: "post-123",
          authorId: "user-bob",
          sentiment: "joy",
        });

        await runActivity(activity);

        expect(mockPrisma.post.findFirst).toHaveBeenCalled();
        expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
          where: { actorUri: "https://example.com/users/bob" },
          select: { id: true },
        });
        expect(mockPrisma.postSentiment.upsert).toHaveBeenCalledWith({
          where: {
            postId_authorId: {
              postId: "post-123",
              authorId: "user-bob",
            },
          },
          create: {
            postId: "post-123",
            postUri: "https://example.com/posts/123",
            authorId: "user-bob",
            sentiment: "joy",
          },
          update: {
            sentiment: "joy",
          },
        });
      });

      it("should default to love sentiment if not specified", async () => {
        const activity = {
          type: "Like",
          id: "https://example.com/activities/4",
          actor: "https://example.com/users/bob",
          object: "https://example.com/posts/123",
          // No sentiment property
        };

        mockPrisma.post.findFirst.mockResolvedValue({
          id: "post-123",
          objectId: "https://example.com/posts/123",
          authorId: "user-1",
        });

        mockPrisma.user.findUnique.mockResolvedValue({
          id: "user-bob",
        });

        mockPrisma.postSentiment.upsert.mockResolvedValue({
          id: "sentiment-1",
          postId: "post-123",
          authorId: "user-bob",
          sentiment: "love",
        });

        await runActivity(activity);

        expect(mockPrisma.postSentiment.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            create: expect.objectContaining({
              sentiment: "love",
            }),
            update: expect.objectContaining({
              sentiment: "love",
            }),
          }),
        );
      });

      it("should handle Like activity with different sentiment types", async () => {
        const sentiments = [
          "joy",
          "gratitude",
          "calm",
          "love",
          "hope",
          "compassion",
          "awe",
          "sadness",
          "anger",
          "fear",
          "insightful",
        ];

        for (const sentiment of sentiments) {
          const activity = {
            type: "Like",
            id: `https://example.com/activities/like-${sentiment}`,
            actor: "https://example.com/users/bob",
            object: "https://example.com/posts/123",
            "trellis:sentiment": sentiment,
          };

          mockPrisma.post.findFirst.mockResolvedValue({
            id: "post-123",
            objectId: "https://example.com/posts/123",
            authorId: "user-1",
          });

          mockPrisma.user.findUnique.mockResolvedValue({
            id: "user-bob",
          });

          mockPrisma.postSentiment.upsert.mockResolvedValue({
            id: `sentiment-${sentiment}`,
            postId: "post-123",
            authorId: "user-bob",
            sentiment,
          });

          await runActivity(activity);

          expect(mockPrisma.postSentiment.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
              create: expect.objectContaining({
                sentiment,
              }),
            }),
          );
        }
      });

      it("should not store sentiment when post not found", async () => {
        const activity = {
          type: "Like",
          id: "https://example.com/activities/5",
          actor: "https://example.com/users/bob",
          object: "https://example.com/posts/999",
          "trellis:sentiment": "joy",
        };

        mockPrisma.post.findFirst.mockResolvedValue(null);

        await runActivity(activity);

        // Outcome: no upsert happens when the target post is missing.
        expect(mockPrisma.postSentiment.upsert).not.toHaveBeenCalled();
      });

      it("should not store sentiment when actor not found", async () => {
        const activity = {
          type: "Like",
          id: "https://example.com/activities/6",
          actor: "https://example.com/users/unknown",
          object: "https://example.com/posts/123",
          "trellis:sentiment": "joy",
        };

        mockPrisma.post.findFirst.mockResolvedValue({
          id: "post-123",
          objectId: "https://example.com/posts/123",
          authorId: "user-1",
        });

        mockPrisma.user.findUnique.mockResolvedValue(null);

        await runActivity(activity);

        // Outcome: no upsert when the actor can't be resolved.
        expect(mockPrisma.postSentiment.upsert).not.toHaveBeenCalled();
      });

      it("should not store sentiment when activity missing actor or object", async () => {
        const activity = {
          type: "Like",
          id: "https://example.com/activities/7",
          // Missing actor or object
        };

        await runActivity(activity);

        // Outcome: validation rejection means no upsert is attempted.
        expect(mockPrisma.postSentiment.upsert).not.toHaveBeenCalled();
      });

      it("should propagate upsert errors and not swallow them", async () => {
        const activity = {
          type: "Like",
          id: "https://example.com/activities/8",
          actor: "https://example.com/users/bob",
          object: "https://example.com/posts/123",
          "trellis:sentiment": "joy",
        };

        mockPrisma.post.findFirst.mockResolvedValue({
          id: "post-123",
          objectId: "https://example.com/posts/123",
          authorId: "user-1",
        });

        mockPrisma.user.findUnique.mockResolvedValue({
          id: "user-bob",
        });

        const error = new Error("Database error");
        mockPrisma.postSentiment.upsert.mockRejectedValue(error);

        // Outcome: errors bubble up so the queue worker can retry.
        await expect(runActivity(activity)).rejects.toThrow("Database error");
      });
    });

    it("should process Announce activity", async () => {
      const activity = {
        type: "Announce",
        id: "https://example.com/activities/4",
        actor: "https://example.com/users/bob",
        object: "https://example.com/posts/123",
      };

      // Announce is a Phase-1 stub — log emission is the only behaviour.
      await runActivity(activity);

      expect(capture.entries()).toContainEqual(
        expect.objectContaining({
          level: "info",
          msg: expect.stringMatching(/Processing Announce activity/),
          activityId: "https://example.com/activities/4",
          actorUri: "https://example.com/users/bob",
        }),
      );
    });

    it("should process Accept activity", async () => {
      const activity = {
        type: "Accept",
        id: "https://example.com/activities/5",
        actor: "https://example.com/users/alice",
        object: {
          type: "Follow",
          actor: "https://example.com/users/bob",
          object: "https://example.com/users/alice",
        },
      };

      await runActivity(activity);

      // Accept's processing log is the entry point; downstream outcome
      // (FriendshipService.acceptFriendship) is covered in a dedicated
      // test below.
      expect(capture.entries()).toContainEqual(
        expect.objectContaining({
          level: "info",
          msg: expect.stringMatching(/Processing Accept activity/),
          activityId: "https://example.com/activities/5",
        }),
      );
    });

    it("should process Reject activity", async () => {
      const activity = {
        type: "Reject",
        id: "https://example.com/activities/6",
        actor: "https://example.com/users/alice",
        object: {
          type: "Follow",
          actor: "https://example.com/users/bob",
          object: "https://example.com/users/alice",
        },
      };

      // Reject is a Phase-1 stub — log emission is the only behaviour.
      await runActivity(activity);

      expect(capture.entries()).toContainEqual(
        expect.objectContaining({
          level: "info",
          msg: expect.stringMatching(/Processing Reject activity/),
          activityId: "https://example.com/activities/6",
        }),
      );
    });

    it("should process Undo activity", async () => {
      const activity = {
        type: "Undo",
        id: "https://example.com/activities/7",
        actor: "https://example.com/users/bob",
        object: {
          type: "Like",
          actor: "https://example.com/users/bob",
          object: "https://example.com/posts/123",
        },
      };

      // Undo is a Phase-1 stub for non-Follow inner types — log only.
      await runActivity(activity);

      expect(capture.entries()).toContainEqual(
        expect.objectContaining({
          level: "info",
          msg: expect.stringMatching(/Processing Undo activity/),
          activityId: "https://example.com/activities/7",
        }),
      );
    });

    it("should warn on unknown activity type", async () => {
      const activity = {
        type: "UnknownActivity",
        id: "https://example.com/activities/8",
        actor: "https://example.com/users/bob",
      };

      // Unknown activity types have no DB write or other outcome; the
      // warn record IS the operator-facing signal.
      await runActivity(activity);

      expect(capture.entries()).toContainEqual(
        expect.objectContaining({
          level: "warn",
          msg: expect.stringMatching(/Unknown activity type/),
          activityType: "UnknownActivity",
          actorUri: "https://example.com/users/bob",
        }),
      );
    });

    it("should handle string actor", async () => {
      const activity = {
        type: "Create",
        actor: "https://example.com/users/bob",
        object: {
          id: "https://example.com/posts/123",
        },
      };

      await runActivity(activity);

      expect(capture.entries()).toContainEqual(
        expect.objectContaining({
          level: "info",
          msg: expect.stringMatching(/Processing Create activity/),
          actorUri: "https://example.com/users/bob",
        }),
      );
    });

    it("should handle object actor", async () => {
      const activity = {
        type: "Create",
        actor: {
          id: "https://example.com/users/bob",
          type: "Person",
        },
        object: {
          id: "https://example.com/posts/123",
        },
      };

      await runActivity(activity);

      expect(capture.entries()).toContainEqual(
        expect.objectContaining({
          level: "info",
          msg: expect.stringMatching(/Processing Create activity/),
          actorUri: "https://example.com/users/bob",
        }),
      );
    });

    describe("Direct Message processing", () => {
      it("should process Create activity as DM when bto is present and to is not", async () => {
        const activity = {
          type: "Create",
          id: "https://example.com/activities/dm-1",
          actor: "https://example.com/users/bob",
          bto: ["https://example.com/users/alice"],
          object: {
            id: "https://example.com/notes/dm-1",
            type: "Note",
            content: "Hello, this is a DM",
          },
        };

        const sender = {
          id: "user-bob",
          actorUri: "https://example.com/users/bob",
        };

        mockPrisma.user.findFirst.mockResolvedValue(sender);
        mockPrisma.directMessage.findFirst.mockResolvedValue(null);
        mockPrisma.directMessage.create.mockResolvedValue({
          id: "dm-1",
          senderId: "user-bob",
          recipientId: "user-1",
        });

        await runActivity(activity);

        // Outcome: a DM row is written.
        expect(mockPrisma.directMessage.create).toHaveBeenCalled();
      });

      it("strips markup from remote DM content before storing it (DP-14)", async () => {
        const activity = {
          type: "Create",
          id: "https://example.com/activities/dm-x",
          actor: "https://example.com/users/bob",
          bto: ["https://example.com/users/alice"],
          object: {
            id: "https://example.com/notes/dm-x",
            type: "Note",
            content:
              '<p>hi <b>there</b></p><script>alert(1)</script><img src=x onerror="alert(2)">&lt;script&gt;',
          },
        };

        mockPrisma.user.findFirst.mockResolvedValue({
          id: "user-bob",
          actorUri: "https://example.com/users/bob",
        });
        mockPrisma.directMessage.findFirst.mockResolvedValue(null);
        mockPrisma.directMessage.create.mockResolvedValue({ id: "dm-x" });

        await runActivity(activity);

        expect(mockPrisma.directMessage.create).toHaveBeenCalledTimes(1);
        const stored = mockPrisma.directMessage.create.mock.calls[0][0].data.text;
        // Real markup and the script BODY are gone.
        expect(stored).not.toMatch(/onerror|<img|<b>|alert\(/);
        expect(stored).toContain("hi there");
        // The ENCODED tag survives only as literal text (decoded after the
        // strip pass), never as a tag with a body behind it.
        expect(stored).toContain("<script>");
      });

      it("should not store DM when user missing actorUri", async () => {
        const activity = {
          type: "Create",
          actor: "https://example.com/users/bob",
          bto: ["https://example.com/users/alice"],
          object: {
            id: "https://example.com/notes/dm-1",
            type: "Note",
            content: "Hello",
          },
        };

        const userWithoutActorId = {
          ...mockUser,
          actorUri: null,
        } as User;

        await runActivity(activity, userWithoutActorId);

        // Outcome: no DM row when the recipient user has no actorUri.
        expect(mockPrisma.directMessage.create).not.toHaveBeenCalled();
      });

      it("should not store DM when recipient not in bto", async () => {
        const activity = {
          type: "Create",
          actor: "https://example.com/users/bob",
          bto: ["https://example.com/users/charlie"], // Different recipient
          object: {
            id: "https://example.com/notes/dm-1",
            type: "Note",
            content: "Hello",
          },
        };

        await runActivity(activity);

        // Outcome: no DM row when the recipient is not addressed.
        expect(mockPrisma.directMessage.create).not.toHaveBeenCalled();
      });

      it("should handle bto as array", async () => {
        const activity = {
          type: "Create",
          actor: "https://example.com/users/bob",
          bto: [mockUser.actorUri, "https://example.com/users/charlie"],
          object: {
            id: "https://example.com/notes/dm-1",
            type: "Note",
            content: "Hello",
          },
        };

        const sender = {
          id: "user-bob",
          actorUri: "https://example.com/users/bob",
        };

        mockPrisma.user.findFirst.mockResolvedValue(sender);
        mockPrisma.directMessage.findFirst.mockResolvedValue(null);
        mockPrisma.directMessage.create.mockResolvedValue({});

        await runActivity(activity);

        expect(mockPrisma.directMessage.create).toHaveBeenCalled();
      });

      it("should handle bto as single value", async () => {
        const activity = {
          type: "Create",
          actor: "https://example.com/users/bob",
          bto: mockUser.actorUri, // Single value, not array
          object: {
            id: "https://example.com/notes/dm-1",
            type: "Note",
            content: "Hello",
          },
        };

        const sender = {
          id: "user-bob",
          actorUri: "https://example.com/users/bob",
        };

        mockPrisma.user.findFirst.mockResolvedValue(sender);
        mockPrisma.directMessage.findFirst.mockResolvedValue(null);
        mockPrisma.directMessage.create.mockResolvedValue({});

        await runActivity(activity);

        expect(mockPrisma.directMessage.create).toHaveBeenCalled();
      });

      it("should not store DM when object missing", async () => {
        const activity = {
          type: "Create",
          actor: "https://example.com/users/bob",
          bto: [mockUser.actorUri],
          // Missing object
        };

        await runActivity(activity);

        expect(mockPrisma.directMessage.create).not.toHaveBeenCalled();
      });

      it("should not store DM when object missing id or content", async () => {
        const activity = {
          type: "Create",
          actor: "https://example.com/users/bob",
          bto: [mockUser.actorUri],
          object: {
            type: "Note",
            // Missing id and content
          },
        };

        await runActivity(activity);

        expect(mockPrisma.directMessage.create).not.toHaveBeenCalled();
      });

      it("should not store DM when sender not found", async () => {
        const activity = {
          type: "Create",
          actor: "https://example.com/users/unknown",
          bto: [mockUser.actorUri],
          object: {
            id: "https://example.com/notes/dm-1",
            type: "Note",
            content: "Hello",
          },
        };

        mockPrisma.user.findFirst.mockResolvedValue(null);

        await runActivity(activity);

        expect(mockPrisma.directMessage.create).not.toHaveBeenCalled();
      });

      it("should skip if DM already exists", async () => {
        const activity = {
          type: "Create",
          id: "https://example.com/activities/dm-1",
          actor: "https://example.com/users/bob",
          bto: [mockUser.actorUri],
          object: {
            id: "https://example.com/notes/dm-1",
            type: "Note",
            content: "Hello",
          },
        };

        const sender = {
          id: "user-bob",
          actorUri: "https://example.com/users/bob",
        };

        mockPrisma.user.findFirst.mockResolvedValue(sender);
        mockPrisma.directMessage.findFirst.mockResolvedValue({
          id: "existing-dm",
        });

        await runActivity(activity);

        // Outcome: idempotency check prevents duplicate DM rows.
        expect(mockPrisma.directMessage.create).not.toHaveBeenCalled();
      });

      it("should propagate DM creation errors", async () => {
        const activity = {
          type: "Create",
          id: "https://example.com/activities/dm-1",
          actor: "https://example.com/users/bob",
          bto: [mockUser.actorUri],
          object: {
            id: "https://example.com/notes/dm-1",
            type: "Note",
            content: "Hello",
          },
        };

        const sender = {
          id: "user-bob",
          actorUri: "https://example.com/users/bob",
        };

        mockPrisma.user.findFirst.mockResolvedValue(sender);
        mockPrisma.directMessage.findFirst.mockResolvedValue(null);
        mockPrisma.directMessage.create.mockRejectedValue(
          new Error("Database error"),
        );

        // Outcome: errors bubble up so the queue worker can retry.
        await expect(runActivity(activity)).rejects.toThrow("Database error");
      });
    });

    describe("Follow activity processing", () => {
      it("should process friend request (Follow targeting current user)", async () => {
        const activity = {
          type: "Follow",
          id: "https://example.com/activities/follow-1",
          actor: "https://example.com/users/bob",
          object: mockUser.actorUri, // Targeting current user
        };

        const requester = {
          id: "user-bob",
          actorUri: "https://example.com/users/bob",
        };

        mockPrisma.user.findUnique.mockResolvedValue(requester);

        const { FriendshipService } = await import(
          "../../../src/lib/activitypub/friendship-service.js"
        );
        vi.mocked(FriendshipService.createFriendship).mockResolvedValue(
          {} as unknown as Awaited<
            ReturnType<typeof FriendshipService.createFriendship>
          >,
        );

        await runActivity(activity);

        expect(FriendshipService.createFriendship).toHaveBeenCalledWith(
          mockPrisma,
          "https://example.com/users/bob",
          mockUser.actorUri,
          "PENDING",
        );
      });

      // TRIAGE(AR14): fix — mock fixture predates the tenantId migration; not a
      // dead skip, needs the group/actor mocks updated to carry tenantId.
      it.skip("[T6] should process group Follow activity (mock needs tenantId)", async () => {
        const activity = {
          type: "Follow",
          id: "https://example.com/activities/follow-2",
          actor: "https://example.com/users/bob",
          object: "https://example.com/groups/test-group",
        };

        const targetGroup = {
          id: "group-1",
          actorUri: "https://example.com/groups/test-group",
          privacy: "PUBLIC",
          tenantId: "test-tenant-id",
        };

        mockPrisma.group.findUnique.mockResolvedValue(targetGroup);
        mockPrisma.groupMember.findUnique.mockResolvedValue(null);
        mockPrisma.groupMember.create.mockResolvedValue({});

        await runActivity(activity);

        expect(mockPrisma.groupMember.create).toHaveBeenCalledWith({
          data: {
            groupId: "group-1",
            actorUri: "https://example.com/users/bob",
            role: "MEMBER",
            tenantId: "test-tenant-id",
          },
        });
      });

      it("should skip if user already group member", async () => {
        const activity = {
          type: "Follow",
          actor: "https://example.com/users/bob",
          object: "https://example.com/groups/test-group",
        };

        const targetGroup = {
          id: "group-1",
          actorUri: "https://example.com/groups/test-group",
          privacy: "PUBLIC",
          tenantId: "test-tenant-id",
        };

        mockPrisma.group.findUnique.mockResolvedValue(targetGroup);
        mockPrisma.groupMember.findUnique.mockResolvedValue({
          id: "existing-member",
        });

        await runActivity(activity);

        // Outcome: no new group-member row when user is already a member.
        expect(mockPrisma.groupMember.create).not.toHaveBeenCalled();
      });

      it("REFUSES a Follow of a PRIVATE group — no membership row (DP-5)", async () => {
        const activity = {
          type: "Follow",
          actor: "https://remote.example/users/bob",
          object: "https://example.com/groups/private-group",
        };

        const targetGroup = {
          id: "group-1",
          actorUri: "https://example.com/groups/private-group",
          privacy: "PRIVATE",
          tenantId: "test-tenant-id",
        };

        mockPrisma.group.findUnique.mockResolvedValue(targetGroup);
        mockPrisma.groupMember.findUnique.mockResolvedValue(null);
        mockPrisma.groupMember.create.mockResolvedValue({});

        await runActivity(activity);

        // A private group's membership is an admin decision, never a side
        // effect of a signed Follow. The old behaviour auto-joined as MEMBER.
        expect(mockPrisma.groupMember.create).not.toHaveBeenCalled();
      });

      it("REFUSES a Follow of group A delivered to group B's inbox (DP-5)", async () => {
        const activity = {
          type: "Follow",
          actor: "https://remote.example/users/bob",
          object: "https://example.com/groups/group-a",
        };

        const targetGroup = {
          id: "group-a",
          actorUri: "https://example.com/groups/group-a",
          privacy: "PUBLIC",
          tenantId: "test-tenant-id",
        };

        mockPrisma.group.findUnique.mockResolvedValue(targetGroup);
        mockPrisma.groupMember.findUnique.mockResolvedValue(null);
        mockPrisma.groupMember.create.mockResolvedValue({});

        await ActivityProcessor.processActivity(
          mockPrisma as unknown as PrismaClient,
          activity as unknown as ActivityStreamsActivity,
          {} as unknown as User,
          mockEnv,
          { inboxGroupId: "group-b" },
        );

        expect(mockPrisma.groupMember.create).not.toHaveBeenCalled();
      });

      it("accepts a PUBLIC group Follow when the inbox group matches", async () => {
        const activity = {
          type: "Follow",
          actor: "https://remote.example/users/bob",
          object: "https://example.com/groups/group-a",
        };

        const targetGroup = {
          id: "group-a",
          actorUri: "https://example.com/groups/group-a",
          privacy: "PUBLIC",
          tenantId: "test-tenant-id",
        };

        mockPrisma.group.findUnique.mockResolvedValue(targetGroup);
        mockPrisma.groupMember.findUnique.mockResolvedValue(null);
        mockPrisma.groupMember.create.mockResolvedValue({});

        await ActivityProcessor.processActivity(
          mockPrisma as unknown as PrismaClient,
          activity as unknown as ActivityStreamsActivity,
          {} as unknown as User,
          mockEnv,
          { inboxGroupId: "group-a" },
        );

        expect(mockPrisma.groupMember.create).toHaveBeenCalledTimes(1);
      });

      it("should propagate group member creation errors", async () => {
        const activity = {
          type: "Follow",
          actor: "https://example.com/users/bob",
          object: "https://example.com/groups/test-group",
        };

        const targetGroup = {
          id: "group-1",
          actorUri: "https://example.com/groups/test-group",
          privacy: "PUBLIC",
          tenantId: "test-tenant-id",
        };

        mockPrisma.group.findUnique.mockResolvedValue(targetGroup);
        mockPrisma.groupMember.findUnique.mockResolvedValue(null);
        mockPrisma.groupMember.create.mockRejectedValue(
          new Error("Database error"),
        );

        await expect(runActivity(activity)).rejects.toThrow("Database error");
      });

      it("should not create any membership when Follow target not found", async () => {
        const activity = {
          type: "Follow",
          actor: "https://example.com/users/bob",
          object: "https://example.com/users/unknown",
        };

        mockPrisma.group.findUnique.mockResolvedValue(null);
        mockPrisma.user.findUnique.mockResolvedValue(null);
        mockPrisma.entity.findFirst.mockResolvedValue(null);

        await runActivity(activity);

        // Outcome: target lookups all return null → no DB writes.
        expect(mockPrisma.groupMember.create).not.toHaveBeenCalled();
        expect(mockPrisma.follow.upsert).not.toHaveBeenCalled();
      });

      it("should not attempt Follow when activity missing actor or object", async () => {
        const activity = {
          type: "Follow",
          // Missing actor or object
        };

        await runActivity(activity);

        // Outcome: validation rejection → no lookups attempted.
        expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
        expect(mockPrisma.group.findUnique).not.toHaveBeenCalled();
        expect(mockPrisma.entity.findFirst).not.toHaveBeenCalled();
      });

      it("should not attempt friend request when user has no actorUri", async () => {
        const activity = {
          type: "Follow",
          actor: "https://example.com/users/bob",
          object: null, // Set object to null so it doesn't match user.actorUri
        };

        const userWithoutActorId = {
          ...mockUser,
          actorUri: null,
        } as User;

        mockPrisma.group.findUnique.mockResolvedValue(null);
        mockPrisma.user.findUnique.mockResolvedValue(null);
        mockPrisma.entity.findFirst.mockResolvedValue(null);

        await runActivity(activity, userWithoutActorId);

        const { FriendshipService } = await import(
          "../../../src/lib/activitypub/friendship-service.js"
        );
        expect(FriendshipService.createFriendship).not.toHaveBeenCalled();
      });

      it("should not create friendship when requester not found", async () => {
        const activity = {
          type: "Follow",
          actor: "https://example.com/users/unknown",
          object: mockUser.actorUri,
        };

        mockPrisma.user.findUnique.mockResolvedValue(null);

        await runActivity(activity);

        // Outcome: unknown requester → no friendship created.
        const { FriendshipService } = await import(
          "../../../src/lib/activitypub/friendship-service.js"
        );
        expect(FriendshipService.createFriendship).not.toHaveBeenCalled();
      });
    });

    describe("Accept activity processing", () => {
      it("should process Accept with Follow object", async () => {
        const activity = {
          type: "Accept",
          id: "https://example.com/activities/accept-1",
          actor: mockUser.actorUri,
          object: {
            type: "Follow",
            actor: "https://example.com/users/bob",
            object: mockUser.actorUri,
          },
        };

        const { FriendshipService } = await import(
          "../../../src/lib/activitypub/friendship-service.js"
        );
        vi.mocked(FriendshipService.acceptFriendship).mockResolvedValue(
          {} as unknown as Awaited<
            ReturnType<typeof FriendshipService.acceptFriendship>
          >,
        );

        await runActivity(activity);

        expect(FriendshipService.acceptFriendship).toHaveBeenCalledWith(
          mockPrisma,
          "https://example.com/users/bob",
          mockUser.actorUri,
        );
      });

      it("should not accept when Accept missing actor or object", async () => {
        const activity = {
          type: "Accept",
          // Missing actor or object
        };

        await runActivity(activity);

        const { FriendshipService } = await import(
          "../../../src/lib/activitypub/friendship-service.js"
        );
        expect(FriendshipService.acceptFriendship).not.toHaveBeenCalled();
      });

      it("should not accept when Accept object is not Follow", async () => {
        const activity = {
          type: "Accept",
          actor: mockUser.actorUri,
          object: {
            type: "Like", // Not a Follow
            actor: "https://example.com/users/bob",
            object: mockUser.actorUri,
          },
        };

        await runActivity(activity);

        const { FriendshipService } = await import(
          "../../../src/lib/activitypub/friendship-service.js"
        );
        expect(FriendshipService.acceptFriendship).not.toHaveBeenCalled();
      });

      it("should not accept when Follow object missing actor or object", async () => {
        const activity = {
          type: "Accept",
          actor: mockUser.actorUri,
          object: {
            type: "Follow",
            // Missing actor or object
          },
        };

        await runActivity(activity);

        const { FriendshipService } = await import(
          "../../../src/lib/activitypub/friendship-service.js"
        );
        expect(FriendshipService.acceptFriendship).not.toHaveBeenCalled();
      });

      it("should not accept when target does not match current user", async () => {
        const activity = {
          type: "Accept",
          actor: mockUser.actorUri,
          object: {
            type: "Follow",
            actor: "https://example.com/users/bob",
            object: "https://example.com/users/charlie", // Different user
          },
        };

        await runActivity(activity);

        const { FriendshipService } = await import(
          "../../../src/lib/activitypub/friendship-service.js"
        );
        expect(FriendshipService.acceptFriendship).not.toHaveBeenCalled();
      });

      it("should handle Follow object with actor as object", async () => {
        const activity = {
          type: "Accept",
          actor: mockUser.actorUri,
          object: {
            type: "Follow",
            actor: {
              id: "https://example.com/users/bob",
              type: "Person",
            },
            object: {
              id: mockUser.actorUri,
              type: "Person",
            },
          },
        };

        const { FriendshipService } = await import(
          "../../../src/lib/activitypub/friendship-service.js"
        );
        vi.mocked(FriendshipService.acceptFriendship).mockResolvedValue(
          {} as unknown as Awaited<
            ReturnType<typeof FriendshipService.acceptFriendship>
          >,
        );

        await runActivity(activity);

        expect(FriendshipService.acceptFriendship).toHaveBeenCalled();
      });
    });
  });
});
