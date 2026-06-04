/**
 * Mock AT Protocol / Bluesky Agent
 *
 * Provides mocks for @atproto/api BskyAgent for testing.
 */

import type { BskyAgent } from "@atproto/api";
import { vi } from "vitest";

/**
 * Mock BskyAgent with commonly used methods
 */
export function createMockBskyAgent(): Partial<BskyAgent> {
  const mockAgent = {
    com: {
      atproto: {
        server: {
          createSession: vi.fn(),
          refreshSession: vi.fn(),
        },
        repo: {
          putRecord: vi.fn(),
          getRecord: vi.fn(),
          listRecords: vi.fn(),
          uploadBlob: vi.fn(),
        },
      },
    },
    api: {
      setHeader: vi.fn(),
    },
    // OAuth-related methods (for future OAuth implementation)
    resolveHandle: vi.fn(),
  };

  // Default implementations
  (
    mockAgent.com.atproto.server.createSession as ReturnType<typeof vi.fn>
  ).mockResolvedValue({
    data: {
      accessJwt: "mock-access-token",
      refreshJwt: "mock-refresh-token",
      did: "did:plc:test123",
      handle: "test-user.bsky.social",
    },
  });

  (
    mockAgent.com.atproto.repo.putRecord as ReturnType<typeof vi.fn>
  ).mockResolvedValue({
    data: {
      uri: "at://did:plc:test123/com.trellis.dog.profile/abc123",
      cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
      record: {
        $type: "com.trellis.dog.profile",
        name: "Test Dog",
      },
    },
  });

  (
    mockAgent.com.atproto.repo.getRecord as ReturnType<typeof vi.fn>
  ).mockResolvedValue({
    data: {
      uri: "at://did:plc:test123/com.trellis.dog.profile/abc123",
      value: {
        $type: "com.trellis.dog.profile",
        name: "Test Dog",
        breed: "Golden Retriever",
      },
    },
  });

  (
    mockAgent.com.atproto.repo.listRecords as ReturnType<typeof vi.fn>
  ).mockResolvedValue({
    data: {
      records: [],
      cursor: null,
    },
  });

  (
    mockAgent.com.atproto.repo.uploadBlob as ReturnType<typeof vi.fn>
  ).mockResolvedValue({
    data: {
      blob: {
        ref: {
          $link: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
        },
        mimeType: "image/jpeg",
        size: 1024,
      },
    },
  });

  (mockAgent.resolveHandle as ReturnType<typeof vi.fn>).mockResolvedValue({
    data: {
      did: "did:plc:test123",
    },
  });

  return mockAgent as unknown as Partial<BskyAgent>;
}

/**
 * Helper to reset all mocks
 */
export function resetMockBskyAgent(
  mockAgent: ReturnType<typeof createMockBskyAgent>,
): void {
  Object.values(mockAgent.com?.atproto?.server || {}).forEach((fn: any) => {
    if (vi.isMockFunction(fn)) {
      fn.mockClear();
    }
  });
  Object.values(mockAgent.com?.atproto?.repo || {}).forEach((fn: any) => {
    if (vi.isMockFunction(fn)) {
      fn.mockClear();
    }
  });
}
