import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ sendRequest: vi.fn(), requestAll: vi.fn() }));
vi.mock("../src/lib/stdin.js", () => ({ readStdinIfPiped: vi.fn() }));

import { run } from "../src/commands/logs.js";
import { sendRequest } from "../src/lib/client.js";
import { readStdinIfPiped } from "../src/lib/stdin.js";

const sendMock = vi.mocked(sendRequest);
const stdinMock = vi.mocked(readStdinIfPiped);

const WS = "00000000-0000-0000-0000-000000000010";
const ARM_ID =
  "/subscriptions/00000000-0000-0000-0000-000000000020/resourceGroups/rg-demo/providers/Microsoft.OperationalInsights/workspaces/log-demo";

let dir: string;
const ENV_KEYS = ["AZ_AXI_CONFIG", "AZ_AXI_PROFILE", "AZ_AXI_SUBSCRIPTION", "AZ_AXI_TENANT"];
let saved: Record<string, string | undefined>;

// source: Log Analytics query response shape (identifiers replaced)
function kustoBody(rowCount: number, overrides: Record<string, unknown> = {}) {
  const rows = Array.from({ length: rowCount }, (_, i) => [`2026-09-30T0${i % 10}:00:00Z`, "Success", i + 1]);
  return {
    tables: [
      {
        name: "PrimaryResult",
        columns: [
          { name: "TimeGenerated", type: "datetime" },
          { name: "ResultType", type: "string" },
          { name: "Count", type: "long" },
        ],
        rows,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-logs-"));
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AZ_AXI_CONFIG = join(dir, "config.json");
  sendMock.mockReset();
  stdinMock.mockReset();
  stdinMock.mockResolvedValue(undefined);
  sendMock.mockResolvedValue({ status: 200, headers: {}, body: kustoBody(2), clientRequestId: "req-1" });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

function lastRequest() {
  const calls = sendMock.mock.calls;
  return calls[calls.length - 1]?.[1] as { path: string; resource: string; body: Record<string, unknown> };
}

describe("logs query", () => {
  it("posts KQL unchanged to the workspace with the default timespan", async () => {
    const result = await run(["query", "SigninLogs | take 5", "--workspace", WS]);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(lastRequest().resource).toBe("logs");
    expect(lastRequest().path).toBe(`/v1/workspaces/${WS}/query`);
    expect(lastRequest().body).toEqual({ query: "SigninLogs | take 5", timespan: "P1D" });
    expect(result.workspace).toBe(WS);
    expect(result.timespan).toBe("P1D");
    expect(result.total).toBe(2);
    expect(result.count).toBe("2 rows");
    expect((result.rows as Array<unknown>)).toHaveLength(2);
  });

  it("resolves a workspace alias from the profile", async () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ profiles: { work: { auth: "az", workspaces: { sentinel: WS } } }, defaultProfile: "work" }),
    );
    const result = await run(["query", "SigninLogs | take 1", "--workspace", "sentinel"]);
    expect(lastRequest().path).toBe(`/v1/workspaces/${WS}/query`);
    expect(result.workspace).toBe("sentinel");
    expect(result.workspaceId).toBe(WS);
  });

  it("converts relative timespans to ISO 8601 durations", async () => {
    await run(["query", "SigninLogs | take 1", "--workspace", WS, "--timespan", "24h"]);
    expect(lastRequest().body).toMatchObject({ timespan: "PT24H" });
    await run(["query", "SigninLogs | take 1", "--workspace", WS, "--timespan", "P7D"]);
    expect(lastRequest().body).toMatchObject({ timespan: "P7D" });
  });

  it("rejects an ARM resource ID with the rg query that finds the GUID", async () => {
    await expect(run(["query", "SigninLogs | take 1", "--workspace", ARM_ID])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(run(["query", "SigninLogs | take 1", "--workspace", ARM_ID])).rejects.toThrow(/workspace ID GUID/);
    try {
      await run(["query", "SigninLogs | take 1", "--workspace", ARM_ID]);
    } catch (err) {
      const suggestions = (err as { suggestions: string[] }).suggestions.join("\n");
      expect(suggestions).toContain("az-axi rg query");
      expect(suggestions).toContain("properties.customerId");
      expect(suggestions).not.toContain("config init");
    }
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("accepts a braced GUID and refuses an alias that stores an ARM ID", async () => {
    await run(["query", "SigninLogs | take 1", "--workspace", `{${WS}}`]);
    expect(lastRequest().path).toBe(`/v1/workspaces/${WS}/query`);

    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ profiles: { work: { auth: "az", workspaces: { sentinel: ARM_ID } } }, defaultProfile: "work" }),
    );
    await expect(run(["query", "SigninLogs | take 1", "--workspace", "sentinel"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("sends an ISO date as an interval ending now and a start/end pair unchanged in meaning", async () => {
    await run(["query", "SigninLogs | take 1", "--workspace", WS, "--timespan", "2020-01-01T00:00:00Z"]);
    const timespan = lastRequest().body.timespan as string;
    expect(timespan.startsWith("2020-01-01T00:00:00.000Z/")).toBe(true);
    expect(Date.parse(timespan.split("/")[1] ?? "")).toBeGreaterThan(Date.parse("2020-01-01T00:00:00Z"));
    expect(lastRequest().body.query).toBe("SigninLogs | take 1");

    await run(["query", "SigninLogs | take 1", "--workspace", WS, "--timespan", "2020-01-01/2020-01-02"]);
    expect(lastRequest().body.timespan).toBe("2020-01-01T00:00:00.000Z/2020-01-02T00:00:00.000Z");
  });

  it("returns a warning instead of failing on partial errors", async () => {
    sendMock.mockResolvedValue({
      status: 200,
      headers: {},
      body: kustoBody(1, { error: { code: "PartialError", message: "One shard timed out" } }),
      clientRequestId: "req-1",
    });
    const result = await run(["query", "SigninLogs | take 1", "--workspace", WS]);
    expect(result.warning).toMatch(/partial error/i);
    expect(result.total).toBe(1);
    expect((result.rows as Array<unknown>)).toHaveLength(1);
  });

  it("reports extra tables as counts only", async () => {
    sendMock.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        tables: [
          { name: "PrimaryResult", columns: [{ name: "a", type: "string" }], rows: [["x"]] },
          { name: "QueryCompletionInformation", columns: [{ name: "code", type: "string" }], rows: [["Done"]] },
        ],
      },
      clientRequestId: "req-1",
    });
    const result = await run(["query", "SigninLogs | take 1", "--workspace", WS]);
    expect(result.otherTables).toEqual([{ name: "QueryCompletionInformation", count: 1 }]);
    expect((result.rows as Array<unknown>)).toHaveLength(1);
  });

  it("caps rows client-side and hints at summarize or take", async () => {
    sendMock.mockResolvedValue({
      status: 200,
      headers: {},
      body: kustoBody(5),
      clientRequestId: "req-1",
    });
    const result = await run(["query", "SigninLogs | take 5", "--workspace", WS, "--limit", "2"]);
    expect((result.rows as Array<unknown>)).toHaveLength(2);
    expect(result.count).toBe("2 of 5 rows");
    expect((result.help as string[]).join("\n")).toMatch(/summarize|take/);
  });

  it("returns an explicit empty state", async () => {
    sendMock.mockResolvedValue({
      status: 200,
      headers: {},
      body: { tables: [{ name: "PrimaryResult", columns: [{ name: "a", type: "string" }], rows: [] }] },
      clientRequestId: "req-1",
    });
    const result = await run(["query", "SigninLogs | where false", "--workspace", WS]);
    expect(result.count).toBe("0 rows");
    expect(result.rows).toMatch(/^0 rows found/);
    expect((result.help as string[]).join("\n")).toMatch(/--timespan/);
    expect((result.help as string[]).join("\n")).not.toMatch(/sub list/);
  });

  it("treats an empty 204 body as no rows", async () => {
    sendMock.mockResolvedValue({ status: 204, headers: {}, body: undefined, clientRequestId: "req-1" });
    const result = await run(["query", "SigninLogs | take 1", "--workspace", WS]);
    expect(result.count).toBe("0 rows");
    expect(result.rows).toMatch(/^0 rows found/);
  });

  it("truncates cells at 200 chars unless --full and honors --fields", async () => {
    const big = "x".repeat(500);
    sendMock.mockResolvedValue({
      status: 200,
      headers: {},
      body: { tables: [{ name: "PrimaryResult", columns: [{ name: "note", type: "string" }], rows: [[big]] }] },
      clientRequestId: "req-1",
    });
    const truncated = (await run(["query", "SigninLogs | take 1", "--workspace", WS])).rows as Array<Record<string, unknown>>;
    expect(String(truncated[0]?.["note"])).toContain("truncated");
    const full = (await run(["query", "SigninLogs | take 1", "--workspace", WS, "--full"])).rows as Array<Record<string, unknown>>;
    expect(String(full[0]?.["note"])).toHaveLength(500);
    const picked = (await run(["query", "SigninLogs | take 1", "--workspace", WS, "--fields", "note"])).rows as Array<unknown>;
    expect(picked[0]).toEqual({ note: expect.any(String) });
  });

  it("reads multi-line KQL from --file and stdin", async () => {
    const file = join(dir, "hunt.kql");
    writeFileSync(file, "SigninLogs\n| take 5\n");
    await run(["query", "--file", file, "--workspace", WS]);
    expect(lastRequest().body).toMatchObject({ query: "SigninLogs\n| take 5" });

    stdinMock.mockResolvedValueOnce(Buffer.from("SigninLogs | take 9\n"));
    await run(["query", "--workspace", WS]);
    expect(lastRequest().body).toMatchObject({ query: "SigninLogs | take 9" });
  });

  it("rejects bad usage", async () => {
    await expect(run([])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["query"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["query", "q"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["query", "q", "--workspace", WS, "--timespan", "yesterday"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(run(["query", "q", "--workspace", WS, "--limit", "0"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(run(["query", "q", "--workspace", WS, "--ws", WS])).rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
    await expect(run(["query", "--file", "--workspace", WS])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["query", "q", "--workspace", WS, "--timespan", "2999-01-01"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(run(["query", "q", "--workspace", WS, "--timespan", "P0D"])).rejects.toThrow(/timespan/);
    try {
      await run(["query", "q", "--workspace", WS, "--timespan", "P0D"]);
    } catch (err) {
      const suggestions = (err as { suggestions?: string[] }).suggestions ?? [];
      expect(`${(err as Error).message}\n${suggestions.join("\n")}`).not.toMatch(/--since/);
    }
  });
});
