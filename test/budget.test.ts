// Token budgets per command (PLAN.md Sections 8 and 10.4 step 6).
//
// Each scenario drives a command handler with the shared synthetic payloads in
// test/samples.ts, normalizes machine-dependent paths, renders the result to
// TOON, and counts tokens with gpt-tokenizer (the counter PLAN.md Sections 4.4 and 13.4
// name; already a devDependency, so no new dependency).
//
// Ceiling rule: measured TOON token size plus 20 percent, rounded up. When a
// command's output shape changes, re-measure, update the ceiling, and justify
// any increase in the PR description.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encode as encodeToon } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import { encode as encodeTokens } from "gpt-tokenizer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/lib/client.js")>(),
  sendRequest: vi.fn(),
  requestAll: vi.fn(),
  request: vi.fn(),
  requestStorageMetadata: vi.fn(),
  requestKeyVaultMetadata: vi.fn(),
  requestAcrMetadata: vi.fn(),
}));
vi.mock("../src/lib/auth.js", () => ({ runAz: vi.fn(), identityOf: vi.fn(), resolveCredential: vi.fn() }));
vi.mock("../src/lib/stdin.js", () => ({ readStdinIfPiped: vi.fn() }));

import { run as runHome } from "../src/commands/home.js";
import { run as runDoctor } from "../src/commands/doctor.js";
import { run as runConfig } from "../src/commands/config.js";
import { run as runSub } from "../src/commands/sub.js";
import { run as runAccount } from "../src/commands/account.js";
import { run as runMonitor } from "../src/commands/monitor.js";
import { run as runGroup } from "../src/commands/group.js";
import { run as runResource } from "../src/commands/resource.js";
import { run as runStorage } from "../src/commands/storage.js";
import { run as runKeyvault } from "../src/commands/keyvault.js";
import { run as runAcr } from "../src/commands/acr.js";
import { run as runNetwork } from "../src/commands/network.js";
import { runDisk, runVm, runVmss } from "../src/commands/compute.js";
import { run as runPolicy } from "../src/commands/policy.js";
import { run as runLock } from "../src/commands/lock.js";
import { run as runDeny } from "../src/commands/denyAssignment.js";
import { run as runRole } from "../src/commands/role.js";
import { run as runRg } from "../src/commands/rg.js";
import { run as runRbac } from "../src/commands/rbac.js";
import { run as runActivity } from "../src/commands/activity.js";
import { run as runDefender } from "../src/commands/defender.js";
import { run as runExposure } from "../src/commands/exposure.js";
import { run as runLogs } from "../src/commands/logs.js";
import { run as runApi } from "../src/commands/api.js";
import { run as runSecurity } from "../src/commands/security.js";
import { run as runSentinel } from "../src/commands/sentinel.js";
import { run as runTag } from "../src/commands/tag.js";
import { run as runPassthrough } from "../src/commands/az.js";
import { identityOf, resolveCredential, runAz } from "../src/lib/auth.js";
import { request, requestAll, sendRequest } from "../src/lib/client.js";
import { collapseHomeDirectory } from "../src/lib/paths.js";
import {
  DEFENDER_ACTIVE_ALERT_COUNTS,
  EXPOSURE_ANY_ANY,
  EXPOSURE_MGMT_PORTS,
  EXPOSURE_PUBLIC_IPS,
} from "../src/lib/queries.js";
import { clearSubscriptionCache } from "../src/lib/scope.js";
import { routeArgv } from "../src/lib/router.js";
import { offlineWritePreviews, offlinePassthroughReads, offlineStorageReads, offlineKeyvaultReads, offlineAcrReads } from "../benchmark/scenarios.mjs";
import {
  SUB_A,
  defenderPricing,
  denyAssignment,
  managementLock,
  policyAssignment,
  policyDefinition,
  policySetDefinition,
  policyStateEnvelope,
  policyStates,
  roleDefinition,
  securitySubAssessment,
  sentinelIncidentAlerts,
  sentinelIncidentDetail,
  sentinelIncidentEntities,
  sentinelIncidents,
  sentinelAlertRuleDetail,
  sentinelAlertRules,
  sentinelDataConnectorDetail,
  sentinelDataConnectors,
  acrMetadataRows,
  computeDisk, computeInstanceView, computeVm, computeVmExpanded, computeVmss,
  networkDnsRecordSets,
  networkDnsZone,
  networkNic,
  networkNsg,
  networkPrivateEndpoint,
  networkPublicIp,
  networkVnet,
  storageMetadataRows,
  keyvaultMetadataRows,
  TENANT,
  azResourceGroup,
  discoveryGroup,
  discoveryResource,
  discoveryWorkspace,
  discoveryAccount,
  WORKSPACE,
  activityEvents,
  apiListResponse,
  apiWriteState,
  apiWriteBody,
  configListProfiles,
  defenderAlertDetail,
  defenderAlertUpdateState,
  tagUpdateState,
  defenderAlerts,
  defenderAssessments,
  defenderScores,
  exposureAnyAny,
  exposureMgmtPorts,
  exposurePublicIps,
  graphNames,
  homeAlertCounts,
  logsResponse,
  monitorActionGroup,
  monitorAlertRule,
  monitorDiagnosticSetting,
  monitorMetricDefinition,
  monitorMetricValues,
  monitorResource,
  rbacAssignments,
  resourceGraphPage,
  sampleIdentity,
  subscriptionList,
} from "./samples.js";

const sendMock = vi.mocked(sendRequest);
const allMock = vi.mocked(requestAll);
const identityMock = vi.mocked(identityOf);
const credentialMock = vi.mocked(resolveCredential);
const runAzMock = vi.mocked(runAz);

const ok = (body: unknown) => ({ status: 200, headers: {}, body, clientRequestId: "r" }) as never;

// Measured TOON tokens plus 20 percent, rounded up. Re-measure with a failing
// run (the assertion prints the actual size) after any output shape change.
const CEILINGS: Record<string, number> = {
  home: 256,
  doctor: 132,
  "config list": 146,
  "sub list": 136,
  "account list": 108,
  "account show": 72,
  "monitor log-analytics workspace list": 165,
  "monitor log-analytics workspace show": 96,
  "monitor metrics alert list": 179,
  "monitor metrics alert show": 212,
  "monitor action-group list": 173,
  "monitor action-group show": 176,
  "monitor diagnostic-settings list": 172,
  "monitor diagnostic-settings show": 360,
  // 226 measured tokens: labeled aggregations and a hint preserving the metric window.
  "monitor metrics list": 272,
  "group list": 111,
  "group show": 69,
  "resource list": 122,
  "resource show": 84,
  "rg query": 204,
  "rbac list": 150,
  "activity list": 201,
  "defender alerts": 194,
  "defender alerts get": 112,
  "security alert update": 179,
  "defender assessments": 117,
  "defender score": 86,
  "sentinel incident list": 220,
  "sentinel incident show": 226,
  "sentinel incident list-alert": 278,
  "sentinel incident list-entity": 221,
  "sentinel incident update": 797,
  "sentinel incident comment create": 288,
  "tag update": 227,
  "sentinel alert-rule list": 244,
  "sentinel alert-rule show": 442,
  "sentinel data-connector list": 218,
  "sentinel data-connector show": 204,
  exposure: 298,
  "logs query": 184,
  api: 135,
  "api execute": 140,
  "az group show": 60,
  "storage container list": 93,
  "storage container show": 59,
  "storage blob list": 110,
  "storage blob show": 68,
  "keyvault secret list": 100,
  "keyvault key list": 95,
  "keyvault certificate list": 95,
  "acr repository list": 56,
  "acr repository show-tags": 172,
  "acr manifest show-metadata": 269,
  "network nsg list": 161,
  "network nsg show": 236,
  "network nsg rule create": 384,
  "network nic list": 170,
  "network nic show": 176,
  "network vnet list": 177,
  "network vnet show": 208,
  "network public-ip list": 174,
  "network public-ip show": 149,
  "network private-endpoint list": 162,
  "network private-endpoint show": 160,
  "network dns zone list": 154,
  "network dns zone show": 126,
  "network dns record-set list": 144,
  "network dns record-set a show": 117,
  "vm list": 162,
  "vm show": 266,
  "vm get-instance-view": 218,
  "vmss list": 179,
  "vmss show": 135,
  "disk list": 160,
  "disk show": 129,
  "policy assignment list": 138,
  "policy assignment show": 221,
  "policy definition list": 159,
  "policy definition show": 222,
  "policy set-definition list": 167,
  "policy set-definition show": 280,
  "policy state list": 143,
  "lock list": 135,
  "lock show": 143,
  "deny-assignment list": 152,
  "deny-assignment show": 255,
  "role definition list": 191,
  "role definition show": 292,
  "security pricing list": 123,
  "security pricing show": 184,
  "security sub-assessment list": 244,
  "security sub-assessment show": 543,
};

function tokensOf(result: Record<string, unknown>): number {
  // Machine-dependent paths must not consume the output-shape allowance.
  const normalized = {
    ...result,
    ...(typeof result.bin === "string" ? { bin: "az-axi" } : {}),
    ...(typeof result.config === "string"
      ? { config: result.config.replace(collapseHomeDirectory(process.env.AZ_AXI_CONFIG!), "/config.json") }
      : {}),
    ...(typeof result.writeLog === "string" ? { writeLog: "/writes.log" } : {}),
  };
  return encodeTokens(encodeToon(normalized)).length;
}

async function expectUnderBudget(key: string, result: Record<string, unknown>): Promise<void> {
  const tokens = tokensOf(result);
  expect(tokens, `${key}: ${tokens} tokens exceeds ceiling ${CEILINGS[key]}`).toBeLessThanOrEqual(CEILINGS[key] ?? 0);
}

let dir: string;
const ENV_KEYS = ["AZ_AXI_CONFIG", "AZ_AXI_PROFILE", "AZ_AXI_SUBSCRIPTION", "AZ_AXI_TENANT", "AZ_AXI_READ_ONLY", "AZ_AXI_WRITE_LOG"];
let saved: Record<string, string | undefined>;

const subItems = () =>
  subscriptionList.map((s) => ({ subscriptionId: s.subscriptionId, displayName: s.displayName }));

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected network request in token budgets"); }));
  dir = mkdtempSync(join(tmpdir(), "az-axi-budget-"));
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AZ_AXI_CONFIG = join(dir, "config.json");
  process.env.AZ_AXI_WRITE_LOG = join(dir, "writes.log");
  clearSubscriptionCache();
  sendMock.mockReset();
  allMock.mockReset();
  vi.mocked(request).mockReset();
  identityMock.mockReset();
  credentialMock.mockReset();
  runAzMock.mockReset();
  identityMock.mockResolvedValue({ ...sampleIdentity, type: "user" } as never);
  credentialMock.mockResolvedValue({ header: "Bearer x", mode: "az" } as never);
  runAzMock.mockResolvedValue("{}" as never);
  allMock.mockResolvedValue({ items: subItems() } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
  clearSubscriptionCache();
});

describe("token budgets", () => {
  it.each(offlineStorageReads)("$name stays under its metadata ceiling", async ({ argv }) => {
    const { requestStorageMetadata } = await import("../src/lib/client.js");
    const kind = argv[1] as "container" | "blob";
    vi.mocked(requestStorageMetadata).mockResolvedValue({ rows: [storageMetadataRows[kind]] });
    const { argv: routed } = routeArgv(argv);
    await expectUnderBudget(argv.slice(0, 3).join(" "), await runStorage(routed.slice(1)));
  });
  it.each(offlineKeyvaultReads)("$name stays under its metadata ceiling", async ({ argv }) => {
    const { requestKeyVaultMetadata } = await import("../src/lib/client.js");
    const kind = argv[1] as "secret" | "key" | "certificate";
    vi.mocked(requestKeyVaultMetadata).mockResolvedValue({ rows: [keyvaultMetadataRows[kind]], truncated: false });
    const { argv: routed } = routeArgv(argv);
    await expectUnderBudget(argv.slice(0, 3).join(" "), await runKeyvault(routed.slice(1)));
  });
  it.each(offlineAcrReads)("$name stays under its metadata ceiling", async ({ argv, kind }) => {
    const { requestAcrMetadata } = await import("../src/lib/client.js");
    vi.mocked(requestAcrMetadata).mockResolvedValue({ rows: [acrMetadataRows[kind as keyof typeof acrMetadataRows]] });
    const { argv: routed } = routeArgv(argv);
    await expectUnderBudget(argv.slice(0, 3).join(" "), await runAcr(routed.slice(1)));
  });
  it("security alert update preview stays under its ceiling", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: {
      writer: { auth: "token", allowWrites: true, subscriptions: [SUB_A] },
    } }));
    sendMock.mockResolvedValue(ok(defenderAlertUpdateState));
    const { argv } = routeArgv([...offlineWritePreviews[0]!.argv, "--subscription", SUB_A]);
    await expectUnderBudget("security alert update", await runSecurity(argv.slice(1)));
  });
  it("reviewed group show stays under its ceiling", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ defaultProfile: "work", profiles: { work: { auth: "az", tenant: TENANT, subscriptions: [SUB_A] } } }));
    runAzMock
      .mockResolvedValueOnce(JSON.stringify({ "azure-cli": "2.90.0", "azure-cli-core": "2.90.0", extensions: {} }))
      .mockResolvedValueOnce(JSON.stringify({ name: "AzureCloud", profile: "latest", endpoints: { resourceManager: "https://management.azure.com/" } }))
      .mockResolvedValueOnce(JSON.stringify({ id: SUB_A, tenantId: TENANT, environmentName: "AzureCloud", state: "Enabled", user: { name: "ada@contoso.com", type: "user" } }))
      .mockResolvedValueOnce(JSON.stringify(azResourceGroup));
    await expectUnderBudget("az group show", await runPassthrough([...offlinePassthroughReads[0]!.argv.slice(1), "--subscription", SUB_A]));
  });
  it.each([
    { key: "group list", run: runGroup, sample: discoveryGroup, argv: ["list"] },
    { key: "account list", run: runAccount, sample: discoveryAccount, argv: ["list"] },
    { key: "account show", run: runAccount, sample: discoveryAccount, argv: ["show"] },
    { key: "monitor log-analytics workspace list", run: runMonitor, sample: discoveryWorkspace, argv: ["log-analytics", "workspace", "list"] },
    { key: "monitor log-analytics workspace show", run: runMonitor, sample: discoveryWorkspace, argv: ["log-analytics", "workspace", "show", "--ids", discoveryWorkspace.id] },
    { key: "monitor metrics alert list", run: runMonitor, sample: monitorAlertRule, argv: ["metrics", "alert", "list"] },
    { key: "monitor metrics alert show", run: runMonitor, sample: monitorAlertRule, argv: ["metrics", "alert", "show", "--name", "high-cpu", "--resource-group", "rg-demo"] },
    { key: "monitor action-group list", run: runMonitor, sample: monitorActionGroup, argv: ["action-group", "list"] },
    { key: "monitor action-group show", run: runMonitor, sample: monitorActionGroup, argv: ["action-group", "show", "--name", "ag-demo", "--resource-group", "rg-demo"] },
    { key: "monitor diagnostic-settings list", run: runMonitor, sample: monitorDiagnosticSetting, argv: ["diagnostic-settings", "list", "--resource", monitorResource] },
    { key: "monitor diagnostic-settings show", run: runMonitor, sample: monitorDiagnosticSetting, argv: ["diagnostic-settings", "show", "--ids", monitorDiagnosticSetting.id] },
    { key: "monitor metrics list", run: runMonitor, sample: monitorMetricDefinition, argv: ["metrics", "list", "--resource", monitorResource, "--start-time", "2026-10-04T00:00:00Z", "--end-time", "2026-10-04T01:00:00Z"] },
    { key: "monitor metrics list", run: runMonitor, sample: monitorMetricValues, argv: ["metrics", "list", "--resource", monitorResource, "--metric", "Percentage CPU", "--start-time", "2026-10-04T00:00:00Z", "--end-time", "2026-10-04T01:00:00Z"] },
    { key: "group show", run: runGroup, sample: discoveryGroup, argv: ["show", "--name", "rg-demo"] },
    { key: "resource list", run: runResource, sample: discoveryResource, argv: ["list"] },
    { key: "resource show", run: runResource, sample: discoveryResource, argv: ["show", "--ids", discoveryResource.id, "--api-version", "2025-01-01"] },
    { key: "network nsg list", run: runNetwork, sample: networkNsg, argv: ["nsg", "list"] },
    { key: "network nsg show", run: runNetwork, sample: networkNsg, argv: ["nsg", "show", "--name", "nsg-web", "--resource-group", "rg-demo"] },
    { key: "network nic list", run: runNetwork, sample: networkNic, argv: ["nic", "list"] },
    { key: "network nic show", run: runNetwork, sample: networkNic, argv: ["nic", "show", "--name", "nic-demo", "--resource-group", "rg-demo"] },
    { key: "network vnet list", run: runNetwork, sample: networkVnet, argv: ["vnet", "list"] },
    { key: "network vnet show", run: runNetwork, sample: networkVnet, argv: ["vnet", "show", "--name", "vnet-demo", "--resource-group", "rg-demo"] },
    { key: "network public-ip list", run: runNetwork, sample: networkPublicIp, argv: ["public-ip", "list"] },
    { key: "network public-ip show", run: runNetwork, sample: networkPublicIp, argv: ["public-ip", "show", "--name", "pip-demo", "--resource-group", "rg-demo"] },
    { key: "network private-endpoint list", run: runNetwork, sample: networkPrivateEndpoint, argv: ["private-endpoint", "list"] },
    { key: "network private-endpoint show", run: runNetwork, sample: networkPrivateEndpoint, argv: ["private-endpoint", "show", "--name", "pe-storage", "--resource-group", "rg-demo"] },
    { key: "network dns zone list", run: runNetwork, sample: networkDnsZone, argv: ["dns", "zone", "list"] },
    { key: "network dns zone show", run: runNetwork, sample: networkDnsZone, argv: ["dns", "zone", "show", "--name", "example.com", "--resource-group", "rg-demo"] },
    { key: "network dns record-set list", run: runNetwork, sample: networkDnsRecordSets[0], argv: ["dns", "record-set", "list", "--zone-name", "example.com", "--resource-group", "rg-demo"] },
    { key: "network dns record-set a show", run: runNetwork, sample: networkDnsRecordSets[0], argv: ["dns", "record-set", "a", "show", "--zone-name", "example.com", "--resource-group", "rg-demo", "--name", "www"] },
    { key: "vm list", run: runVm, sample: computeVm, argv: ["list"] },
    { key: "vm show", run: runVm, sample: computeVmExpanded, argv: ["show", "--name", "vm-demo", "--resource-group", "rg-demo"] },
    { key: "vm get-instance-view", run: runVm, sample: computeInstanceView, argv: ["get-instance-view", "--name", "vm-demo", "--resource-group", "rg-demo"] },
    { key: "vmss list", run: runVmss, sample: computeVmss, argv: ["list"] },
    { key: "vmss show", run: runVmss, sample: computeVmss, argv: ["show", "--name", "vmss-demo", "--resource-group", "rg-demo"] },
    { key: "disk list", run: runDisk, sample: computeDisk, argv: ["list"] },
    { key: "disk show", run: runDisk, sample: computeDisk, argv: ["show", "--name", "disk-demo", "--resource-group", "rg-demo"] },
    { key: "policy assignment list", run: runPolicy, sample: policyAssignment, argv: ["assignment", "list"] },
    { key: "policy assignment show", run: runPolicy, sample: policyAssignment, argv: ["assignment", "show", "--name", "CostManagement"] },
    { key: "policy definition list", run: runPolicy, sample: policyDefinition, argv: ["definition", "list"] },
    { key: "policy definition show", run: runPolicy, sample: policyDefinition, argv: ["definition", "show", "--name", "ResourceNaming"] },
    { key: "policy set-definition list", run: runPolicy, sample: policySetDefinition, argv: ["set-definition", "list"] },
    { key: "policy set-definition show", run: runPolicy, sample: policySetDefinition, argv: ["set-definition", "show", "--ids", policySetDefinition.id] },
    { key: "policy state list", run: runPolicy, sample: policyStateEnvelope([policyStates[0]], 1, null), argv: ["state", "list"] },
    { key: "lock list", run: runLock, sample: managementLock, argv: ["list"] },
    { key: "lock show", run: runLock, sample: managementLock, argv: ["show", "--name", "sub-lock"] },
    { key: "deny-assignment list", run: runDeny, sample: denyAssignment, argv: ["list"] },
    { key: "deny-assignment show", run: runDeny, sample: denyAssignment, argv: ["show", "--name", "deny-example", "--resource-group", "rg-demo"] },
    { key: "role definition list", run: runRole, sample: roleDefinition, argv: ["definition", "list"] },
    { key: "role definition show", run: runRole, sample: roleDefinition, argv: ["definition", "show", "--name", "00000000-0000-0000-0000-000000000040"] },
    { key: "security pricing list", run: runSecurity, sample: defenderPricing, argv: ["pricing", "list"] },
    { key: "security pricing show", run: runSecurity, sample: defenderPricing, argv: ["pricing", "show", "--name", "VirtualMachines"] },
    { key: "security sub-assessment list", run: runSecurity, sample: securitySubAssessment, argv: ["sub-assessment", "list"] },
    { key: "security sub-assessment show", run: runSecurity, sample: securitySubAssessment, argv: ["sub-assessment", "show", "--ids", securitySubAssessment.id] },
  ])("$key stays under its ceiling", async ({ key, run, sample, argv }) => {
    allMock.mockResolvedValue({ items: [sample] } as never);
    vi.mocked(request).mockResolvedValue(sample);
    await expectUnderBudget(key, await run([...argv, "--subscription", SUB_A]));
  });
  it("home stays under its ceiling", async () => {
    sendMock.mockImplementation(async (_profile: unknown, options: Record<string, unknown>) => {
      const query = String((options["body"] as { query?: string })?.query ?? "");
      if (query.includes("securescores")) return ok({ totalRecords: defenderScores.length, data: defenderScores });
      if (query === DEFENDER_ACTIVE_ALERT_COUNTS) {
        return ok({ totalRecords: homeAlertCounts.length, data: homeAlertCounts });
      }
      return ok({ totalRecords: 2 });
    });
    await expectUnderBudget("home", await runHome([]));
  });

  it("doctor stays under its ceiling", async () => {
    allMock.mockResolvedValue({ items: [{}, {}, {}] } as never);
    await expectUnderBudget("doctor", await runDoctor([]));
  });

  it("config list stays under its ceiling", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify(configListProfiles));
    await expectUnderBudget("config list", await runConfig(["list"]));
  });

  it("sub list stays under its ceiling", async () => {
    allMock.mockResolvedValue({ items: subscriptionList } as never);
    await expectUnderBudget("sub list", await runSub(["list"]));
  });

  it.each([
    ["rg", "query", "Resources | take 5"],
    ["graph", "query", "-q", "Resources | take 5"],
  ])("%j stays under the Resource Graph ceiling", async (...path) => {
    sendMock.mockResolvedValue(ok(resourceGraphPage));
    const { argv } = routeArgv(path);
    await expectUnderBudget("rg query", await runRg(argv.slice(1)));
  });

  it.each(["rbac list", "role assignment list"])("%s stays under the RBAC ceiling", async (path) => {
    sendMock.mockImplementation(async (_profile: unknown, options: Record<string, unknown>) =>
      options["resource"] === "graph"
        ? ok(graphNames)
        : ok({ totalRecords: rbacAssignments.length, count: rbacAssignments.length, data: rbacAssignments }),
    );
    const { argv } = routeArgv(path.split(" "));
    await expectUnderBudget("rbac list", await runRbac(argv.slice(1)));
  });

  it.each(["activity list", "monitor activity-log list"])("%s stays under the activity ceiling", async (path) => {
    sendMock.mockResolvedValue(ok({ value: activityEvents }));
    const { argv } = routeArgv([...path.split(" "), "--subscription", SUB_A, "--since", "24h"]);
    await expectUnderBudget("activity list", await runActivity(argv.slice(1)));
  });

  it.each(["defender alerts", "security alert list"])("%s stays under the alert ceiling", async (path) => {
    sendMock.mockImplementation(async (_profile: unknown, options: Record<string, unknown>) => {
      const path = String(options["path"] ?? "");
      if (!path.endsWith("/alerts") && /\/alerts\/[^/]+$/i.test(path)) return ok(defenderAlertDetail);
      return ok({ value: defenderAlerts });
    });
    const { argv } = routeArgv([...path.split(" "), "--subscription", SUB_A]);
    await expectUnderBudget("defender alerts", await runDefender(argv.slice(1)));
  });

  it("defender alerts get stays under its ceiling", async () => {
    sendMock.mockResolvedValue(ok(defenderAlertDetail));
    const id = `/subscriptions/${SUB_A}/providers/Microsoft.Security/locations/westeurope/alerts/alert-1`;
    await expectUnderBudget("defender alerts get", await runDefender(["alerts", "get", id]));
  });

  it("defender assessments stays under its ceiling", async () => {
    sendMock.mockResolvedValue(ok({ totalRecords: defenderAssessments.length, data: defenderAssessments }));
    await expectUnderBudget("defender assessments", await runDefender(["assessments"]));
  });

  it.each(["defender score", "security secure-scores list"])("%s stays under the score ceiling", async (path) => {
    sendMock.mockResolvedValue(ok({ totalRecords: defenderScores.length, data: defenderScores }));
    const { argv } = routeArgv(path.split(" "));
    await expectUnderBudget("defender score", await runDefender(argv.slice(1)));
  });

  it("sentinel incident list stays under its ceiling", async () => {
    allMock.mockImplementation(async (_profile: unknown, options: Record<string, unknown>) =>
      String(options["path"] ?? "") === "/subscriptions" ? { items: subItems() } : { items: sentinelIncidents });
    await expectUnderBudget("sentinel incident list", await runSentinel(["incident", "list",
      "--resource-group", "rg-demo", "--workspace-name", "logs-demo", "--subscription", SUB_A]));
  });

  it("sentinel incident show stays under its ceiling", async () => {
    vi.mocked(request).mockResolvedValue(sentinelIncidentDetail as never);
    await expectUnderBudget("sentinel incident show", await runSentinel(["incident", "show",
      "--name", sentinelIncidents[0]!.name as string,
      "--resource-group", "rg-demo", "--workspace-name", "logs-demo", "--subscription", SUB_A]));
  });

  it("sentinel incident list-alert stays under its ceiling", async () => {
    vi.mocked(request).mockResolvedValue({ value: sentinelIncidentAlerts } as never);
    await expectUnderBudget("sentinel incident list-alert", await runSentinel(["incident", "list-alert",
      "--name", sentinelIncidents[0]!.name as string,
      "--resource-group", "rg-demo", "--workspace-name", "logs-demo", "--subscription", SUB_A]));
  });

  it("sentinel incident list-entity stays under its ceiling", async () => {
    vi.mocked(request).mockResolvedValue(sentinelIncidentEntities as never);
    await expectUnderBudget("sentinel incident list-entity", await runSentinel(["incident", "list-entity",
      "--name", sentinelIncidents[0]!.name as string,
      "--resource-group", "rg-demo", "--workspace-name", "logs-demo", "--subscription", SUB_A]));
  });

  it("sentinel alert-rule list stays under its ceiling", async () => {
    allMock.mockImplementation(async (_profile: unknown, options: Record<string, unknown>) =>
      String(options["path"] ?? "") === "/subscriptions" ? { items: subItems() } : { items: sentinelAlertRules });
    await expectUnderBudget("sentinel alert-rule list", await runSentinel(["alert-rule", "list",
      "--resource-group", "rg-demo", "--workspace-name", "logs-demo", "--subscription", SUB_A]));
  });

  it("sentinel alert-rule show stays under its ceiling", async () => {
    vi.mocked(request).mockResolvedValue(sentinelAlertRuleDetail as never);
    await expectUnderBudget("sentinel alert-rule show", await runSentinel(["alert-rule", "show",
      "--name", sentinelAlertRules[0]!.name as string,
      "--resource-group", "rg-demo", "--workspace-name", "logs-demo", "--subscription", SUB_A]));
  });

  it("sentinel data-connector list stays under its ceiling", async () => {
    allMock.mockImplementation(async (_profile: unknown, options: Record<string, unknown>) =>
      String(options["path"] ?? "") === "/subscriptions" ? { items: subItems() } : { items: sentinelDataConnectors });
    await expectUnderBudget("sentinel data-connector list", await runSentinel(["data-connector", "list",
      "--resource-group", "rg-demo", "--workspace-name", "logs-demo", "--subscription", SUB_A]));
  });

  it("sentinel data-connector show stays under its ceiling", async () => {
    vi.mocked(request).mockResolvedValue(sentinelDataConnectorDetail as never);
    await expectUnderBudget("sentinel data-connector show", await runSentinel(["data-connector", "show",
      "--name", sentinelDataConnectors[0]!.name as string,
      "--resource-group", "rg-demo", "--workspace-name", "logs-demo", "--subscription", SUB_A]));
  });

  it("sentinel incident update preview stays under its ceiling", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: {
      writer: { auth: "token", allowWrites: true, subscriptions: [SUB_A] },
    } }));
    vi.mocked(request).mockResolvedValue(sentinelIncidentDetail as never);
    sendMock.mockResolvedValue(ok(sentinelIncidentDetail));
    const { argv } = routeArgv([...offlineWritePreviews[1]!.argv, "--subscription", SUB_A]);
    await expectUnderBudget("sentinel incident update", await runSentinel(argv.slice(1)));
  });

  it("tag update preview stays under its ceiling", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: {
      writer: { auth: "token", allowWrites: true, subscriptions: [SUB_A] },
    } }));
    sendMock.mockResolvedValue(ok(tagUpdateState));
    const { argv } = routeArgv([...offlineWritePreviews[3]!.argv, "--subscription", SUB_A]);
    await expectUnderBudget("tag update", await runTag(argv.slice(1)));
  });

  it("nsg deny-rule create preview stays under its ceiling", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: {
      writer: { auth: "token", allowWrites: true, subscriptions: [SUB_A] },
    } }));
    sendMock.mockResolvedValue(ok(networkNsg));
    const { argv } = routeArgv([...offlineWritePreviews[4]!.argv, "--subscription", SUB_A]);
    await expectUnderBudget("network nsg rule create", await runNetwork(argv.slice(1)));
  });

  it("sentinel incident comment create preview stays under its ceiling", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: {
      writer: { auth: "token", allowWrites: true, subscriptions: [SUB_A] },
    } }));
    sendMock.mockRejectedValue(new AxiError("not found", "NOT_FOUND", []));
    const { argv } = routeArgv([...offlineWritePreviews[2]!.argv, "--subscription", SUB_A]);
    await expectUnderBudget("sentinel incident comment create", await runSentinel(argv.slice(1)));
  });

  it("exposure stays under its ceiling", async () => {
    sendMock.mockImplementation(async (_profile: unknown, options: Record<string, unknown>) => {
      const query = String((options["body"] as { query?: string })?.query ?? "");
      const data =
        query === EXPOSURE_PUBLIC_IPS ? exposurePublicIps : query === EXPOSURE_MGMT_PORTS ? exposureMgmtPorts : exposureAnyAny;
      return ok({ totalRecords: data.length, data });
    });
    await expectUnderBudget("exposure", await runExposure([]));
  });

  it.each([
    ["logs", "query", "SigninLogs | take 5", "--workspace", WORKSPACE],
    ["monitor", "log-analytics", "query", "--analytics-query", "SigninLogs | take 5", "--workspace", WORKSPACE],
  ])("%j stays under the Log Analytics ceiling", async (...path) => {
    sendMock.mockResolvedValue(ok(logsResponse));
    const { argv } = routeArgv(path);
    await expectUnderBudget(
      "logs query",
      await runLogs(argv.slice(1)),
    );
  });

  it("api stays under its ceiling", async () => {
    sendMock.mockResolvedValue(ok(apiListResponse));
    await expectUnderBudget(
      "api",
      await runApi(["GET", "/subscriptions", "--api-version", "2022-12-01"]),
    );
  });

  it("api execute stays under its ceiling", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify(configListProfiles));
    sendMock.mockResolvedValueOnce(ok(apiWriteState)).mockResolvedValueOnce({
      ...ok({}), requestId: "req-write", correlationId: "corr-write",
    });
    const result = await runApi(["PATCH", `/subscriptions/${SUB_A}/resourceGroups/rg-demo`, "--api-version", "2021-04-01",
      "--profile", "sandbox", "--body", '{"tags":{"env":"prod"}}', "--execute"]);
    await expectUnderBudget("api execute", { ...result, durationSec: 1 });
  });

  it("api execute with a multiline body file stays under the existing ceiling", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify(configListProfiles));
    const bodyFile = join(dir, "body.json");
    writeFileSync(bodyFile, JSON.stringify(apiWriteBody, null, 2));
    sendMock.mockResolvedValueOnce(ok(apiWriteState)).mockResolvedValueOnce({
      ...ok({}), requestId: "req-write", correlationId: "corr-write",
    });
    const result = await runApi(["PATCH", `/subscriptions/${SUB_A}/resourceGroups/rg-demo`, "--api-version", "2021-04-01",
      "--profile", "sandbox", "--body-file", bodyFile, "--execute"]);
    await expectUnderBudget("api execute", { ...result, durationSec: 1 });
  });
});
