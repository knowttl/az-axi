import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ sendRequest: vi.fn(), request: vi.fn(), requestAll: vi.fn() }));

import { run } from "../src/commands/sentinel.js";
import { request, requestAll } from "../src/lib/client.js";
import { clearSubscriptionCache } from "../src/lib/scope.js";
import { SUB_A, SUB_B, WORKSPACE, discoveryWorkspace, sentinelAlertRuleDetail, sentinelAlertRules, sentinelDataConnectorDetail, sentinelDataConnectors } from "./samples.js";

const allMock = vi.mocked(requestAll);
const requestMock = vi.mocked(request);

const SELECTORS = ["--resource-group", "rg-demo", "--workspace-name", "logs-demo", "--subscription", SUB_A];
const RULE_A = sentinelAlertRules[0]!;
const RULE_B = sentinelAlertRules[1]!;
const CONNECTOR_A = sentinelDataConnectors[0]!;
const CONNECTOR_B = sentinelDataConnectors[1]!;

let dir: string;
const ENV_KEYS = ["AZ_AXI_CONFIG", "AZ_AXI_PROFILE", "AZ_AXI_SUBSCRIPTION", "AZ_AXI_TENANT"];
let saved: Record<string, string | undefined>;

function mockTransport(options: { rules?: unknown[]; connectors?: unknown } = {}) {
  const rules = options.rules ?? sentinelAlertRules;
  const connectors = options.connectors ?? sentinelDataConnectors;
  allMock.mockImplementation(async (_profile: unknown, requestOptions: Record<string, unknown>) => {
    const path = String(requestOptions["path"] ?? "");
    if (path === "/subscriptions") {
      return { items: [
        { subscriptionId: SUB_A, displayName: "Sandbox" },
        { subscriptionId: SUB_B, displayName: "Lab" },
      ] };
    }
    if (/\/workspaces$/i.test(path)) return { items: [discoveryWorkspace] };
    if (/\/alertRules$/i.test(path)) return { items: rules };
    if (/\/dataConnectors$/i.test(path)) return { items: connectors };
    throw new Error(`unexpected offline path: ${path}`);
  });
  requestMock.mockImplementation(async (_profile: unknown, requestOptions: Record<string, unknown>) => {
    const path = String(requestOptions["path"] ?? "");
    if (/\/alertRules\/[^/]+$/i.test(path)) {
      const found = (rules as typeof sentinelAlertRules).find((rule) => path.endsWith(`/${rule.name}`));
      if (!found) throw new AxiError(`not found: ${path}`, "NOT_FOUND", []);
      return found as never;
    }
    if (/\/dataConnectors\/[^/]+$/i.test(path)) {
      const found = (connectors as typeof sentinelDataConnectors).find((connector) => path.endsWith(`/${connector.name}`));
      if (!found) throw new AxiError(`not found: ${path}`, "NOT_FOUND", []);
      return found as never;
    }
    throw new Error(`unexpected offline path: ${path}`);
  });
}

function useProfile(name = "ci", profile: Record<string, unknown> = { auth: "token" }) {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { [name]: profile } }));
  process.env.AZ_AXI_PROFILE = name;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-sentinel-4c-"));
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

describe("sentinel alert-rule list", () => {
  it("lists compact rule rows with kind and enabled aggregates plus a detail hint", async () => {
    const result = await run(["alert-rule", "list", ...SELECTORS]);
    expect(result).toMatchObject({
      profile: "ci",
      workspace: "logs-demo",
      total: 2,
      count: "2 alert rules",
      byKind: { Scheduled: 1, MicrosoftSecurityIncidentCreation: 1 },
      byEnabled: { Enabled: 1, Disabled: 1 },
      rows: [
        { name: RULE_B.name, rule: "Create incidents from Defender alerts", kind: "MicrosoftSecurityIncidentCreation", enabled: false, severity: "" },
        { name: RULE_A.name, rule: "Suspicious sign-in burst", kind: "Scheduled", enabled: true, severity: "High" },
      ],
    });
    expect(result.help).toEqual([expect.stringContaining(`sentinel alert-rule show --name ${RULE_B.name}`)]);
    const options = allMock.mock.calls.map((call) => call[1] as Record<string, unknown>);
    expect(options.some((call) => String(call["path"] ?? "").endsWith("/alertRules"))).toBe(true);
    expect(options.find((call) => String(call["path"] ?? "").endsWith("/alertRules"))?.["apiVersion"]).toBe("2025-09-01");
    expect(options.find((call) => String(call["path"] ?? "").endsWith("/alertRules"))?.["method"]).toBe("GET");
    for (const path of options.map((call) => String(call["path"] ?? ""))) {
      expect(path).not.toContain("?");
    }
  });

  it("filters by kind and severity, and resolves workspace aliases", async () => {
    await expect(run(["alert-rule", "list", ...SELECTORS, "--kind", "scheduled"]))
      .resolves.toMatchObject({ total: 1 });
    await expect(run(["alert-rule", "list", ...SELECTORS, "--severity", "high"]))
      .resolves.toMatchObject({ total: 1 });
    await expect(run(["alert-rule", "list", ...SELECTORS, "--kind", "Fusion"]))
      .resolves.toMatchObject({ total: 0, count: "0 alert rules" });
    useProfile("ci", { auth: "token", subscriptions: [SUB_A], workspaces: { sentinel: WORKSPACE } });
    await expect(run(["alert-rule", "list", "--workspace", "sentinel"]))
      .resolves.toMatchObject({ workspace: "logs-demo", total: 2 });
  });

  it("shows full rows, selected fields and capped pages", async () => {
    const full = await run(["alert-rule", "list", ...SELECTORS, "--full"]);
    expect((full.rows as Array<Record<string, unknown>>)[0]).toMatchObject(
      { name: RULE_B.name, id: RULE_B.id, tactics: [], template: RULE_B.properties.alertRuleTemplateName });
    expect(full.rows).toHaveLength(2);
    const fields = await run(["alert-rule", "list", ...SELECTORS, "--fields", "name,severity"]);
    expect(fields.rows).toEqual([
      { name: RULE_B.name, severity: "" },
      { name: RULE_A.name, severity: "High" },
    ]);
    const capped = await run(["alert-rule", "list", ...SELECTORS, "--limit", "1"]);
    expect(capped).toMatchObject({ total: 2, count: "1 of 2 alert rules" });
    expect(capped.help).toEqual(expect.arrayContaining([expect.stringContaining("--full")]));
  });

  it("reports an explicit empty state with a filter hint", async () => {
    mockTransport({ rules: [] });
    const result = await run(["alert-rule", "list", ...SELECTORS]);
    expect(result).toMatchObject({
      total: 0,
      count: "0 alert rules",
      rows: expect.stringContaining("0 alert rules found in workspace logs-demo"),
    });
    expect(result.help).toEqual([expect.stringContaining("Drop a filter")]);
  });

  it("refuses bad selectors and flags before any rule transport", async () => {
    await expect(run(["alert-rule", "list"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("workspace") });
    await expect(run(["alert-rule", "list", ...SELECTORS, "--ids", RULE_A.id!]))
      .rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
    await expect(run(["alert-rule", "list", ...SELECTORS, "--workspace", "sentinel"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("conflicts") });
    await expect(run(["alert-rule", "list", ...SELECTORS, "--fields", "query"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("--fields supports only") });
    await expect(run(["alert-rule", "list", ...SELECTORS, "--limit", "0"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["alert-rule", "list", "--subscription", SUB_A, "--workspace", "bogus"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("unknown workspace") });
    for (const argv of [
      ["alert-rule", "list"],
      ["alert-rule", "list", ...SELECTORS, "--fields", "query"],
    ]) {
      allMock.mockClear();
      requestMock.mockClear();
      await expect(run(argv)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(allMock).not.toHaveBeenCalled();
      expect(requestMock).not.toHaveBeenCalled();
    }
  });
});

describe("sentinel alert-rule show", () => {
  it("shows one rule by name and ARM ID with truncated text plus a full hint", async () => {
    const result = await run(["alert-rule", "show", "--name", RULE_A.name!, ...SELECTORS]);
    expect(result).toMatchObject({
      profile: "ci",
      workspace: "logs-demo",
      name: RULE_A.name,
      id: RULE_A.id,
      rule: "Suspicious sign-in burst",
      kind: "Scheduled",
      enabled: true,
      severity: "High",
      tactics: ["InitialAccess"],
      template: RULE_A.properties.alertRuleTemplateName,
      modified: "2026-09-30T13:15:30Z",
    });
    expect(result.description as string).toContain("truncated");
    expect(result.query as string).toContain("SigninLogs");
    expect(result.query as string).toContain("truncated");
    expect(result.help).toEqual([expect.stringContaining("--full")]);
    await expect(run(["alert-rule", "show", "--ids", RULE_A.id!]))
      .resolves.toMatchObject({ name: RULE_A.name, workspace: "logs-demo" });
    const full = await run(["alert-rule", "show", "--name", RULE_A.name!, ...SELECTORS, "--full"]);
    expect(full.description).toBe(RULE_A.properties.description);
    expect(full.query).toBe(RULE_A.properties.query);
    expect(full).not.toHaveProperty("help");
    const options = requestMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(options["method"]).toBe("GET");
    expect(options["apiVersion"]).toBe("2025-09-01");
  });

  it("shows a queryless rule without a query key", async () => {
    const result = await run(["alert-rule", "show", "--name", RULE_B.name!, ...SELECTORS]);
    expect(result).toMatchObject({ kind: "MicrosoftSecurityIncidentCreation", enabled: false, severity: "" });
    expect(result).not.toHaveProperty("query");
    expect(result).not.toHaveProperty("help");
  });

  it("refuses bad identities before any rule transport", async () => {
    await expect(run(["alert-rule", "show", "--name", RULE_A.name!]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("workspace") });
    await expect(run(["alert-rule", "show", "--name", RULE_A.name!, ...SELECTORS, "--ids", RULE_A.id!]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("not both") });
    await expect(run(["alert-rule", "show", "--ids", `${RULE_A.id!}/extra`]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("--ids must be one alert-rule ARM ID") });
    await expect(run(["alert-rule", "show", "--name", "a/b", ...SELECTORS]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("one resource path segment") });
    await expect(run(["alert-rule", "show", "--name", "missing", ...SELECTORS]))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    allMock.mockClear();
    requestMock.mockClear();
    await expect(run(["alert-rule", "show", "--name", RULE_A.name!])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe("sentinel data-connector list", () => {
  it("lists compact connector rows with data-type states and never prints credential fields", async () => {
    const result = await run(["data-connector", "list", ...SELECTORS]);
    expect(result).toMatchObject({
      profile: "ci",
      workspace: "logs-demo",
      total: 2,
      count: "2 data connectors",
      byKind: { AzureActiveDirectory: 1, Office365: 1 },
      rows: [
        { name: CONNECTOR_A.name, kind: "AzureActiveDirectory", types: "alerts:Connected" },
        { name: CONNECTOR_B.name, kind: "Office365", types: "exchange:Connected, sharePoint:Disconnected" },
      ],
    });
    expect(result.help).toEqual([expect.stringContaining(`sentinel data-connector show --name ${CONNECTOR_A.name}`)]);
    expect(JSON.stringify(result)).not.toContain("never-output-this-value");
    const options = allMock.mock.calls.map((call) => call[1] as Record<string, unknown>);
    expect(options.find((call) => String(call["path"] ?? "").endsWith("/dataConnectors"))?.["apiVersion"]).toBe("2025-09-01");
  });

  it("filters by kind and reports an explicit empty state", async () => {
    await expect(run(["data-connector", "list", ...SELECTORS, "--kind", "office365"]))
      .resolves.toMatchObject({ total: 1 });
    mockTransport({ connectors: [] });
    const result = await run(["data-connector", "list", ...SELECTORS]);
    expect(result).toMatchObject({
      total: 0,
      count: "0 data connectors",
      rows: expect.stringContaining("0 data connectors found in workspace logs-demo"),
    });
  });

  it("shows full safe metadata rows, selected fields and capped pages", async () => {
    const full = await run(["data-connector", "list", ...SELECTORS, "--full"]);
    expect((full.rows as Array<Record<string, unknown>>)[0]).toMatchObject(
      { name: CONNECTOR_A.name, id: CONNECTOR_A.id, tenant: CONNECTOR_A.properties.tenantId });
    expect(JSON.stringify(full)).not.toContain("never-output-this-value");
    const fields = await run(["data-connector", "list", ...SELECTORS, "--fields", "name,kind"]);
    expect(fields.rows).toEqual([
      { name: CONNECTOR_A.name, kind: "AzureActiveDirectory" },
      { name: CONNECTOR_B.name, kind: "Office365" },
    ]);
    const capped = await run(["data-connector", "list", ...SELECTORS, "--limit", "1"]);
    expect(capped).toMatchObject({ total: 2, count: "1 of 2 data connectors" });
    await expect(run(["data-connector", "list", ...SELECTORS, "--fields", "password"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("--fields supports only") });
  });

  it("refuses bad selectors before any connector transport", async () => {
    await expect(run(["data-connector", "list"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["data-connector", "list", ...SELECTORS, "--ids", CONNECTOR_A.id!]))
      .rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
    allMock.mockClear();
    requestMock.mockClear();
    await expect(run(["data-connector", "list"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(allMock).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe("sentinel data-connector show", () => {
  it("shows safelisted metadata by name and ARM ID without credential fields", async () => {
    const result = await run(["data-connector", "show", "--name", CONNECTOR_B.name!, ...SELECTORS]);
    expect(result).toEqual({
      profile: "ci",
      workspace: "logs-demo",
      name: CONNECTOR_B.name,
      id: CONNECTOR_B.id,
      kind: "Office365",
      types: "exchange:Connected, sharePoint:Disconnected",
      tenant: CONNECTOR_B.properties.tenantId,
      subscriptionId: "",
      modified: "2026-09-29T10:00:00Z",
      subscription: SUB_A,
    });
    expect(JSON.stringify(result)).not.toContain("never-output-this-value");
    await expect(run(["data-connector", "show", "--ids", CONNECTOR_A.id!]))
      .resolves.toMatchObject({ name: CONNECTOR_A.name, tenant: CONNECTOR_A.properties.tenantId });
    expect(sentinelDataConnectorDetail).toMatchObject({ name: CONNECTOR_A.name });
  });

  it("refuses bad identities before any connector transport", async () => {
    await expect(run(["data-connector", "show", "--name", CONNECTOR_A.name!]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["data-connector", "show", "--name", CONNECTOR_A.name!, ...SELECTORS, "--ids", CONNECTOR_A.id!]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("not both") });
    await expect(run(["data-connector", "show", "--ids", `${CONNECTOR_A.id!}/keys`]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("--ids must be one data-connector ARM ID") });
    await expect(run(["data-connector", "show", "--name", "missing", ...SELECTORS]))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("sentinel rule and connector verbs stay read-only", () => {
  it("rejects unknown verbs and rule mutation shapes without transport", async () => {
    await expect(run(["alert-rule", "update", ...SELECTORS]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("unknown command") });
    await expect(run(["data-connector", "create", ...SELECTORS]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("unknown command") });
    await expect(run(["alert-rule"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("missing verb") });
    expect(allMock).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("surfaces access-denied failures without masking them as empty", async () => {
    requestMock.mockRejectedValueOnce(new AxiError("access denied: Denied", "FORBIDDEN", []));
    await expect(run(["alert-rule", "show", "--name", RULE_A.name!, ...SELECTORS]))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
