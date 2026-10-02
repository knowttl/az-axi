import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ sendRequest: vi.fn(), requestAll: vi.fn() }));

import { run } from "../src/commands/defender.js";
import { requestAll, sendRequest } from "../src/lib/client.js";
import { clearSubscriptionCache } from "../src/lib/scope.js";

const sendMock = vi.mocked(sendRequest);
const allMock = vi.mocked(requestAll);

const SYN = (n: number) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;
const SUB_A = SYN(20);
const SUB_B = SYN(21);

const alertId = (sub: string, name: string) =>
  `/subscriptions/${sub}/providers/Microsoft.Security/locations/westeurope/alerts/${name}`;

// source: Defender alerts 2022-01-01 alerts.json examples (identifiers replaced)
const alert = (overrides: Record<string, unknown> = {}) => ({
  id: alertId(SUB_A, "alert-1"),
  name: "alert-1",
  properties: {
    alertDisplayName: "Suspicious process execution",
    description: "A process behaved unusually on the virtual machine.",
    severity: "High",
    status: "Active",
    timeGeneratedUtc: "2026-09-30T12:00:00.000Z",
    remediationSteps: ["Isolate the machine", "Reset credentials"],
    resourceIdentifiers: [
      {
        azureResourceId: `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Compute/virtualMachines/vm1`,
      },
    ],
    entities: [{ type: "host", hostname: "vm1" }],
  },
  ...overrides,
});

let dir: string;
const ENV_KEYS = ["AZ_AXI_CONFIG", "AZ_AXI_PROFILE", "AZ_AXI_SUBSCRIPTION", "AZ_AXI_TENANT"];
let saved: Record<string, string | undefined>;

function mockAlerts(pages: Record<string, Array<Record<string, unknown>>>) {
  sendMock.mockImplementation(async (_profile: unknown, options: Record<string, unknown>) => {
    const path = String(options["path"] ?? "");
    if (typeof options["body"] === "object" && options["body"] !== null && "query" in (options["body"] as object)) {
      return { status: 200, headers: {}, body: { data: [] }, clientRequestId: "r" } as never;
    }
    // A path ending in /alerts/<name> is a single-alert GET; anything else lists.
    if (!path.endsWith("/alerts") && /\/alerts\/[^/]+$/i.test(path)) {
      return { status: 200, headers: {}, body: { ...alert(), id: path }, clientRequestId: "r" } as never;
    }
    const match = /\/subscriptions\/([^/]+)\//i.exec(path);
    const sub = (match?.[1] ?? SUB_A).toLowerCase();
    const value = pages[sub] ?? pages[sub.toLowerCase()] ?? [];
    return { status: 200, headers: {}, body: { value }, clientRequestId: "r" } as never;
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-defalerts-"));
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AZ_AXI_CONFIG = join(dir, "config.json");
  clearSubscriptionCache();
  sendMock.mockReset();
  allMock.mockReset();
  allMock.mockResolvedValue({ items: [{ subscriptionId: SUB_A, displayName: "Sandbox" }] });
  mockAlerts({ [SUB_A]: [alert()], [SUB_A.toLowerCase()]: [alert()] });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
  clearSubscriptionCache();
});

describe("defender alerts", () => {
  it("lists active alerts newest first with severity aggregates", async () => {
    const older = alert({
      id: alertId(SUB_A, "alert-0"),
      name: "alert-0",
      properties: {
        alertDisplayName: "Old finding",
        severity: "Medium",
        status: "Active",
        timeGeneratedUtc: "2026-09-29T10:00:00.000Z",
        resourceIdentifiers: [],
      },
    });
    const dismissed = alert({
      id: alertId(SUB_A, "alert-9"),
      name: "alert-9",
      properties: { alertDisplayName: "Dismissed", severity: "High", status: "Dismissed", timeGeneratedUtc: "2026-09-30T13:00:00.000Z", resourceIdentifiers: [] },
    });
    mockAlerts({ [SUB_A]: [older, dismissed, alert()], [SUB_A.toLowerCase()]: [older, dismissed, alert()] });
    const result = await run(["alerts", "--subscription", SUB_A]);
    const [, options] = sendMock.mock.calls.find(
      ([, o]) => String((o as Record<string, unknown>)["path"] ?? "").includes("/providers/Microsoft.Security/alerts"),
    ) as unknown as [unknown, { path: string; apiVersion: string; method: string }];
    expect(options.apiVersion).toBe("2022-01-01");
    expect(options.method).toBe("GET");
    // Dismissed is filtered by the default --status Active; newest Active sorts first.
    expect(result.total).toBe(2);
    expect(result.count).toBe("2 alerts");
    expect(result.bySeverity).toEqual({ High: 1, Medium: 1 });
    const rows = result.rows as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ severity: "High", status: "Active" });
    expect(String(rows[0]?.["alert"])).toContain("Suspicious process");
    expect(rows[0]?.["resource"]).toBe("Sandbox/rg-demo/vm/vm1");
  });

  it("filters by severity and since", async () => {
    expect((await run(["alerts", "--subscription", SUB_A, "--severity", "High"])).total).toBe(1);
    expect((await run(["alerts", "--subscription", SUB_A, "--severity", "High,Medium"])).total).toBe(1);
    expect((await run(["alerts", "--subscription", SUB_A, "--severity", "Low"])).total).toBe(0);
    expect((await run(["alerts", "--subscription", SUB_A, "--since", "7d"])).total).toBe(1);
    expect((await run(["alerts", "--subscription", SUB_A, "--since", "1m"])).total).toBe(0);
  });

  it("merges subscriptions and degrades one failure with a hint", async () => {
    allMock.mockResolvedValue({
      items: [
        { subscriptionId: SUB_A, displayName: "Sandbox" },
        { subscriptionId: SUB_B, displayName: "Lab" },
      ],
    });
    sendMock.mockImplementation(async (_profile: unknown, options: Record<string, unknown>) => {
      const path = String(options["path"] ?? "");
      if (path.toLowerCase().includes(SUB_B.toLowerCase())) throw new Error("denied");
      return { status: 200, headers: {}, body: { value: [alert()] }, clientRequestId: "r" } as never;
    });
    const result = await run(["alerts", "--subscription", `${SUB_A},${SUB_B}`]);
    expect(result.total).toBe(1);
    expect((result.help as string[]).join("\n")).toMatch(/could not query 1 subscription/i);
  });

  it("throws when every subscription fails", async () => {
    sendMock.mockRejectedValue(new Error("denied"));
    await expect(run(["alerts", "--subscription", SUB_A])).rejects.toThrow("denied");
  });

  it("returns an explicit empty state", async () => {
    mockAlerts({});
    const result = await run(["alerts", "--subscription", SUB_A]);
    expect(result.rows).toMatch(/^0 Defender alerts found/);
    expect((result.help as string[]).join("\n")).toContain("--since 30d");
  });

  it("gets one alert with truncated remediation and full detail", async () => {
    const id = alertId(SUB_A, "alert-1");
    const detail = await run(["alerts", "get", id]);
    expect(detail).toMatchObject({ severity: "High", status: "Active", entities: "host: 1" });
    expect(String(detail.remediation)).toContain("Isolate the machine");

    const long = alert({
      properties: {
        alertDisplayName: "Long",
        severity: "High",
        status: "Active",
        timeGeneratedUtc: "2026-09-30T12:00:00.000Z",
        description: "d".repeat(500),
        remediationSteps: ["r".repeat(500)],
        resourceIdentifiers: [],
        entities: [],
      },
    });
    sendMock.mockResolvedValue({ status: 200, headers: {}, body: long, clientRequestId: "r" } as never);
    const short = await run(["alerts", "get", id]);
    expect(String(short.description)).toContain("truncated");
    expect((short.help as string[]).join("\n")).toContain("--full");
    const both = (await run(["alerts", "get", id, "--full"])) as Record<string, unknown>;
    expect(String(both.description)).toHaveLength(500);
    expect(String(both.remediation)).toHaveLength(500);
  });

  it("rejects a bare name for get", async () => {
    await expect(run(["alerts", "get", "alert-1"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["alerts", "get"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rejects bad usage", async () => {
    await expect(run([])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["alerts", "extra"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["alerts", "--limit", "0"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["alerts", "--top", "5"])).rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
    await expect(run(["nonsense"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["alerts", "--subscription", "not-a-guid"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["alerts", "get", alertId(SUB_A, "alert-1"), "--severity", "High"])).rejects.toMatchObject({
      code: "UNKNOWN_FLAG",
    });
  });

  it("lists every status when --status all is set", async () => {
    const dismissed = alert({
      id: alertId(SUB_A, "alert-9"),
      name: "alert-9",
      properties: {
        alertDisplayName: "Dismissed",
        severity: "Low",
        status: "Dismissed",
        timeGeneratedUtc: "2026-09-30T13:00:00.000Z",
        resourceIdentifiers: [],
      },
    });
    mockAlerts({ [SUB_A]: [alert(), dismissed], [SUB_A.toLowerCase()]: [alert(), dismissed] });
    expect((await run(["alerts", "--subscription", SUB_A, "--status", "all"])).total).toBe(2);
    expect((await run(["alerts", "--subscription", SUB_A])).total).toBe(1);
  });

  it("says when alert paging is capped", async () => {
    let page = 0;
    sendMock.mockImplementation(async () => {
      page++;
      return {
        status: 200,
        headers: {},
        body: {
          value: [alert({ id: alertId(SUB_A, `alert-${page}`), name: `alert-${page}` })],
          nextLink: `https://management.azure.com/subscriptions/${SUB_A}/providers/Microsoft.Security/alerts?page=${page}`,
        },
        clientRequestId: "r",
      } as never;
    });
    const result = await run(["alerts", "--subscription", SUB_A]);
    expect(sendMock.mock.calls.length).toBe(10);
    expect((result.help as string[]).join("\n")).toContain("capped at 10 pages");
  });
});
