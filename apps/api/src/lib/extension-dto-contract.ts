/**
 * Compile-time contract: core satisfies the published extension DTOs.
 *
 * `@de-otio/trellis-extension-api` publishes minimal STRUCTURAL shapes
 * (`ExtensionPost`, `ExtensionEntity`, relationship/circle result shapes)
 * that extensions type against. This file asserts — at build time, with no
 * runtime footprint — that core's internal types (Prisma models, graph
 * result types) are assignable to those DTOs.
 *
 * Why: the extension boundary used to be `any`/`unknown`, so renaming a core
 * field broke extensions (e.g. `@skybber/ext-dogs`) at RUNTIME with zero
 * compile signal (AR13). With this file, a core field rename fails
 * `tsc --build` here, BEFORE anything is published; updating the DTO to
 * match then fails the extension's build at bump time instead of in prod.
 *
 * If an assertion below errors:
 *  - You renamed/removed/retyped a core field that is part of the published
 *    extension contract. Either restore it, or bump the DTO in
 *    `packages/extension-api` (semver! that package is public) and
 *    coordinate with extension authors.
 *
 * NOTE: Prisma types stay OUT of the public package — they are imported
 * here (core-internal) only to check assignability against the hand-written
 * structural DTOs.
 */

import type { Entity, Post } from "@prisma/client";
import type {
  ExtensionCircleEntityStatus,
  ExtensionCircleMember,
  ExtensionCircleTierStatus,
  ExtensionEntity,
  ExtensionEntityRelationship,
  ExtensionGlanceItem,
  ExtensionPaginatedResult,
  ExtensionPost,
  ExtensionRelationship,
  ExtensionVisiblePost,
} from "@de-otio/trellis-extension-api";
import type {
  CircleEntityStatus,
  CircleMember,
  CircleTierStatus,
  EntityRelationship,
  GlanceItem,
  PaginatedResult,
  Relationship,
  VisiblePostResult,
} from "./graph/types.js";

/**
 * Asserts (at compile time) that `T` is assignable to `Contract`.
 * Usage: `type _Check = Satisfies<PublishedDto, CoreType>;`
 */
type Satisfies<Contract, T extends Contract> = T;

// --- Prisma models satisfy the published entity/post DTOs ------------------
type _EntitySatisfiesDto = Satisfies<ExtensionEntity, Entity>;
type _PostSatisfiesDto = Satisfies<ExtensionPost, Post>;

// --- Graph result types satisfy the relationship/circle DTOs ---------------
type _RelationshipSatisfiesDto = Satisfies<ExtensionRelationship, Relationship>;
type _PaginatedRelationshipsSatisfyDto = Satisfies<
  ExtensionPaginatedResult<ExtensionRelationship>,
  PaginatedResult<Relationship>
>;
type _CircleMemberSatisfiesDto = Satisfies<ExtensionCircleMember, CircleMember>;
type _CircleTierStatusSatisfiesDto = Satisfies<
  ExtensionCircleTierStatus,
  CircleTierStatus
>;
type _CircleEntityStatusSatisfiesDto = Satisfies<
  ExtensionCircleEntityStatus,
  CircleEntityStatus
>;
type _GlanceItemSatisfiesDto = Satisfies<ExtensionGlanceItem, GlanceItem>;
type _VisiblePostSatisfiesDto = Satisfies<
  ExtensionVisiblePost,
  VisiblePostResult
>;
type _PaginatedVisiblePostsSatisfyDto = Satisfies<
  ExtensionPaginatedResult<ExtensionVisiblePost>,
  PaginatedResult<VisiblePostResult>
>;
type _EntityRelationshipSatisfiesDto = Satisfies<
  ExtensionEntityRelationship,
  EntityRelationship
>;

// The graph-service returns are ALSO checked structurally where
// `createReadOnlyGraphService` (extension-context.ts) binds core methods to
// the tightened `ExtensionGraphService` interface — this file makes the same
// contract explicit and additionally covers the entity/post shapes, which
// reach extensions through routes and `extendRecap`.

export {};
