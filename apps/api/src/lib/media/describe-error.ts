/**
 * Render an unknown thrown value into a string a log line can actually act on.
 *
 * ## Why this exists
 *
 * The media upload path logged failures as `error: someError?.message`. That
 * reads as sufficient and is not: **an AWS SDK connection error carries an
 * empty `message`**. When a blocked egress route made every staging write time
 * out, the resulting log line was:
 *
 * ```json
 * {"level":50,"msg":"[Media Upload] Staging write failed","error":""}
 * ```
 *
 * — a report that something failed, carrying no information about what. The
 * cause (requests addressed to a host outside the egress allowlist) was
 * invisible in the logs and had to be found by reproducing the call by hand.
 *
 * `name` is what distinguishes "never reached the endpoint" (`TimeoutError`)
 * from "the endpoint refused" (`AccessDenied`), and it is populated even when
 * `message` is not. `code` and the SDK's `$metadata.httpStatusCode` separate
 * those further. Together they turn a dead log line into a diagnosis.
 *
 * ## What it must not do
 *
 * Return anything the caller would be unwise to log. It reads only the four
 * fields named above — never the whole error, whose `$response`/`request`
 * shape on some SDK errors can carry request headers, and therefore
 * credentials.
 */
export function describeError(error: unknown): string {
  if (error === null || error === undefined) {
    return "<no error value>";
  }
  if (typeof error !== "object") {
    return String(error);
  }

  const e = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };

  const parts: string[] = [];
  if (typeof e.name === "string" && e.name.length > 0) parts.push(e.name);
  if (typeof e.message === "string" && e.message.length > 0) parts.push(e.message);
  if (typeof e.code === "string" && e.code.length > 0) parts.push(`code=${e.code}`);

  const httpStatus = e.$metadata?.httpStatusCode;
  if (typeof httpStatus === "number") parts.push(`http=${httpStatus}`);

  // Never return "" — an empty description is the exact failure this function
  // exists to prevent, so say something even about a shapeless throw.
  return parts.length > 0
    ? parts.join(" ")
    : `<no diagnosable fields on ${Object.prototype.toString.call(error)}>`;
}
