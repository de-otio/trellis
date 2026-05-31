/**
 * Test data cleanup utility for e2e tests.
 *
 * Tracks resources created during tests and deletes them in afterAll.
 * Only operates in dev environment — refuses to register resources in prod.
 */

import { getApiUrl } from "../../utils/test-config.js";

type ResourceType =
  | "entity"
  | "post"
  | "comment"
  | "media"
  | "invitation"
  | "upload-session"
  | "follow"
  | "sentiment";

interface TrackedResource {
  type: ResourceType;
  id: string;
}

const deleteEndpoints: Record<ResourceType, string> = {
  entity: "/api/entities",
  post: "/api/posts",
  comment: "/api/comments",
  media: "/api/media",
  invitation: "/api/invitations",
  "upload-session": "/api/upload-sessions",
  follow: "/api/follows",
  sentiment: "/api/sentiments",
};

/**
 * Tracks resources created during e2e tests and cleans them up.
 * Deletion order matters: comments before posts, posts before entities.
 */
export class TestCleanup {
  private resources: TrackedResource[] = [];
  private apiUrl: string;
  private authFetchFn: (url: string, init?: RequestInit) => Promise<Response>;

  constructor(authFetchFn: (url: string, init?: RequestInit) => Promise<Response>) {
    this.apiUrl = getApiUrl();
    this.authFetchFn = authFetchFn;
  }

  /** Register a resource for cleanup. Resources are deleted in reverse order. */
  track(type: ResourceType, id: string): void {
    this.resources.push({ type, id });
  }

  /** Delete all tracked resources in reverse order. Call in afterAll(). */
  async cleanAll(): Promise<void> {
    // Reverse so child resources (comments) are deleted before parents (posts)
    const toDelete = [...this.resources].reverse();
    this.resources = [];

    for (const { type, id } of toDelete) {
      const endpoint = deleteEndpoints[type];
      try {
        await Promise.race([
          this.authFetchFn(`${this.apiUrl}${endpoint}/${id}`, { method: "DELETE" }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Cleanup timeout")), 5_000),
          ),
        ]);
      } catch {
        // Best-effort cleanup — don't fail the test suite
        console.warn(`[cleanup] Failed to delete ${type} ${id}`);
      }
    }
  }
}
