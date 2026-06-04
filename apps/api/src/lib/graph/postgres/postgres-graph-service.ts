/**
 * PostgresGraphService — the graph serving path backed by Postgres
 * (joins + recursive CTEs on the existing RDS). No separate graph DB,
 * no dual-write. See the graph-backend contract in
 * plans/redesign/graph-backend-contract.md.
 *
 * The implementation is split into per-method-group modules (relationships,
 * circles, entity-relationships, discovery, scoring, sync) so Phase 1 can be
 * filled in concurrently without merge conflicts. This service file is the
 * stable composition + connection/health layer written in Phase 0; it should
 * not need editing as the groups land.
 */
import type { PrismaClient } from "@prisma/client";
import type { GraphConnection, GraphService } from "../graph-service.js";
import type { EntityGeoLookup } from "../../geo/entity-geo-repository.js";
import type {
  CircleTier,
  CreateEntityRelationshipInput,
  CreateRelationshipInput,
  DiscoveryFilters,
  EntityRelationshipStatus,
  GraphConnectionConfig,
  GraphHealthStatus,
  GraphNodeType,
  NearbyFilters,
  PaginationInput,
  RecordInteractionInput,
  SyncEntityInput,
  SyncOwnershipInput,
  SyncPostInput,
  SyncPostSubjectsInput,
  SyncUserInput,
  UpdateRelationshipScoreInput,
} from "../types.js";
import { CircleOps } from "./circles.js";
import { DiscoveryOps } from "./discovery.js";
import { EntityRelationshipOps } from "./entity-relationships.js";
import { RelationshipOps } from "./relationships.js";
import { ScoringOps } from "./scoring.js";
import { SyncOps } from "./sync.js";

export class PostgresGraphService implements GraphService, GraphConnection {
  private connected = false;
  private readonly relationships: RelationshipOps;
  private readonly circles: CircleOps;
  private readonly entityRelationships: EntityRelationshipOps;
  private readonly discovery: DiscoveryOps;
  private readonly scoring: ScoringOps;
  private readonly sync: SyncOps;

  constructor(
    private readonly prisma: PrismaClient,
    geoLookup?: EntityGeoLookup,
  ) {
    this.relationships = new RelationshipOps(prisma);
    this.circles = new CircleOps(prisma);
    this.entityRelationships = new EntityRelationshipOps(prisma);
    this.discovery = new DiscoveryOps(prisma, geoLookup);
    this.scoring = new ScoringOps(prisma);
    this.sync = new SyncOps(prisma, geoLookup);
  }

  // ---- Connection & health -------------------------------------------------

  async connect(_config: GraphConnectionConfig): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
    this.connected = true;
  }

  async close(): Promise<void> {
    // The Prisma client lifecycle is owned by the factory/caller (it may be
    // shared with other repositories); closing the graph service just marks
    // it disconnected rather than disconnecting a possibly-shared client.
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async healthCheck(): Promise<GraphHealthStatus> {
    const start = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { healthy: true, latencyMs: Date.now() - start, backend: "postgres" };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        backend: "postgres",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ---- Relationships (B1) --------------------------------------------------

  createRelationship(input: CreateRelationshipInput) {
    return this.relationships.createRelationship(input);
  }
  removeRelationship(userId: string, targetType: GraphNodeType, targetId: string) {
    return this.relationships.removeRelationship(userId, targetType, targetId);
  }
  updateRelationshipScore(input: UpdateRelationshipScoreInput) {
    return this.relationships.updateRelationshipScore(input);
  }
  getRelationship(userId: string, targetType: GraphNodeType, targetId: string) {
    return this.relationships.getRelationship(userId, targetType, targetId);
  }
  getRelationships(
    userId: string,
    options?: {
      tier?: CircleTier;
      targetType?: GraphNodeType;
      pagination?: PaginationInput;
    },
  ) {
    return this.relationships.getRelationships(userId, options);
  }
  getRelationshipGraph(userId: string) {
    return this.relationships.getRelationshipGraph(userId);
  }

  // ---- Circles (B2) --------------------------------------------------------

  getCircleMembers(userId: string, tier: CircleTier) {
    return this.circles.getCircleMembers(userId, tier);
  }
  getVisiblePostIds(
    userId: string,
    tier: CircleTier,
    since: Date,
    pagination: PaginationInput,
  ) {
    return this.circles.getVisiblePostIds(userId, tier, since, pagination);
  }
  getGlanceItems(userId: string, tier: CircleTier, limit: number) {
    return this.circles.getGlanceItems(userId, tier, limit);
  }
  getDepthPostIds(
    userId: string,
    targetType: GraphNodeType,
    targetId: string,
    since: Date,
    limit: number,
  ) {
    return this.circles.getDepthPostIds(userId, targetType, targetId, since, limit);
  }
  getCircleStatus(userId: string) {
    return this.circles.getCircleStatus(userId);
  }
  getCircleEntityStatus(userId: string, tier: CircleTier) {
    return this.circles.getCircleEntityStatus(userId, tier);
  }
  markCircleRead(userId: string, tier: CircleTier, readAt?: Date) {
    return this.circles.markCircleRead(userId, tier, readAt);
  }

  // ---- Entity relationships (B3) ------------------------------------------

  createEntityRelationship(input: CreateEntityRelationshipInput) {
    return this.entityRelationships.createEntityRelationship(input);
  }
  confirmEntityRelationship(
    entityId: string,
    relatedEntityId: string,
    confirmingUserId: string,
  ) {
    return this.entityRelationships.confirmEntityRelationship(
      entityId,
      relatedEntityId,
      confirmingUserId,
    );
  }
  rejectEntityRelationship(
    entityId: string,
    relatedEntityId: string,
    rejectingUserId: string,
  ) {
    return this.entityRelationships.rejectEntityRelationship(
      entityId,
      relatedEntityId,
      rejectingUserId,
    );
  }
  removeEntityRelationship(
    entityId: string,
    relatedEntityId: string,
    removingUserId: string,
  ) {
    return this.entityRelationships.removeEntityRelationship(
      entityId,
      relatedEntityId,
      removingUserId,
    );
  }
  getEntityRelationships(
    entityId: string,
    options?: { type?: string; status?: EntityRelationshipStatus },
  ) {
    return this.entityRelationships.getEntityRelationships(entityId, options);
  }
  getPendingEntityRelationships(userId: string) {
    return this.entityRelationships.getPendingEntityRelationships(userId);
  }

  // ---- Discovery (B4) ------------------------------------------------------

  discoverByGraph(userId: string, hops: number, filters?: DiscoveryFilters) {
    return this.discovery.discoverByGraph(userId, hops, filters);
  }
  discoverNearby(
    userId: string,
    lat: number,
    lng: number,
    radiusMeters: number,
    filters?: NearbyFilters,
  ) {
    return this.discovery.discoverNearby(userId, lat, lng, radiusMeters, filters);
  }
  getRecommendations(userId: string, limit: number) {
    return this.discovery.getRecommendations(userId, limit);
  }

  // ---- Scoring (B5) --------------------------------------------------------

  recordInteraction(input: RecordInteractionInput) {
    return this.scoring.recordInteraction(input);
  }
  recomputeScores(userId: string) {
    return this.scoring.recomputeScores(userId);
  }
  applyDecay(userId: string) {
    return this.scoring.applyDecay(userId);
  }

  // ---- Sync (B6) -----------------------------------------------------------

  syncUser(input: SyncUserInput) {
    return this.sync.syncUser(input);
  }
  removeUser(userId: string) {
    return this.sync.removeUser(userId);
  }
  syncEntity(input: SyncEntityInput) {
    return this.sync.syncEntity(input);
  }
  removeEntity(entityId: string) {
    return this.sync.removeEntity(entityId);
  }
  syncPost(input: SyncPostInput) {
    return this.sync.syncPost(input);
  }
  removePost(postId: string) {
    return this.sync.removePost(postId);
  }
  syncPostSubjects(input: SyncPostSubjectsInput) {
    return this.sync.syncPostSubjects(input);
  }
  syncOwnership(input: SyncOwnershipInput) {
    return this.sync.syncOwnership(input);
  }
  removeOwnership(entityId: string, userId: string) {
    return this.sync.removeOwnership(entityId, userId);
  }
}
