/**
 * Compile-time contract for the media worker cores exported from the package
 * entry. Nothing here runs: `tsc -p tsconfig.types.json` (part of `npm run
 * lint`) fails if a name stops resolving or a core is bound to the wrong
 * dependency/outcome type.
 */

import type {
  CompletionCascade,
  CompletionDeps,
  CompletionStore,
  CompletionQueueTiming,
  EscalationResultPort,
  MediaCompletionRecordOutcome,
  MediaFileRow,
  MediaPersistencePort,
  MediaProcessingConfig,
  MediaProcessingDeps,
  MediaProcessingRecordOutcome,
  MediaRecoverySweepConfig,
  MediaSpendGuardPort,
  MediaWorkerLogger,
  MetricsPort,
  ProcessingClock,
  ProcessingOutcome,
  QueueRecordLike,
  RecoveryAction,
  RecoveryCandidate,
  RecoveryTrackState,
  StoragePort,
  TranscodePort,
  TranscribePort,
} from "../../src/index.js";
import { handleMediaCompletion, processMediaMessage } from "../../src/index.js";

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

export type MediaCoreTypeChecks = [
  Assert<Equal<Parameters<typeof processMediaMessage>, [QueueRecordLike, MediaProcessingDeps]>>,
  Assert<Equal<Awaited<ReturnType<typeof processMediaMessage>>, MediaProcessingRecordOutcome>>,
  Assert<Equal<Parameters<typeof handleMediaCompletion>[1], CompletionDeps>>,
  Assert<Equal<Awaited<ReturnType<typeof handleMediaCompletion>>, MediaCompletionRecordOutcome>>,
  Assert<Equal<CompletionDeps["store"], CompletionStore>>,
  Assert<Equal<MediaProcessingDeps["storage"], StoragePort>>,
  Assert<Equal<MediaProcessingDeps["transcode"], TranscodePort>>,
  Assert<Equal<MediaProcessingDeps["transcribe"], TranscribePort>>,
  Assert<Equal<MediaProcessingDeps["persistence"], MediaPersistencePort>>,
  Assert<Equal<MediaProcessingDeps["config"], MediaProcessingConfig>>,
  Assert<Equal<MediaProcessingDeps["logger"], MediaWorkerLogger>>,
];

// Named so they are not elided: every remaining exported name must resolve.
export type MediaCoreNamesResolve = [
  CompletionCascade,
  EscalationResultPort,
  MediaFileRow,
  MediaSpendGuardPort,
  MetricsPort,
  ProcessingOutcome,
  ProcessingClock,
  MediaRecoverySweepConfig,
  RecoveryAction,
  RecoveryCandidate,
  RecoveryTrackState,
  CompletionQueueTiming,
];
