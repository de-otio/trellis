import { describe, expect, it } from "vitest";
import {
  ALL_QUEUES,
  QueueSelectionError,
  resolveEnabledQueues,
} from "../../../../worker/src/queue-selection.js";

const none = {};
const both = { "media-processing": true, "media-completion": true } as const;

describe("resolveEnabledQueues", () => {
  it.each([undefined, "", "  ", " , "])("unset/blank (%j) ⇒ all but unwired media queues", (raw) => {
    const sel = resolveEnabledQueues({ raw, depsAvailable: none });
    expect(sel.explicit).toBe(false);
    expect([...sel.queues].sort()).toEqual(
      ALL_QUEUES.filter((q) => !q.startsWith("media-")).sort(),
    );
    expect([...sel.skippedForMissingDeps].sort()).toEqual(["media-completion", "media-processing"]);
  });

  it("unset with deps wired ⇒ every queue", () => {
    const sel = resolveEnabledQueues({ raw: undefined, depsAvailable: both });
    expect([...sel.queues].sort()).toEqual([...ALL_QUEUES].sort());
    expect(sel.skippedForMissingDeps).toEqual([]);
  });

  it("unset with only one media queue wired ⇒ only that one", () => {
    const sel = resolveEnabledQueues({
      raw: undefined,
      depsAvailable: { "media-processing": true },
    });
    expect(sel.queues.has("media-processing")).toBe(true);
    expect(sel.queues.has("media-completion")).toBe(false);
  });

  it("set ⇒ exactly the listed queues (trimmed, de-duplicated)", () => {
    const sel = resolveEnabledQueues({
      raw: " link-check, delete-account ,link-check",
      depsAvailable: none,
    });
    expect(sel.explicit).toBe(true);
    expect([...sel.queues].sort()).toEqual(["delete-account", "link-check"]);
  });

  it("set to a media queue with deps wired ⇒ allowed", () => {
    const sel = resolveEnabledQueues({ raw: "media-completion", depsAvailable: both });
    expect([...sel.queues]).toEqual(["media-completion"]);
  });

  it("set to a media queue without deps ⇒ config error naming it", () => {
    expect(() =>
      resolveEnabledQueues({ raw: "link-check,media-processing", depsAvailable: none }),
    ).toThrow(QueueSelectionError);
    expect(() =>
      resolveEnabledQueues({ raw: "media-processing", depsAvailable: none }),
    ).toThrow(/media-processing/);
  });

  it("unknown name ⇒ config error naming it and listing valid names", () => {
    const run = (): unknown =>
      resolveEnabledQueues({ raw: "link-check,bogus", depsAvailable: both });
    expect(run).toThrow(QueueSelectionError);
    expect(run).toThrow(/bogus/);
    expect(run).toThrow(/Valid names/);
  });

  it("names are case-sensitive", () => {
    expect(() => resolveEnabledQueues({ raw: "Link-Check", depsAvailable: none })).toThrow(
      QueueSelectionError,
    );
  });
});
