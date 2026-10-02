import { describe, expect, it } from "vitest";
import { convertKustoTables, partialErrorText } from "../src/lib/kusto.js";

// source: Log Analytics query response shape (identifiers replaced)
const COLUMNS = [
  { name: "TimeGenerated", type: "datetime" },
  { name: "ResultType", type: "string" },
  { name: "Count", type: "long" },
];

describe("convertKustoTables", () => {
  it("converts the primary table columns and rows to objects", () => {
    const converted = convertKustoTables([
      {
        name: "PrimaryResult",
        columns: COLUMNS,
        rows: [
          ["2026-09-30T00:00:00Z", "Success", 12],
          ["2026-09-30T01:00:00Z", "Failure", 3],
        ],
      },
    ]);
    expect(converted.total).toBe(2);
    expect(converted.rows).toEqual([
      { TimeGenerated: "2026-09-30T00:00:00Z", ResultType: "Success", Count: 12 },
      { TimeGenerated: "2026-09-30T01:00:00Z", ResultType: "Failure", Count: 3 },
    ]);
    expect(converted.otherTables).toBeUndefined();
  });

  it("returns an empty result when tables are missing", () => {
    expect(convertKustoTables(undefined)).toEqual({ rows: [], total: 0 });
    expect(convertKustoTables([])).toEqual({ rows: [], total: 0 });
  });

  it("fills missing cells and ignores missing column names", () => {
    const converted = convertKustoTables([
      { name: "PrimaryResult", columns: [{ name: "a", type: "string" }, { type: "string" }], rows: [["x"]] },
    ]);
    expect(converted.rows).toEqual([{ a: "x" }]);
  });

  it("keeps false and zero, and does not throw on a non-array tables payload", () => {
    const converted = convertKustoTables([
      {
        name: "PrimaryResult",
        columns: [
          { name: "ok", type: "bool" },
          { name: "n", type: "long" },
        ],
        rows: [[false, 0], [null, null]],
      },
    ]);
    expect(converted.rows).toEqual([
      { ok: false, n: 0 },
      { ok: "", n: "" },
    ]);
    expect(convertKustoTables({ name: "not-an-array" } as unknown as [])).toEqual({ rows: [], total: 0 });
  });

  it("reports extra tables as name plus row count only", () => {
    const converted = convertKustoTables([
      { name: "PrimaryResult", columns: COLUMNS, rows: [["2026-09-30T00:00:00Z", "Success", 1]] },
      { name: "QueryCompletionInformation", columns: [{ name: "code", type: "string" }], rows: [["Done"], ["More"]] },
    ]);
    expect(converted.total).toBe(1);
    expect(converted.rows).toHaveLength(1);
    expect(converted.otherTables).toEqual([{ name: "QueryCompletionInformation", count: 2 }]);
  });
});

describe("partialErrorText", () => {
  it("returns undefined without an error object", () => {
    expect(partialErrorText(undefined)).toBeUndefined();
  });

  it("mentions code and message when both exist", () => {
    expect(partialErrorText({ code: "PartialError", message: "One shard timed out" })).toContain("One shard timed out");
  });

  it("includes details and the deepest inner error, which is where the cause usually is", () => {
    const text = partialErrorText({
      code: "PartialError",
      message: "See details",
      details: [{ code: "ServerTimeout", message: "One shard timed out" }],
      innererror: { code: "QueryError", message: "table SigninLogs is missing" },
    });
    expect(text).toContain("See details");
    expect(text).toContain("ServerTimeout: One shard timed out");
    expect(text).toContain("table SigninLogs is missing");
  });
});
