export type MetadataErrorCode =
  | "timeout"
  | "unsupported_mime"
  | "extraction_failed"
  | "validation_failed"
  | "size_exceeded";

export class MetadataExtractionError extends Error {
  public readonly code: MetadataErrorCode;
  public readonly cause?: unknown;

  constructor(
    message: string,
    opts: { code: MetadataErrorCode; cause?: unknown },
  ) {
    super(message);
    this.name = "MetadataExtractionError";
    this.code = opts.code;
    this.cause = opts.cause;
  }
}

export class MetadataValidationError extends Error {
  public readonly code: MetadataErrorCode;
  public readonly issues?: unknown;

  constructor(
    message: string,
    opts: { code?: MetadataErrorCode; issues?: unknown },
  ) {
    super(message);
    this.name = "MetadataValidationError";
    this.code = opts.code ?? "validation_failed";
    this.issues = opts.issues;
  }
}
