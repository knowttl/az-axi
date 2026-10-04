import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ sendRequest: vi.fn(), request: vi.fn(), requestAll: vi.fn() }));

import { run } from "../src/commands/sentinel.js";
import { request, requestAll } from "../src/lib/client.js";
import { shortDate } from "../src/lib/format.js";
import { clearSubscriptionCache } from "../src/lib/scope.js";
import { SUB_A, SUB_B, WORKSPACE, discoveryWorkspace, sentinelIncidentDetail, sentinelIncidents } from "./samples.js";

const allMock = vi.mocked(requestAll);
const requestMock = vi.mocked(request);

const SELECTORS = ["--resource-group", "rg-demo", "--workspace-name", "logs-demo", "--subscription", SUB_A];
const INCIDENT_A = sentinelIncidents[0]!;
const INCIDENT_B = sentinelIncidents[1]!;

let dir: string;
const ENV_KEYS = ["AZ_AXI_CONFIG", "AZ_AXI_PROFILE", "AZ_AXI_SUBSCRIPTION", "AZ_AXI_TENANT"];
let saved: Record<string, string | undefined>;

function mockTransport(options: { incidents?: unknown[]; nextLink?: string; workspaces?: unknown[]; workspaceNextLink?: string } = {}) {
  const incidents = options.incidents ?? sentinelIncidents;
  allMock.mockImplementation(async (_profile: unknown, requestOptions: Record<string, unknown>) => {
    const path = String(requestOptions["path"] ?? "");
    if (path === "/subscriptions") {
      return { items: [
        { subscriptionId: SUB_A, displayName: "Sandbox" },
        { subscriptionId: SUB_B, displayName: "Lab" },
      ] };
    }
    if (/\/workspaces$/i.test(path)) return {
      items: options.workspaces ?? [discoveryWorkspace],
      ...(options.workspaceNextLink ? { nextLink: options.workspaceNextLink } : {}),
    };
    if (/\/incidents$/i.test(path)) {
      return { items: incidents, ...(options.nextLink ? { nextLink: options.nextLink } : {}) };
    }
    throw new Error(`unexpected offline path: ${path}`);
  });
  requestMock.mockImplementation(async (_profile: unknown, requestOptions: Record<string, unknown>) => {
    const path = String(requestOptions["path"] ?? "");
    const name = /\/incidents\/([^/]+)$/i.exec(path)?.[1];
    const found = incidents.find((incident) =>
      (incident as { name?: string }).name === name || (incident as { id?: string }).id === path);
    if (!found) throw new AxiError(`not found: ${path}`, "NOT_FOUND", []);
    return found as never;
  });
}

function useProfile(name = "ci", profile: Record<string, unknown> = { auth: "token", subscriptions: [SUB_A] }) {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { [name]: profile } }));
  process.env.AZ_AXI_PROFILE = name;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-sentinel-"));
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AZ_AXI_CONFIG = join(dir, "config.json");
  useProfile("ci", { auth: "token" });
  clearSubscriptionCache();
  allMock.mockReset();
  requestMock.mockReset();
  mockTransport();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
  clearSubscriptionCache();
});

describe("sentinel incident list", () => {
  it("lists compact rows newest first with aggregates and a detail hint", async () => {
    const result = await run(["incident", "list", ...SELECTORS]);
    expect(result).toMatchObject({
      profile: "ci",
      workspace: "logs-demo",
      total: 2,
      count: "2 incidents",
      bySeverity: { High: 1, Medium: 1 },
      byStatus: { Active: 1, New: 1 },
      rows: [
        { number: 3177, severity: "High", title: "Suspicious sign-in activity", status: "Active", time: shortDate("2026-09-30T13:15:30Z") },
        { number: 3176, severity: "Medium", title: "Unusual data transfer volume", status: "New", time: shortDate("2026-09-29T10:00:00Z") },
      ],
    });
    expect(result.help).toEqual([
      expect.stringContaining(`az-axi sentinel incident show --name ${INCIDENT_A.name}`),
    ]);
    const requested = allMock.mock.calls.map((call) => String((call[1] as { path?: string }).path));
    expect(requested).toContain(
      `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/incidents`,
    );
    for (const path of requested) expect(path).not.toContain("?");
  });

  it("filters by status, severity, owner and time window", async () => {
    await expect(run(["incident", "list", ...SELECTORS, "--status", "active"])).resolves.toMatchObject({ total: 1 });
    await expect(run(["incident", "list", ...SELECTORS, "--severity", "medium"])).resolves.toMatchObject({ total: 1 });
    await expect(run(["incident", "list", ...SELECTORS, "--owner", "CASEY hunter"])).resolves.toMatchObject({ total: 1 });
    await expect(run(["incident", "list", ...SELECTORS, "--owner", "nobody@contoso.com"])).resolves.toMatchObject({ total: 0 });
    await expect(run(["incident", "list", ...SELECTORS, "--since", "2026-09-30T00:00:00Z"])).resolves.toMatchObject({ total: 1 });
    await expect(run(["incident", "list", ...SELECTORS, "--status", "closed", "--severity", "High"])).resolves.toMatchObject({
      total: 0,
      rows: "0 incidents found in workspace logs-demo",
    });
  });

  it("resolves a profile workspace alias to subscription coordinates", async () => {
    useProfile("ci", { auth: "token", subscriptions: [SUB_A], workspaces: { sentinel: WORKSPACE } });
    const result = await run(["incident", "list", "--workspace", "sentinel"]);
    expect(result).toMatchObject({ profile: "ci", workspace: "logs-demo", total: 2 });
    const requested = allMock.mock.calls.map((call) => String((call[1] as { path?: string }).path));
    expect(requested.some((path) => path.endsWith("/providers/Microsoft.OperationalInsights/workspaces"))).toBe(true);
  });

  it.each(["assignedTo", "email", "userPrincipalName"])("matches the owner's %s independently", async (identity) => {
    mockTransport({ incidents: [{ ...INCIDENT_A, properties: {
      ...INCIDENT_A.properties,
      owner: { assignedTo: "Display name", email: "other@contoso.com", userPrincipalName: "other-upn@contoso.com", [identity]: "Hunter@contoso.com" },
    } }] });
    await expect(run(["incident", "list", ...SELECTORS, "--owner", "hunter@contoso.com"]))
      .resolves.toMatchObject({ total: 1 });
  });

  it.each([
    ["list", "sentinel", []],
    ["list", WORKSPACE, [discoveryWorkspace]],
    ["show", "sentinel", []],
    ["show", WORKSPACE, [discoveryWorkspace]],
  ])("refuses incomplete workspace resolution for %s with %s", async (verb, workspace, workspaces) => {
    useProfile("ci", { auth: "token", subscriptions: [SUB_A], workspaces: { sentinel: WORKSPACE } });
    mockTransport({ workspaces, workspaceNextLink: "https://management.azure.com/next" });
    await expect(run(["incident", verb, "--workspace", workspace, ...(verb === "show" ? ["--name", INCIDENT_A.name!] : [])]))
      .rejects.toMatchObject({ code: "INCOMPLETE_SEARCH", message: expect.stringContaining("100 pages") });
  });

  it("reports an explicit empty state with widening hints", async () => {
    mockTransport({ incidents: [] });
    const result = await run(["incident", "list", ...SELECTORS]);
    expect(result).toMatchObject({
      total: 0,
      count: "0 incidents",
      rows: "0 incidents found in workspace logs-demo",
    });
    expect(result.help).toEqual([expect.stringContaining("--since 30d"), expect.stringContaining("Drop a filter")]);
  });

  it("discloses capped paging as lower bounds", async () => {
    mockTransport({ nextLink: "https://management.azure.com/next?skiptoken=x" });
    const result = await run(["incident", "list", ...SELECTORS]);
    expect(result).toMatchObject({ total: "2+", count: "2 incidents" });
    expect(result.help).toEqual(expect.arrayContaining([expect.stringContaining("lower bounds")]));
  });

  it.each([{ incidents: [] }, { incidents: [INCIDENT_B] }])("discloses incomplete searches when no fetched incidents match: $incidents", async ({ incidents }) => {
    mockTransport({ incidents, nextLink: "https://management.azure.com/next" });
    const result = await run(["incident", "list", ...SELECTORS, "--status", "Active"]);
    expect(result).toMatchObject({ total: "0+", rows: expect.stringContaining("search is incomplete") });
    expect(result.help).toEqual(expect.arrayContaining([expect.stringContaining("lower bounds")]));
  });

  it("needs exactly one subscription for a single-workspace list", async () => {
    await expect(run(["incident", "list", "--resource-group", "rg-demo", "--workspace-name", "logs-demo"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("exactly one subscription") });
  });

  it("shows full rows and selected fields", async () => {
    const full = await run(["incident", "list", ...SELECTORS, "--full"]);
    expect(full.rows).toHaveLength(2);
    expect((full.rows as Array<Record<string, unknown>>)[0]).toMatchObject(
      { number: 3177, id: INCIDENT_A.id, owner: "Casey Hunter", created: "2026-09-30T13:15:30Z" });
    const byId = await run(["incident", "show", "--ids", String((full.rows as Array<Record<string, unknown>>)[0]!.id)]);
    expect(byId).toMatchObject({ number: 3177, id: INCIDENT_A.id });
    const fields = await run(["incident", "list", ...SELECTORS, "--fields", "number,owner"]);
    expect(fields.rows).toEqual([{ number: 3177, owner: "Casey Hunter" }, { number: 3176, owner: "" }]);
  });

  it.each([
    ["incident"],
    ["incident", "list"],
    ["incident", "list", "--workspace-name", "logs-demo"],
    ["incident", "list", "--workspace", "sentinel", "--workspace-name", "logs-demo", "--resource-group", "rg-demo", "--subscription", SUB_A],
    ["incident", "list", "--resource-group", "rg-demo", "--workspace-name", "logs-demo", `--subscription=${SUB_A},${SUB_B}`],
    ["incident", "list", ...SELECTORS, "--ids", INCIDENT_A.id!],
    ["incident", "list", ...SELECTORS, "--limit", "0"],
    ["incident", "list", ...SELECTORS, "--fields", "properties"],
    ["incident", "list", ...SELECTORS, "--since", "not-a-time"],
    ["incident", "list", ...SELECTORS, "--management-group", "root"],
    ["incident", "list", ...SELECTORS, "--output", "json"],
    ["incident", "list", ...SELECTORS, "stray"],
  ])("refuses %j before transport", async (...argv) => {
    await expect(run(argv)).rejects.toMatchObject({ code: expect.stringMatching(/VALIDATION_ERROR|UNKNOWN_FLAG/) });
    expect(allMock).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown workspace alias before incident transport", async () => {
    useProfile("ci", { auth: "token", subscriptions: [SUB_A], workspaces: { sentinel: WORKSPACE } });
    await expect(run(["incident", "list", "--workspace", "nope"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(allMock.mock.calls.map((call) => String((call[1] as { path?: string }).path)).some((path) => path.includes("/incidents"))).toBe(false);
  });

  it("propagates access-denied as a structured error", async () => {
    allMock.mockImplementation(async (_profile: unknown, requestOptions: Record<string, unknown>) => {
      if (String(requestOptions["path"] ?? "") === "/subscriptions") {
        return { items: [{ subscriptionId: SUB_A, displayName: "Sandbox" }] };
      }
      throw new AxiError("access denied: AuthorizationFailed", "FORBIDDEN", []);
    });
    await expect(run(["incident", "list", ...SELECTORS])).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("sentinel incident show", () => {
  it("shows an incident by GUID with truncated description", async () => {
    const result = await run(["incident", "show", "--name", INCIDENT_A.name!, ...SELECTORS]);
    expect(result).toMatchObject({
      profile: "ci",
      workspace: "logs-demo",
      number: 3177,
      id: INCIDENT_A.id,
      title: "Suspicious sign-in activity",
      severity: "High",
      status: "Active",
      owner: "Casey Hunter",
      labels: ["reviewed"],
      provider: "Azure Sentinel",
      tactics: ["Persistence"],
      alerts: 3,
      subscription: SUB_A,
    });
    expect(result).not.toHaveProperty("help");
  });

  it("shows an incident by number and by full ARM ID", async () => {
    const byNumber = await run(["incident", "show", "--name", "3176", ...SELECTORS]);
    expect(byNumber).toMatchObject({ number: 3176, id: INCIDENT_B.id });
    const byId = await run(["incident", "show", "--ids", INCIDENT_B.id!]);
    expect(byId).toMatchObject({ number: 3176, title: "Unusual data transfer volume" });
  });

  it("accepts --incident-id as an alias of --name", async () => {
    const result = await run(["incident", "show", "--incident-id", INCIDENT_A.name!, ...SELECTORS]);
    expect(result).toMatchObject({ number: 3177, id: INCIDENT_A.id });
    await expect(run(["incident", "show", "--name", INCIDENT_A.name!, "--incident-id", INCIDENT_B.name!, ...SELECTORS]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("--name conflicts with --incident-id") });
  });

  it("reports a missing incident number without inventing one", async () => {
    await expect(run(["incident", "show", "--name", "9999", ...SELECTORS])).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("incident number 9999"),
    });
  });

  it.each(["name", "incident-id"])("reports incomplete number searches through --%s", async (flag) => {
    mockTransport({ nextLink: "https://management.azure.com/next" });
    await expect(run(["incident", "show", `--${flag}`, "9999", ...SELECTORS]))
      .rejects.toMatchObject({ code: "INCOMPLETE_SEARCH", message: expect.stringContaining("10 pages") });
    await expect(run(["incident", "show", `--${flag}`, "3177", ...SELECTORS]))
      .resolves.toMatchObject({ number: 3177 });
  });

  it("expands long descriptions only with --full", async () => {
    const longDescription = "x".repeat(500);
    mockTransport({ incidents: [{ ...sentinelIncidentDetail, properties: { ...sentinelIncidentDetail.properties, description: longDescription } }] });
    const compact = await run(["incident", "show", "--name", INCIDENT_A.name!, ...SELECTORS]);
    expect(String(compact.description)).toContain("truncated, 500 chars total");
    expect(compact.help).toEqual([expect.stringContaining("--full")]);
    const full = await run(["incident", "show", "--name", INCIDENT_A.name!, ...SELECTORS, "--full"]);
    expect(full.description).toBe(longDescription);
    expect(full).not.toHaveProperty("help");
  });

  it.each([
    ["incident", "show"],
    ["incident", "show", "--name", INCIDENT_A.name!],
    ["incident", "show", "--name", INCIDENT_A.name!, "--ids", INCIDENT_A.id!],
    ["incident", "show", "--name", "not-a-guid-or-number", ...SELECTORS],
    ["incident", "show", "--name", INCIDENT_A.name!, "--workspace-name", "logs-demo"],
    ["incident", "show", "--ids", `${INCIDENT_A.id!}/alerts`],
    ["incident", "show", "--ids", INCIDENT_A.id!, "--subscription", SUB_B],
    ["incident", "show", "--ids", INCIDENT_A.id!, "--name", INCIDENT_A.name!],
    ["incident", "show", "--name", "3177", "--resource-group", "rg-demo", "--workspace-name", "logs-demo", `--subscription=${SUB_A},${SUB_B}`],
  ])("refuses %j", async (...argv) => {
    await expect(run(argv)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
