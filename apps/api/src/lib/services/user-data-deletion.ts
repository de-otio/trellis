import type { PrismaClient } from "@prisma/client";

export interface DeletionResult {
  commentSentiments: number;
  postSentiments: number;
  comments: number;
  posts: number;
  entities: number;
  follows: number;
  directMessages: number;
  audienceMembers: number;
  audiences: number;
  securityEvents: number;
  crossRegionConsents: number;
  invitations: number;
}

/**
 * Cascade-deletes all data owned by a user from the database.
 *
 * Does NOT delete:
 * - Cognito identity (caller's responsibility)
 * - S3 media files (caller's responsibility)
 * - DynamoDB cache entries (caller's responsibility)
 *
 * Does NOT check authorization — caller must verify permissions.
 *
 * Models with onDelete: Cascade on the User relation (MfaEnrollment, LinkReport,
 * UserEncryptionKey) are automatically deleted by the final user.delete().
 */
export async function deleteUserData(
  db: PrismaClient,
  userId: string,
): Promise<DeletionResult> {
  // Delete related records first to avoid foreign key constraint violations.
  // Order matters: delete child records before parent records.

  // 1. Delete comment sentiments (references comments)
  const commentSentiments = await db.commentSentiment.deleteMany({
    where: { authorId: userId },
  });

  // 2. Delete post sentiments (references posts)
  const postSentiments = await db.postSentiment.deleteMany({
    where: { authorId: userId },
  });

  // 3. Delete comment media (references comments)
  const userComments = await db.postComment.findMany({
    where: { authorId: userId },
    select: { id: true },
  });
  if (userComments.length > 0) {
    const commentIds = userComments.map((c) => c.id);
    await db.postCommentMedia.deleteMany({
      where: { commentId: { in: commentIds } },
    });
  }

  // 4. Delete comments
  const comments = await db.postComment.deleteMany({
    where: { authorId: userId },
  });

  // 5. Delete post-related records (junction tables, media)
  const userPosts = await db.post.findMany({
    where: { authorId: userId },
    select: { id: true },
  });
  if (userPosts.length > 0) {
    const postIds = userPosts.map((p) => p.id);
    await db.postSubject.deleteMany({ where: { postId: { in: postIds } } });
    await db.postTaxonomyTag.deleteMany({ where: { postId: { in: postIds } } });
    await db.postMedia.deleteMany({ where: { postId: { in: postIds } } });
  }

  // 6. Delete posts
  const posts = await db.post.deleteMany({
    where: { authorId: userId },
  });

  // 7. Delete entity-related records
  const userEntities = await db.entity.findMany({
    where: { owners: { some: { userId: userId, status: 'ACTIVE' } } },
    select: { id: true },
  });
  if (userEntities.length > 0) {
    const entityIds = userEntities.map((e) => e.id);
    await db.entityTaxonomyTag.deleteMany({
      where: { entityId: { in: entityIds } },
    });
  }

  // 8. Delete entity ownerships and entities
  await db.entityOwnership.deleteMany({
    where: { userId: userId },
  });
  const entities = await db.entity.deleteMany({
    where: { owners: { none: {} } }, // Delete entities with no remaining owners
  });

  // 9. Follow relationships now handled by graph DB — no-op

  // 10. Delete direct messages (sent and received)
  const directMessages = await db.directMessage.deleteMany({
    where: { OR: [{ senderId: userId }, { recipientId: userId }] },
  });

  // 11. Delete custom audience memberships
  const audienceMembers = await db.customAudienceMember.deleteMany({
    where: { memberId: userId },
  });

  // 12. Delete custom audiences created by user
  const audiences = await db.customAudience.deleteMany({
    where: { creatorId: userId },
  });

  // 13. Delete security events
  const securityEvents = await db.securityEvent.deleteMany({
    where: { userId },
  });

  // 14. Delete cross-region consents
  const crossRegionConsents = await db.crossRegionConsent.deleteMany({
    where: { userId },
  });

  // 15. Delete invitations (both created and used)
  const invitations = await db.invitation.deleteMany({
    where: { OR: [{ createdBy: userId }, { usedBy: userId }] },
  });

  // 16. Delete the user (cascades to MfaEnrollment, LinkReport, UserEncryptionKey)
  await db.user.delete({ where: { id: userId } });

  return {
    commentSentiments: commentSentiments.count,
    postSentiments: postSentiments.count,
    comments: comments.count,
    posts: posts.count,
    entities: entities.count,
    follows: 0, // Follow relationships now handled by graph DB
    directMessages: directMessages.count,
    audienceMembers: audienceMembers.count,
    audiences: audiences.count,
    securityEvents: securityEvents.count,
    crossRegionConsents: crossRegionConsents.count,
    invitations: invitations.count,
  };
}
