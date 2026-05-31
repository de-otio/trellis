/**
 * Friendship Service — STUBBED pending redesign
 *
 * The Friendship model has been removed. Mutual relationships are now
 * handled by scored Relationships in the graph database (AuraDB).
 * ActivityPub federation is deferred until the circles model is validated.
 */

import type { PrismaClient } from "@prisma/client";

export class FriendshipService {
  static async createFriendship(
    _db: PrismaClient,
    _actorUri: string,
    _friendUri: string,
    _status: string,
  ): Promise<void> {
    // no-op — follow/friendship relationships are in the graph DB
  }

  static async acceptFriendship(
    _db: PrismaClient,
    _actorUri: string,
    _friendUri: string,
  ): Promise<void> {
    // no-op — follow/friendship relationships are in the graph DB
  }

  static async getFriendsActorUris(
    _db: PrismaClient,
    _actorUri: string,
    _page?: number,
    _limit?: number,
  ): Promise<string[]> {
    return [];
  }

  static async getFriendsCount(
    _db: PrismaClient,
    _actorUri: string,
  ): Promise<number> {
    return 0;
  }
}
