/**
 * CSV Export for Audit Events (RFC 4180)
 *
 * Fields that contain commas, double-quotes, or newlines are enclosed in
 * double-quotes. Inner double-quotes are doubled per RFC 4180 §2.7.
 */

export const CSV_HEADERS = [
  "eventId",
  "type",
  "tenantId",
  "actorUserId",
  "createdAt",
  "sourceIp",
  "payload",
] as const;

export type CsvRow = {
  eventId: string;
  type: string;
  tenantId: string;
  actorUserId: string;
  createdAt: string;
  sourceIp: string;
  payload: string;
};

/** Escape a single CSV field per RFC 4180. */
export function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Render one CSV row from an array of string values. */
export function renderCsvRow(fields: string[]): string {
  return fields.map(escapeCsvField).join(",");
}

/** Render the header row. */
export function renderCsvHeader(): string {
  return renderCsvRow([...CSV_HEADERS]);
}

/** Render a complete CSV document (header + rows) from an array of row objects. */
export function renderCsv(rows: CsvRow[]): string {
  const lines: string[] = [renderCsvHeader()];
  for (const row of rows) {
    lines.push(
      renderCsvRow([
        row.eventId,
        row.type,
        row.tenantId,
        row.actorUserId,
        row.createdAt,
        row.sourceIp,
        row.payload,
      ]),
    );
  }
  return lines.join("\r\n");
}
