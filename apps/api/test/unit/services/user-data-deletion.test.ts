import { describe, it, expect, beforeEach, vi } from "vitest";
import { deleteUserData } from "../../../src/lib/services/user-data-deletion.js";

describe("deleteUserData", () => {
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = {
      commentSentiment: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
      postSentiment: { deleteMany: vi.fn().mockResolvedValue({ count: 3 }) },
      postComment: {
        findMany: vi.fn().mockResolvedValue([{ id: "comment-1" }, { id: "comment-2" }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      postCommentMedia: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      post: {
        findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      postSubject: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      postTaxonomyTag: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      postMedia: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      entity: {
        findMany: vi.fn().mockResolvedValue([{ id: "entity-1" }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      entityTaxonomyTag: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      entityOwnership: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      directMessage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      customAudienceMember: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      customAudience: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      securityEvent: { deleteMany: vi.fn().mockResolvedValue({ count: 4 }) },
      consent: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      invitation: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      // Surveillance-hardening Phase 0 (P2): target-side InteractionEvent erasure.
      interactionEvent: { deleteMany: vi.fn().mockResolvedValue({ count: 5 }) },
      user: { delete: vi.fn().mockResolvedValue({ id: "user-123" }) },
    };
  });

  it("should delete all user data in correct order and return counts", async () => {
    const result = await deleteUserData(mockDb, "user-123");

    expect(result).toEqual({
      commentSentiments: 2,
      postSentiments: 3,
      comments: 2,
      posts: 1,
      entities: 1,
      follows: 0, // Follow relationships now handled by graph DB
      directMessages: 0,
      audienceMembers: 0,
      audiences: 0,
      securityEvents: 4,
      crossRegionConsents: 1,
      invitations: 0,
      interactionEventsAsTarget: 5,
    });

    // Verify deletion order: sentiments before comments, comments before posts, posts before entities
    const calls = vi.mocked(mockDb.commentSentiment.deleteMany).mock.invocationCallOrder[0];
    const commentDeleteOrder = vi.mocked(mockDb.postComment.deleteMany).mock.invocationCallOrder[0];
    const postDeleteOrder = vi.mocked(mockDb.post.deleteMany).mock.invocationCallOrder[0];
    const entityDeleteOrder = vi.mocked(mockDb.entity.deleteMany).mock.invocationCallOrder[0];
    const userDeleteOrder = vi.mocked(mockDb.user.delete).mock.invocationCallOrder[0];

    expect(calls).toBeLessThan(commentDeleteOrder);
    expect(commentDeleteOrder).toBeLessThan(postDeleteOrder);
    expect(postDeleteOrder).toBeLessThan(entityDeleteOrder);
    expect(entityDeleteOrder).toBeLessThan(userDeleteOrder);
  });

  it("should delete user as the final step", async () => {
    await deleteUserData(mockDb, "user-123");

    expect(mockDb.user.delete).toHaveBeenCalledWith({
      where: { id: "user-123" },
    });
  });

  it("should handle user with no comments or posts gracefully", async () => {
    mockDb.postComment.findMany.mockResolvedValue([]);
    mockDb.post.findMany.mockResolvedValue([]);
    mockDb.entity.findMany.mockResolvedValue([]);

    const result = await deleteUserData(mockDb, "user-empty");

    // Should not attempt to delete comment media or post junction tables
    expect(mockDb.postCommentMedia.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.postSubject.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.postTaxonomyTag.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.postMedia.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.entityTaxonomyTag.deleteMany).not.toHaveBeenCalled();

    // Should still delete the user
    expect(mockDb.user.delete).toHaveBeenCalledWith({
      where: { id: "user-empty" },
    });

    expect(result.comments).toBe(2); // deleteMany still called for comments table
    expect(result.posts).toBe(1);
  });

  // "should delete follows in both directions" test removed:
  // Follow relationships are now handled by the graph DB (AuraDB), not Postgres.

  it("should delete direct messages sent and received", async () => {
    await deleteUserData(mockDb, "user-123");

    expect(mockDb.directMessage.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [{ senderId: "user-123" }, { recipientId: "user-123" }],
      },
    });
  });

  it("should delete invitations created and used", async () => {
    await deleteUserData(mockDb, "user-123");

    expect(mockDb.invitation.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [{ createdBy: "user-123" }, { usedBy: "user-123" }],
      },
    });
  });

  it("erases target-side interaction events (GDPR Art. 17, P2)", async () => {
    await deleteUserData(mockDb, "user-123");

    // Actor-side rows cascade via FK on user.delete(); target-side rows (about
    // the deleted user) have no FK and need this explicit deleteMany.
    expect(mockDb.interactionEvent.deleteMany).toHaveBeenCalledWith({
      where: { targetType: "user", targetId: "user-123" },
    });
  });

  it("should propagate database errors", async () => {
    mockDb.commentSentiment.deleteMany.mockRejectedValue(new Error("DB connection lost"));

    await expect(deleteUserData(mockDb, "user-123")).rejects.toThrow("DB connection lost");
  });
});
