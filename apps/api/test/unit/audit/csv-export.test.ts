/**
 * Unit Tests: csv-export (RFC 4180 CSV escaping for audit-event export)
 *
 * Contract:
 *   - `escapeCsvField` wraps a field in double-quotes when it contains a
 *     comma, double-quote, CR, or LF, and doubles any embedded double-quotes
 *     per RFC 4180 §2.7. Fields with no special characters are returned
 *     verbatim (no quoting added).
 *   - `renderCsvRow` maps `escapeCsvField` over an array and joins with commas.
 *   - `renderCsvHeader` returns the seven canonical audit column names as a
 *     single CSV row.
 *   - `renderCsv` emits header + one row per entry, joined with CRLF (\r\n)
 *     as required by RFC 4180 §2.
 *
 * NOTE — formula / CSV-injection: this module implements RFC 4180 quoting
 * only. It does NOT sanitize spreadsheet formula-injection characters
 * (leading =, +, -, @). See the dedicated test below and the call-out in
 * the report.
 */

import { describe, expect, it } from "vitest";
import {
  escapeCsvField,
  renderCsvRow,
  renderCsvHeader,
  renderCsv,
  CSV_HEADERS,
} from "../../../src/lib/audit/csv-export.js";

// ---------------------------------------------------------------------------
// CSV_HEADERS shape
// ---------------------------------------------------------------------------

describe("CSV_HEADERS", () => {
  it("contains exactly 7 columns in documented order", () => {
    expect(CSV_HEADERS).toEqual([
      "eventId",
      "type",
      "tenantId",
      "actorUserId",
      "createdAt",
      "sourceIp",
      "payload",
    ]);
  });
});

// ---------------------------------------------------------------------------
// escapeCsvField
// ---------------------------------------------------------------------------

describe("escapeCsvField", () => {
  it("returns a plain value with no special chars unquoted and unchanged", () => {
    expect(escapeCsvField("hello")).toBe("hello");
    expect(escapeCsvField("abc123")).toBe("abc123");
    expect(escapeCsvField("user@example.com")).toBe("user@example.com");
  });

  it("returns an empty string unchanged (no wrapping quotes)", () => {
    expect(escapeCsvField("")).toBe("");
  });

  it("wraps a value containing a comma in double-quotes", () => {
    expect(escapeCsvField("a,b")).toBe('"a,b"');
    expect(escapeCsvField("one,two,three")).toBe('"one,two,three"');
  });

  it("doubles embedded double-quotes AND wraps the whole field (RFC 4180 §2.7)", () => {
    // a"b → "a""b"
    expect(escapeCsvField('a"b')).toBe('"a""b"');
    // a single standalone quote
    expect(escapeCsvField('"')).toBe('""""');
    // multiple quotes
    expect(escapeCsvField('say "hello" world')).toBe('"say ""hello"" world"');
  });

  it("wraps a value containing a newline (\\n) in double-quotes", () => {
    const result = escapeCsvField("line1\nline2");
    expect(result).toBe('"line1\nline2"');
  });

  it("wraps a value containing a carriage-return (\\r) in double-quotes", () => {
    const result = escapeCsvField("line1\rline2");
    expect(result).toBe('"line1\rline2"');
  });

  it("round-trip: a value with comma + quote + newline becomes one well-formed quoted field", () => {
    // Input: foo,"bar\nbaz
    const input = 'foo,"bar\nbaz';
    const escaped = escapeCsvField(input);
    // Must start and end with a double-quote (it is a single quoted field)
    expect(escaped.startsWith('"')).toBe(true);
    expect(escaped.endsWith('"')).toBe(true);
    // The inner quote must be doubled
    expect(escaped).toContain('""');
    // The comma must be present inside the quotes (not a field separator)
    expect(escaped).toContain(",");
    // Full expected value
    expect(escaped).toBe('"foo,""bar\nbaz"');
  });

  // -------------------------------------------------------------------------
  // Formula / CSV-injection: current behavior documentation
  // -------------------------------------------------------------------------
  //
  // SECURITY NOTICE: escapeCsvField implements RFC 4180 quoting only. It does
  // NOT neutralize spreadsheet formula-injection. A value that starts with =,
  // +, -, or @ is returned verbatim (unquoted). When the resulting CSV is
  // opened in Excel or Google Sheets, the cell may be interpreted as a formula
  // (e.g. "=1+1" evaluates to 2). The mitigation — prepending a tab or
  // single-quote prefix — is NOT applied here. Confirm with the team whether
  // this is acceptable for the audit-export use-case.
  //
  it("does NOT sanitize formula-injection prefix '=' (documents current behavior)", () => {
    // This is a documentation test, not a desired-behavior assertion.
    // The function returns the value unquoted because '=' triggers none of
    // the RFC 4180 quoting conditions (no comma, quote, CR, or LF).
    expect(escapeCsvField("=1+1")).toBe("=1+1");
    expect(escapeCsvField("+cmd")).toBe("+cmd");
    expect(escapeCsvField("-cmd")).toBe("-cmd");
    expect(escapeCsvField("@SUM(A1:A10)")).toBe("@SUM(A1:A10)");
  });
});

// ---------------------------------------------------------------------------
// renderCsvRow
// ---------------------------------------------------------------------------

describe("renderCsvRow", () => {
  it("joins plain fields with commas", () => {
    expect(renderCsvRow(["a", "b", "c"])).toBe("a,b,c");
  });

  it("escapes each field individually before joining", () => {
    // field 0 has a comma → quoted; field 1 is plain; field 2 has a quote → quoted+doubled
    expect(renderCsvRow(["a,b", "plain", 'x"y'])).toBe('"a,b",plain,"x""y"');
  });

  it("handles an empty fields array", () => {
    expect(renderCsvRow([])).toBe("");
  });

  it("handles fields that are all empty strings", () => {
    expect(renderCsvRow(["", "", ""])).toBe(",,");
  });
});

// ---------------------------------------------------------------------------
// renderCsvHeader
// ---------------------------------------------------------------------------

describe("renderCsvHeader", () => {
  it("equals CSV_HEADERS joined with commas (all headers are plain identifiers)", () => {
    const expected = CSV_HEADERS.join(",");
    expect(renderCsvHeader()).toBe(expected);
  });

  it("contains all 7 expected column names", () => {
    const header = renderCsvHeader();
    for (const col of CSV_HEADERS) {
      expect(header).toContain(col);
    }
  });
});

// ---------------------------------------------------------------------------
// renderCsv
// ---------------------------------------------------------------------------

describe("renderCsv", () => {
  const baseRow = {
    eventId: "evt-001",
    type: "USER_LOGIN",
    tenantId: "tenant-abc",
    actorUserId: "user-xyz",
    createdAt: "2025-01-01T00:00:00.000Z",
    sourceIp: "192.0.2.1",
    payload: "{}",
  };

  it("produces header + one data line for a single row, joined with CRLF", () => {
    const csv = renderCsv([baseRow]);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(renderCsvHeader());
  });

  it("produces header + N data lines for N rows", () => {
    const rows = [
      { ...baseRow, eventId: "evt-001" },
      { ...baseRow, eventId: "evt-002" },
      { ...baseRow, eventId: "evt-003" },
    ];
    const lines = renderCsv(rows).split("\r\n");
    expect(lines).toHaveLength(4); // header + 3 rows
  });

  it("returns only the header line for an empty row array", () => {
    const csv = renderCsv([]);
    // No trailing CRLF — just the header
    expect(csv).toBe(renderCsvHeader());
    expect(csv.split("\r\n")).toHaveLength(1);
  });

  it("correctly escapes a payload containing commas so row count is preserved", () => {
    // Input payload has both commas AND double-quotes → RFC 4180 doubles the
    // quotes AND wraps the whole field.
    const row = { ...baseRow, payload: '{"key":"val,ue"}' };
    const lines = renderCsv([row]).split("\r\n");
    // Still exactly 2 lines (header + 1 data row)
    expect(lines).toHaveLength(2);
    // The payload field is quoted with inner quotes doubled
    // {"key":"val,ue"}  →  "{""key"":""val,ue""}"
    expect(lines[1]).toContain('"{""key"":""val,ue""}"');
  });

  it("correctly escapes a payload containing double-quotes so row count is preserved", () => {
    const row = { ...baseRow, payload: 'say "hello"' };
    const lines = renderCsv([row]).split("\r\n");
    expect(lines).toHaveLength(2);
    // Inner quotes are doubled, whole field quoted
    expect(lines[1]).toContain('"say ""hello"""');
  });

  it("correctly escapes a payload containing an embedded newline — row count at top level is preserved", () => {
    // The embedded \n lives inside a quoted field; splitting on \r\n at the
    // top level must still give exactly 2 lines (header + 1 data row).
    const row = { ...baseRow, payload: "line1\nline2" };
    const lines = renderCsv([row]).split("\r\n");
    expect(lines).toHaveLength(2);
    // The data line must contain the payload wrapped in quotes
    expect(lines[1]).toContain('"line1\nline2"');
  });

  it("data row fields appear in the same column order as CSV_HEADERS", () => {
    const csv = renderCsv([baseRow]);
    const lines = csv.split("\r\n");
    const dataLine = lines[1];
    // All plain values → no quoting needed; just verify order by indexOf
    const idxEventId = dataLine.indexOf("evt-001");
    const idxType = dataLine.indexOf("USER_LOGIN");
    const idxTenantId = dataLine.indexOf("tenant-abc");
    const idxActorUserId = dataLine.indexOf("user-xyz");
    expect(idxEventId).toBeLessThan(idxType);
    expect(idxType).toBeLessThan(idxTenantId);
    expect(idxTenantId).toBeLessThan(idxActorUserId);
  });
});
