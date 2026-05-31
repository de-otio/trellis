/**
 * Unit Tests: CSV Export
 */

import { describe, expect, it } from "vitest";
import {
  escapeCsvField,
  renderCsvRow,
  renderCsvHeader,
  renderCsv,
  CSV_HEADERS,
} from "../../src/lib/audit/csv-export.js";
import type { CsvRow } from "../../src/lib/audit/csv-export.js";

describe("escapeCsvField", () => {
  it("returns a plain string unchanged when no special chars", () => {
    expect(escapeCsvField("hello")).toBe("hello");
  });

  it("wraps a field containing a comma in double-quotes", () => {
    expect(escapeCsvField("hello,world")).toBe('"hello,world"');
  });

  it("wraps a field containing a double-quote and doubles the inner quote", () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it("wraps a field containing a newline", () => {
    expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
  });

  it("wraps a field containing a carriage return", () => {
    expect(escapeCsvField("line1\rline2")).toBe('"line1\rline2"');
  });

  it("handles an empty string", () => {
    expect(escapeCsvField("")).toBe("");
  });

  it("handles a field that is only quotes", () => {
    // '""' → contains a ", so wrap in outer quotes + double each inner " → '""""""'
    expect(escapeCsvField('""')).toBe('""""""');
  });
});

describe("renderCsvRow", () => {
  it("joins simple fields with commas", () => {
    expect(renderCsvRow(["a", "b", "c"])).toBe("a,b,c");
  });

  it("quotes and escapes fields as needed", () => {
    expect(renderCsvRow(["a,b", 'x"y', "z"])).toBe('"a,b","x""y",z');
  });

  it("handles an empty row", () => {
    expect(renderCsvRow([])).toBe("");
  });
});

describe("renderCsvHeader", () => {
  it("renders a header row with all expected column names", () => {
    const header = renderCsvHeader();
    for (const col of CSV_HEADERS) {
      expect(header).toContain(col);
    }
  });

  it("is a single CSV line (no newlines)", () => {
    const header = renderCsvHeader();
    expect(header).not.toContain("\n");
    expect(header).not.toContain("\r");
  });
});

describe("renderCsv", () => {
  const sampleRow: CsvRow = {
    eventId: "event-1",
    type: "tenant.created",
    tenantId: "tenant-a",
    actorUserId: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    sourceIp: "1.2.3.0/24",
    payload: '{"tenantId":"tenant-a"}',
  };

  it("produces a header row followed by data rows separated by CRLF", () => {
    const csv = renderCsv([sampleRow]);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(renderCsvHeader());
    expect(lines[1]).toContain("event-1");
  });

  it("produces only the header for an empty array", () => {
    const csv = renderCsv([]);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(renderCsvHeader());
  });

  it("escapes commas and quotes in payload field", () => {
    const row: CsvRow = {
      ...sampleRow,
      payload: '{"key":"val,ue","other":"say \\"hi\\""}',
    };
    const csv = renderCsv([row]);
    expect(csv).toContain('"');
  });

  it("renders multiple rows with one row per line", () => {
    const rows: CsvRow[] = [
      { ...sampleRow, eventId: "e1" },
      { ...sampleRow, eventId: "e2" },
      { ...sampleRow, eventId: "e3" },
    ];
    const csv = renderCsv(rows);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(4); // header + 3 rows
    expect(lines[1]).toContain("e1");
    expect(lines[2]).toContain("e2");
    expect(lines[3]).toContain("e3");
  });
});
