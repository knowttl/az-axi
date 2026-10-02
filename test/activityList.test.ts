import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ sendRequest: vi.fn(), requestAll: vi.fn() }));

import { run } from "../src/commands/activity.js";
import { requestAll, sendRequest } from "../src/lib/client.js";
import { clearSubscriptionCache } from "../src/lib/scope.js";

const sendMock = vi.mocked(sendRequest);
const allMock = vi.mocked(requestAll);

const SYN = (n: number) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;
const SUB_A = SYN(20);
const SUB_B = SYN(21);

// source: monitor Insights 2015-04-01 activityLogs_API.json examples (identifiers replaced)
const evt = (overrides: Record<string, unknown> = {}) => ({
  eventTimestamp: "2026-09-30T12:00:00.000Z",
  caller: "analyst@contoso.com",
  operationName: { value: "Microsoft.Compute/virtualMachines/write", localizedValue: "Create or Update Virtual Machine" },
  status: { value: "Succeeded", localizedValue: "Succeeded" },
  resourceId: `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Compute/virtualMachines/vm1`,
  resourceGroupName: "rg-demo",
  correlationId: SYN(60),
  ...overrides,
});

let dir: string;
const ENV_KEYS = ["AZ_AXI_CONFIG", "AZ_AXI_PROFILE", "AZ_AXI_SUBSCRIPTION", "AZ_AXI_TENANT"];
let saved: Record<string, string | undefined>;

function mockActivity(pages: Record<string, Array<Record<string, unknown>>>) {
  sendMock.mockImplementation(async (_profile: unknown, options: Record<string, unknown>) => {
    const path = String(options["path"] ?? "");
    if (path.startsWith("https://")) {
      const next = Object.values(pages).flat().length > 0 ? [] : [];
      void next;
      return { status: 200, headers: {}, body: { value: [] }, clientRequestId: "r" } as never;
    }
    const match = /\/subscriptions\/([^/]+)\//i.exec(path);
    const sub = match?.[1] ?? SUB_A;
    const value = pages[sub.toLowerCase()] ?? pages[sub] ?? [];
    return { status: 200, headers: {}, body: { value }, clientRequestId: "r" } as never;
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-activity-"));
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AZ_AXI_CONFIG = join(dir, "config.json");
  clearSubscriptionCache();
  sendMock.mockReset();
  allMock.mockReset();
  allMock.mockResolvedValue({ items: [{ subscriptionId: SUB_A, displayName: "Sandbox" }] });
  mockActivity({ [SUB_A]: [evt()], [SUB_A.toLowerCase()]: [evt()] });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
  clearSubscriptionCache();
});

function lastQuery() {
  const call = sendMock.mock.calls.at(-1)?.[1] as { query?: Record<string, string>; apiVersion?: string; path: string };
  return call;
}

describe("activity list", () => {
  it("queries one subscription with a time filter and formats rows", async () => {
    const result = await run(["list", "--subscription", SUB_A, "--since", "24h"]);
    const q = lastQuery();
    expect(q.apiVersion).toBe("2015-04-01");
    expect(q.query?.["$filter"]).toContain("eventTimestamp ge");
    expect(q.query?.["$filter"]).toContain("eventTimestamp le");
    expect(q.query?.["$select"]).toContain("eventTimestamp");
    expect(result.total).toBe(1);
    expect(result.count).toBe("1 events");
    expect(result.topCallers).toEqual({ "analyst@contoso.com": 1 });
    const rows = result.rows as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ caller: "analyst@contoso.com", status: "Succeeded" });
    expect(String(rows[0]?.["operation"])).toContain("Microsoft.Compute");
  });

  it("rejects --since older than 90 days with a logs query hint", async () => {
    sendMock.mockClear();
    await expect(run(["list", "--subscription", SUB_A, "--since", "120d"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    try {
      await run(["list", "--subscription", SUB_A, "--since", "120d"]);
    } catch (err) {
      expect((err as { suggestions: string[] }).suggestions.join("\n")).toContain("logs query");
    }
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("merges multiple subscriptions newest first", async () => {
    allMock.mockResolvedValue({
      items: [
        { subscriptionId: SUB_A, displayName: "Sandbox" },
        { subscriptionId: SUB_B, displayName: "Lab" },
      ],
    });
    mockActivity({
      [SUB_A]: [evt({ eventTimestamp: "2026-09-29T10:00:00.000Z", caller: "old@contoso.com" })],
      [SUB_B]: [evt({ eventTimestamp: "2026-09-30T12:00:00.000Z", caller: "new@contoso.com" })],
      [SUB_A.toLowerCase()]: [evt({ eventTimestamp: "2026-09-29T10:00:00.000Z", caller: "old@contoso.com" })],
      [SUB_B.toLowerCase()]: [evt({ eventTimestamp: "2026-09-30T12:00:00.000Z", caller: "new@contoso.com" })],
    });
    const result = await run(["list", "--subscription", `${SUB_A},${SUB_B}`, "--since", "7d"]);
    expect(result.total).toBe(2);
    const rows = result.rows as Array<Record<string, unknown>>;
    expect(rows[0]?.["caller"]).toBe("new@contoso.com");
    expect(rows[1]?.["caller"]).toBe("old@contoso.com");
    expect(sendMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("filters caller, status and operation client-side and sends resource-group server-side", async () => {
    mockActivity({
      [SUB_A]: [
        evt({ caller: "analyst@contoso.com", status: { value: "Failed" }, operationName: { value: "Microsoft.Storage/delete" } }),
        evt({ caller: "other@contoso.com", status: { value: "Succeeded" }, operationName: { value: "Microsoft.Compute/write" } }),
      ],
      [SUB_A.toLowerCase()]: [
        evt({ caller: "analyst@contoso.com", status: { value: "Failed" }, operationName: { value: "Microsoft.Storage/delete" } }),
        evt({ caller: "other@contoso.com", status: { value: "Succeeded" }, operationName: { value: "Microsoft.Compute/write" } }),
      ],
    });
    expect((await run(["list", "--subscription", SUB_A, "--caller", "analyst@contoso.com"])).total).toBe(1);
    expect((await run(["list", "--subscription", SUB_A, "--status", "Failed"])).total).toBe(1);
    expect((await run(["list", "--subscription", SUB_A, "--status", "failed"])).total).toBe(1);
    expect((await run(["list", "--subscription", SUB_A, "--operation", "storage"])).total).toBe(1);

    await run(["list", "--subscription", SUB_A, "--resource-group", "rg-demo"]);
    expect(lastQuery().query?.["$filter"]).toContain("resourceGroupName eq 'rg-demo'");
  });

  it("follows nextLink until the limit is collected", async () => {
    const first = [evt({ caller: "one@contoso.com" })];
    const second = [evt({ caller: "two@contoso.com" })];
    let calls = 0;
    sendMock.mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        return {
          status: 200,
          headers: {},
          body: { value: first, nextLink: "https://management.azure.com/next-page" },
          clientRequestId: "r",
        } as never;
      }
      return { status: 200, headers: {}, body: { value: second }, clientRequestId: "r" } as never;
    });
    const result = await run(["list", "--subscription", SUB_A, "--limit", "2"]);
    expect(result.total).toBe(2);
    expect(calls).toBe(2);
  });

  it("returns an explicit empty state", async () => {
    mockActivity({ [SUB_A]: [], [SUB_A.toLowerCase()]: [] });
    const result = await run(["list", "--subscription", SUB_A]);
    expect(result.rows).toMatch(/^0 activity events found/);
    expect((result.help as string[]).join("\n")).toContain("--status Failed");
  });

  it("picks fields and shortens resources unless --full", async () => {
    const picked = (await run(["list", "--subscription", SUB_A, "--fields", "caller,status"])).rows as Array<
      Record<string, unknown>
    >;
    expect(picked[0]).toEqual({ caller: "analyst@contoso.com", status: "Succeeded" });

    const short = (await run(["list", "--subscription", SUB_A])).rows as Array<Record<string, unknown>>;
    expect(short[0]?.["resource"]).toBe("Sandbox/rg-demo/vm/vm1");

    const full = (await run(["list", "--subscription", SUB_A, "--full"])).rows as Array<Record<string, unknown>>;
    expect(full[0]?.["resource"]).toContain("/subscriptions/");
  });

  it("rejects bad usage", async () => {
    await expect(run([])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["get"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["list", "extra"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["list", "--since", "yesterday"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["list", "--limit", "0"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["list", "--top", "5"])).rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
  });
});
