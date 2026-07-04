/**
 * fake-media-db.ts — an in-memory MediaFile table that EVALUATES Prisma-style
 * where clauses, for the stale-media reaper tests (AR4).
 *
 * The pre-AR4 reaper tests only asserted the SHAPE of the query the reaper
 * issued — a tautology that could not catch the actual bug (the reaper deleting
 * rows still inside the moderation pipeline). This fake makes the tests
 * behavioral: seed rows, run the real reaper code, and assert which rows
 * SURVIVE. It implements exactly the operator subset the reapers use:
 *
 *   - `id: { in: [...] }`
 *   - `uploadStatus: { in: [...] }`
 *   - `createdAt: { lt: Date }`
 *   - `moderationJobs: { none: <job condition> }` (Prisma relation-filter
 *     semantics: the row matches iff NO related job matches the condition;
 *     an empty condition `{}` matches every job, so `none: {}` means
 *     "has zero moderation jobs")
 *   - scalar equality / `null` for the orphan-cleanup step
 *     (`attachedToPost`, `orphanedAt: { lte }`, `deletedAt: null`)
 */

export interface FakeModerationJob {
  /** null ⇒ the job is still OPEN (moderation in flight). */
  readonly decision: string | null;
}

export interface FakeMediaRow {
  id: string;
  uploadStatus: string;
  createdAt: Date;
  contentHash: string | null;
  originalKey: string | null;
  moderationJobs: FakeModerationJob[];
  attachedToPost: boolean;
  orphanedAt: Date | null;
  deletedAt: Date | null;
}

/** Seed helper — fills the columns a scenario does not care about. */
export function mediaRow(
  seed: Partial<FakeMediaRow> & { id: string },
): FakeMediaRow {
  return {
    uploadStatus: "PENDING",
    createdAt: new Date(),
    contentHash: null,
    originalKey: null,
    moderationJobs: [],
    attachedToPost: false,
    orphanedAt: null,
    deletedAt: null,
    ...seed,
  };
}

type Where = Record<string, unknown>;

function matchesJobCondition(
  job: FakeModerationJob,
  condition: Record<string, unknown>,
): boolean {
  return Object.entries(condition).every(
    ([key, value]) => (job as unknown as Record<string, unknown>)[key] === value,
  );
}

/** Evaluate the reaper's where-clause subset against a row. */
export function matchesMediaWhere(row: FakeMediaRow, where: Where): boolean {
  for (const [field, cond] of Object.entries(where)) {
    switch (field) {
      case "id": {
        const c = cond as { in?: string[] };
        if (c.in !== undefined && !c.in.includes(row.id)) return false;
        break;
      }
      case "uploadStatus": {
        const c = cond as { in?: string[] };
        if (c.in !== undefined && !c.in.includes(row.uploadStatus)) return false;
        break;
      }
      case "createdAt": {
        const c = cond as { lt?: Date };
        if (c.lt !== undefined && !(row.createdAt < c.lt)) return false;
        break;
      }
      case "moderationJobs": {
        const c = cond as { none?: Record<string, unknown> };
        if (c.none !== undefined) {
          // Prisma `none`: the row matches iff NO related record matches the
          // condition. An empty condition matches every record.
          if (row.moderationJobs.some((j) => matchesJobCondition(j, c.none!))) {
            return false;
          }
        }
        break;
      }
      case "attachedToPost": {
        if (row.attachedToPost !== cond) return false;
        break;
      }
      case "orphanedAt": {
        const c = cond as { lte?: Date };
        if (c.lte !== undefined) {
          if (row.orphanedAt === null || !(row.orphanedAt <= c.lte)) return false;
        }
        break;
      }
      case "deletedAt": {
        if (cond === null && row.deletedAt !== null) return false;
        break;
      }
      default:
        throw new Error(
          `fake-media-db: unsupported where field \`${field}\` — extend the fake`,
        );
    }
  }
  return true;
}

/**
 * A minimal Prisma-shaped `mediaFile` model over a mutable row array. The
 * array is shared with the caller so a test can assert surviving rows after
 * the reaper ran.
 */
export function makeFakeMediaDb(rows: FakeMediaRow[]) {
  return {
    mediaFile: {
      findMany: async (args: {
        where: Where;
        take?: number;
        select?: Record<string, boolean>;
      }) => {
        let out = rows.filter((r) => matchesMediaWhere(r, args.where));
        if (args.take !== undefined) out = out.slice(0, args.take);
        if (args.select === undefined) return out.map((r) => ({ ...r }));
        return out.map((r) => {
          const projected: Record<string, unknown> = {};
          for (const [col, want] of Object.entries(args.select!)) {
            if (want) projected[col] = r[col as keyof FakeMediaRow];
          }
          return projected;
        });
      },
      deleteMany: async (args: { where: Where }) => {
        const doomed = rows.filter((r) => matchesMediaWhere(r, args.where));
        for (const r of doomed) rows.splice(rows.indexOf(r), 1);
        return { count: doomed.length };
      },
      updateMany: async (args: { where: Where; data: Partial<FakeMediaRow> }) => {
        const hit = rows.filter((r) => matchesMediaWhere(r, args.where));
        for (const r of hit) Object.assign(r, args.data);
        return { count: hit.length };
      },
    },
  };
}
