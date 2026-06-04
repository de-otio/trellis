/**
 * Image normalizer — no-op stub for AWS architecture.
 *
 * In the AWS stack, ICC profile normalization (Display P3 → sRGB) and
 * format conversion happen asynchronously in the Lambda media-processing-worker
 * via Sharp, triggered by the S3 upload event → SQS → Lambda pipeline.
 *
 * The original Cloudflare Images synchronous path is no longer used.
 */
export class ImageNormalizer {
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(_images: unknown, _mediaBucket: unknown) {}

  /** Returns null — processing is async via Lambda media-processing-worker. */
  async normalize(_originalKey: string, _contentHash: string): Promise<string | null> {
    return null;
  }
}
