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
import { SUB_A, SUB_B, WORKSPACE, discoveryWorkspace, sentinelIncidentAlerts, sentinelIncidentEntities, sentinelIncidents } from "./samples.js";

const allMock = vi.mocked(requestAll);
const requestMock = vi.mocked(request);

const SELECTORS = ["--resource-group", "rg-demo", "--workspace-name", "logs-demo", "--subscription", SUB_A];
const INCIDENT_A = sentinelIncidents[0]!;
const ALERT_A = sentinelIncidentAlerts[0]!;
const ENTITY_A = sentinelIncidentEntities.entities[0]!;

let dir: string;
const ENV_KEYS = ["AZ_AXI_CONFIG", "AZ_AXI_PROFILE", "AZ_AXI_SUBSCRIPTION", "AZ_AXI_TENANT"];
let saved: Record<string, string | undefined>;

function mockTransport(options: { incidents?: unknown[]; alerts?: unknown[]; entities?: unknown } = {}) {
  const incidents = options.incidents ?? sentinelIncidents;
  const alerts = options.alerts ?? sentinelIncidentAlerts;
  const entities = options.entities ?? sentinelIncidentEntities;
  allMock.mockImplementation(async (_profile: unknown, requestOptions: Record<string, unknown>) => {
    const path = String(requestOptions["path"] ?? "");
    if (path === "/subscriptions") {
      return { items: [
        { subscriptionId: SUB_A, displayName: "Sandbox" },
        { subscriptionId: SUB_B, displayName: "Lab" },
      ] };
    }
    if (/\/workspaces$/i.test(path)) return { items: [discoveryWorkspace] };
    if (/\/incidents$/i.test(path)) return { items: incidents };
    throw new Error(`unexpected offline path: ${path}`);
  });
  requestMock.mockImplementation(async (_profile: unknown, requestOptions: Record<string, unknown>) => {
    const path = String(requestOptions["path"] ?? "");
    if (path.endsWith("/alerts")) return { value: alerts } as never;
    if (path.endsWith("/entities")) return entities as never;
    throw new Error(`unexpected offline path: ${path}`);
  });
}

function useProfile(name = "ci", profile: Record<string, unknown> = { auth: "token" }) {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { [name]: profile } }));
  process.env.AZ_AXI_PROFILE = name;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-sentinel-related-"));
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

describe("sentinel incident list-alert", () => {
  it("lists compact alert rows through a bodyless read POST with aggregates and an entity hint", async () => {
    const result = await run(["incident", "list-alert", "--name", INCIDENT_A.name!, ...SELECTORS]);
    expect(result).toMatchObject({
      profile: "ci",
      workspace: "logs-demo",
      incident: INCIDENT_A.name,
      total: 2,
      count: "2 incident alerts",
      bySeverity: { Low: 1, Medium: 1 },
      byStatus: { New: 1, Active: 1 },
      rows: [
        { name: ALERT_A.name, alert: "myAlert", severity: "Low", status: "New", time: shortDate("2026-09-30T13:15:30Z") },
        { name: sentinelIncidentAlerts[1]!.name, alert: "Unusual outbound volume", severity: "Medium", status: "Active", time: shortDate("2026-09-29T10:00:00Z") },
      ],
    });
    expect(result.help).toEqual([expect.stringContaining("sentinel incident list-entity")]);
    expect(requestMock).toHaveBeenCalledTimes(1);
    const options = requestMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(options["method"]).toBe("POST");
    expect(String(options["path"] ?? "")).toMatch(
      new RegExp(`/incidents/${INCIDENT_A.name}/alerts$`, "i"));
    expect(options["apiVersion"]).toBe("2025-09-01");
    expect(options).not.toHaveProperty("body");
    for (const path of allMock.mock.calls.map((call) => String((call[1] as { path?: string }).path))) {
      expect(path).not.toContain("?");
    }
  });

  it("resolves the incident by number, ARM ID and incident-id flag, and accepts the alert-list alias", async () => {
    await expect(run(["incident", "list-alert", "--name", "3177", ...SELECTORS]))
      .resolves.toMatchObject({ incident: "3177", total: 2 });
    await expect(run(["incident", "list-alert", "--ids", INCIDENT_A.id!]))
      .resolves.toMatchObject({ incident: INCIDENT_A.name, total: 2 });
    await expect(run(["incident", "list-alert", "--incident-id", INCIDENT_A.name!, ...SELECTORS]))
      .resolves.toMatchObject({ total: 2 });
    await expect(run(["incident", "alert", "list", "--name", INCIDENT_A.name!, ...SELECTORS]))
      .resolves.toMatchObject({ total: 2 });
    useProfile("ci", { auth: "token", subscriptions: [SUB_A], workspaces: { sentinel: WORKSPACE } });
    await expect(run(["incident", "list-alert", "--name", INCIDENT_A.name!, "--workspace", "sentinel"]))
      .resolves.toMatchObject({ workspace: "logs-demo", total: 2 });
  });

  it("shows full rows, selected fields and capped pages", async () => {
    const full = await run(["incident", "list-alert", "--name", INCIDENT_A.name!, ...SELECTORS, "--full"]);
    expect((full.rows as Array<Record<string, unknown>>)[0]).toMatchObject(
      { name: ALERT_A.name, id: ALERT_A.id, tactics: ["Persistence"], product: "Azure Security Center" });
    const fields = await run(["incident", "list-alert", "--name", INCIDENT_A.name!, ...SELECTORS, "--fields", "name,severity"]);
    expect(fields.rows).toEqual([{ name: ALERT_A.name, severity: "Low" }, { name: sentinelIncidentAlerts[1]!.name, severity: "Medium" }]);
    const capped = await run(["incident", "list-alert", "--name", INCIDENT_A.name!, ...SELECTORS, "--limit", "1"]);
    expect(capped).toMatchObject({ total: 2, count: "1 of 2 incident alerts" });
    expect(capped.help).toEqual(expect.arrayContaining([expect.stringContaining("--full")]));
  });

  it("reports an explicit empty state with a detail hint", async () => {
    mockTransport({ alerts: [] });
    const result = await run(["incident", "list-alert", "--name", INCIDENT_A.name!, ...SELECTORS]);
    expect(result).toMatchObject({
      total: 0,
      count: "0 incident alerts",
      rows: expect.stringContaining(`0 incident alerts found for incident ${INCIDENT_A.name} in workspace logs-demo`),
    });
    expect(result.help).toEqual([expect.stringContaining("sentinel incident show")]);
  });

  it("surfaces access-denied failures without masking them as empty", async () => {
    requestMock.mockRejectedValueOnce(new AxiError("access denied: Denied", "FORBIDDEN", []));
    await expect(run(["incident", "list-alert", "--name", INCIDENT_A.name!, ...SELECTORS]))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses unknown incident identities before the related transport", async () => {
    await expect(run(["incident", "list-alert", "--name", "bogus", ...SELECTORS]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["incident", "list-alert", "--name", "9999", ...SELECTORS]))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(run(["incident", "list-alert", "--name", INCIDENT_A.name!]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("workspace") });
    await expect(run(["incident", "list-alert", "--name", INCIDENT_A.name!, ...SELECTORS, "--ids", INCIDENT_A.id!]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("not both") });
    await expect(run(["incident", "list-alert", "--name", INCIDENT_A.name!, ...SELECTORS, "--fields", "bogus"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe("sentinel incident list-entity", () => {
  it("lists compact entity rows with server metadata counts and an alert hint", async () => {
    const result = await run(["incident", "list-entity", "--name", INCIDENT_A.name!, ...SELECTORS]);
    expect(result).toMatchObject({
      profile: "ci",
      workspace: "logs-demo",
      incident: INCIDENT_A.name,
      total: 2,
      count: "2 incident entities",
      byKind: { Account: 1, Host: 1 },
      rows: [
        { kind: "Account", entity: "administrator", name: ENTITY_A.name },
        { kind: "Host", entity: "contoso-vm", name: sentinelIncidentEntities.entities[1]!.name },
      ],
    });
    expect(result.help).toEqual([expect.stringContaining("sentinel incident list-alert")]);
    expect(requestMock).toHaveBeenCalledTimes(1);
    const options = requestMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(options["method"]).toBe("POST");
    expect(String(options["path"] ?? "")).toMatch(
      new RegExp(`/incidents/${INCIDENT_A.name}/entities$`, "i"));
    expect(options["apiVersion"]).toBe("2025-09-01");
    expect(options).not.toHaveProperty("body");
  });

  it("resolves the incident by number, ARM ID and incident-id flag, and accepts the entity-list alias", async () => {
    await expect(run(["incident", "list-entity", "--name", "3176", ...SELECTORS]))
      .resolves.toMatchObject({ incident: "3176", total: 2 });
    await expect(run(["incident", "list-entity", "--ids", INCIDENT_A.id!]))
      .resolves.toMatchObject({ incident: INCIDENT_A.name, total: 2 });
    await expect(run(["incident", "entity", "list", "--name", INCIDENT_A.name!, ...SELECTORS]))
      .resolves.toMatchObject({ total: 2 });
  });

  it("counts kinds client-side when metadata is absent, and shows full rows and fields", async () => {
    mockTransport({ entities: { entities: sentinelIncidentEntities.entities } });
    const result = await run(["incident", "list-entity", "--name", INCIDENT_A.name!, ...SELECTORS]);
    expect(result).toMatchObject({ byKind: { Account: 1, Host: 1 } });
    const full = await run(["incident", "list-entity", "--name", INCIDENT_A.name!, ...SELECTORS, "--full"]);
    expect((full.rows as Array<Record<string, unknown>>)[0]).toMatchObject({ kind: "Account", entity: "administrator", id: ENTITY_A.id });
    const fields = await run(["incident", "list-entity", "--name", INCIDENT_A.name!, ...SELECTORS, "--fields", "kind"]);
    expect(fields.rows).toEqual([{ kind: "Account" }, { kind: "Host" }]);
  });

  it("reports an explicit empty state and surfaces access-denied failures", async () => {
    mockTransport({ entities: { entities: [] } });
    const empty = await run(["incident", "list-entity", "--name", INCIDENT_A.name!, ...SELECTORS]);
    expect(empty).toMatchObject({
      total: 0,
      count: "0 incident entities",
      rows: expect.stringContaining("0 incident entities found"),
    });
    requestMock.mockRejectedValueOnce(new AxiError("access denied: Denied", "FORBIDDEN", []));
    await expect(run(["incident", "list-entity", "--name", INCIDENT_A.name!, ...SELECTORS]))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses conflicting selectors and unknown verbs before transport", async () => {
    await expect(run(["incident", "list-entity", "--ids", `${INCIDENT_A.id}/alerts`]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["incident", "alert"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["incident", "alert", "show"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(requestMock).not.toHaveBeenCalled();
  });
});
