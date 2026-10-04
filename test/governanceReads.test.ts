import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ sendRequest: vi.fn(), request: vi.fn(), requestAll: vi.fn() }));

import { run as runPolicy } from "../src/commands/policy.js";
import { run as runLock } from "../src/commands/lock.js";
import { run as runDeny } from "../src/commands/denyAssignment.js";
import { request, requestAll } from "../src/lib/client.js";
import { shortDate } from "../src/lib/format.js";
import { clearSubscriptionCache } from "../src/lib/scope.js";
import { routeArgv } from "../src/lib/router.js";
import { quoteFlagValue } from "../src/lib/shell.js";
import {
  SUB_A, SUB_B, SYN,
  denyAssignment, denyAssignments,
  managementLock, managementLocks,
  policyAssignment, policyAssignments,
  policyDefinition, policyDefinitions,
  policySetDefinition, policySetDefinitions,
  policyStateEnvelope, policyStates,
} from "./samples.js";

const allMock = vi.mocked(requestAll);
const requestMock = vi.mocked(request);

let dir: string;
const ENV_KEYS = ["AZ_AXI_CONFIG", "AZ_AXI_PROFILE", "AZ_AXI_SUBSCRIPTION", "AZ_AXI_TENANT"];
let saved: Record<string, string | undefined>;

const SUBSCRIPTIONS = [
  { subscriptionId: SUB_A, displayName: "Sandbox" },
  { subscriptionId: SUB_B, displayName: "Lab" },
];

function collectionItems(path: string): unknown[] | undefined {
  if (path.endsWith("/policyAssignments")) return policyAssignments;
  if (path.endsWith("/policyDefinitions")) return policyDefinitions;
  if (path.endsWith("/policySetDefinitions")) return policySetDefinitions;
  if (path.endsWith("/locks")) return managementLocks;
  if (path.endsWith("/denyAssignments")) return denyAssignments;
  return undefined;
}

function mockTransport() {
  allMock.mockImplementation(async (_profile: unknown, requestOptions: Record<string, unknown>) => {
    const path = String(requestOptions["path"] ?? "");
    if (path === "/subscriptions") return { items: SUBSCRIPTIONS };
    const items = collectionItems(path);
    if (items) return { items };
    throw new Error(`unexpected offline path: ${path}`);
  });
  requestMock.mockImplementation(async (_profile: unknown, requestOptions: Record<string, unknown>) => {
    const path = String(requestOptions["path"] ?? "");
    if (path.includes("/queryResults")) {
      return policyStateEnvelope(policyStates, policyStates.length, null) as never;
    }
    const all = [...policyAssignments, ...policyDefinitions, ...policySetDefinitions,
      ...managementLocks, ...denyAssignments];
    const found = all.find((item) => item.id.toLowerCase() === path.toLowerCase());
    if (!found) throw new AxiError(`not found: ${path}`, "NOT_FOUND", []);
    return found as never;
  });
}

function useProfile(name = "ci", profile: Record<string, unknown> = { auth: "token", subscriptions: [SUB_A] }) {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { [name]: profile } }));
  process.env.AZ_AXI_PROFILE = name;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-governance-"));
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AZ_AXI_CONFIG = join(dir, "config.json");
  useProfile();
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

function listCalls(): Array<Record<string, unknown>> {
  return allMock.mock.calls.map((call) => call[1] as Record<string, unknown>);
}

describe("policy assignment list", () => {
  it("lists compact rows with enforcement aggregates and a definition hint", async () => {
    const result = await runPolicy(["assignment", "list", "--resource-group", "rg-demo"]);
    expect(result).toMatchObject({
      profile: "ci",
      total: 2,
      count: "2 policy assignments",
      byEnforcement: { Default: 1, DoNotEnforce: 1 },
      rows: [
        { name: "CostManagement", scope: SUB_A, definition: "ResourceNaming", enforcement: "Default" },
        { name: "TagEnforcement", scope: `${SUB_A}/rg-demo`, definition: SYN(42), enforcement: "DoNotEnforce" },
      ],
    });
    expect(result.help).toEqual([
      `Run \`az-axi policy definition show --ids /subscriptions/${SUB_A}/providers/Microsoft.Authorization/policyDefinitions/ResourceNaming\` for the assigned definition`,
    ]);
    const options = listCalls();
    const list = options.find((call) => String(call["path"] ?? "").endsWith("/policyAssignments"))!;
    expect(list["method"]).toBe("GET");
    expect(list["apiVersion"]).toBe("2021-06-01");
    expect(list["path"]).toBe(`/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Authorization/policyAssignments`);
    for (const path of options.map((call) => String(call["path"] ?? ""))) {
      expect(path).not.toContain("?");
    }
  });

  it("filters by exact name and caps pages with lower-bound disclosure", async () => {
    const filtered = await runPolicy(["assignment", "list", "--name", "CostManagement"]);
    expect(filtered).toMatchObject({ total: 1, count: "1 policy assignments" });
    const capped = await runPolicy(["assignment", "list", "--limit", "1"]);
    expect(capped).toMatchObject({ total: 2, count: "1 of 2 policy assignments" });
    expect(capped.help).toEqual(expect.arrayContaining([expect.stringContaining("--full")]));
    const full = await runPolicy(["assignment", "list", "--full"]);
    expect((full.rows as unknown[])).toHaveLength(2);
    expect(full.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ definition: `/subscriptions/${SUB_A}/providers/Microsoft.Authorization/policyDefinitions/ResourceNaming` }),
    ]));
    const fields = await runPolicy(["assignment", "list", "--fields", "name,enforcement"]);
    expect(fields.rows).toEqual([{ name: "CostManagement", enforcement: "Default" }, { name: "TagEnforcement", enforcement: "DoNotEnforce" }]);
  });

  it("reports an explicit empty state", async () => {
    const result = await runPolicy(["assignment", "list", "--name", "missing"]);
    expect(result).toMatchObject({
      total: 0, count: "0 policy assignments",
      rows: expect.stringContaining("0 policy assignments found in subscription"),
    });
  });
});

describe("policy assignment show", () => {
  it("includes explicitly selected metadata and excluded scopes without full output", async () => {
    requestMock.mockResolvedValueOnce({ ...policyAssignment, properties: {
      ...policyAssignment.properties,
      metadata: { owner: "team", adminPassword: "private-password" },
      notScopes: [`/subscriptions/${SUB_A}/resourceGroups/excluded`],
    } } as never);
    const result = await runPolicy(["assignment", "show", "--ids", policyAssignment.id, "--fields", "metadata,notScopes,definition"]);
    expect(result).toMatchObject({
      metadata: { owner: "team", adminPassword: "***redacted***" },
      notScopes: [`/subscriptions/${SUB_A}/resourceGroups/excluded`],
      definition: "ResourceNaming",
    });
  });

  it.each(["assignment", "definition", "set-definition"])("redacts %s nested secrets before compact and full serialization", async (kind) => {
    const item = { ...policyAssignment, properties: {
      ...policyAssignment.properties,
      parameters: {
        adminPassword: { type: "String", value: "private-password", defaultValue: "private-default", allowedValues: ["private-allowed"] },
        deploymentInput: { type: "secureString", defaultValue: "private-secure-default", allowedValues: ["private-secure-allowed"] },
        allowed: { value: "public-value", defaultValue: "public-default", allowedValues: ["public-allowed"] },
      },
      policyRule: { then: { effect: "deployIfNotExists", details: { deployment: { properties: {
        parameters: { clientSecret: { value: "private-credential" }, deploymentInput: { value: { field: "private-supplied-object" } } }, template: {
          parameters: { deploymentInput: { type: "secureObject", defaultValue: { field: "private-object" }, allowedValues: [{ field: "private-object-allowed" }] } },
        },
      } } } } },
      policyDefinitions: [{ policyDefinitionId: policyDefinition.id, parameters: {
        adminPassword: { value: "member-password", defaultValue: "private-member-default", allowedValues: ["private-member-allowed"] },
      } }],
    } };
    requestMock.mockResolvedValue(item as never);
    const compact = await runPolicy([kind, "show", "--name", "demo"]);
    const full = await runPolicy([kind, "show", "--name", "demo", "--full"]);
    expect(JSON.stringify(compact)).not.toMatch(/private-|member-password/);
    expect(JSON.stringify(full)).not.toMatch(/private-|member-password/);
    expect(full.parameters).toContain("public-value");
    expect(full.parameters).toContain("***redacted***");
    expect(JSON.parse(full.parameters as string)).toEqual({
      adminPassword: { type: "String", value: "***redacted***", defaultValue: "***redacted***", allowedValues: "***redacted***" },
      deploymentInput: { type: "secureString", defaultValue: "***redacted***", allowedValues: "***redacted***" },
      allowed: { value: "public-value", defaultValue: "public-default", allowedValues: ["public-allowed"] },
    });
    expect(item.properties.parameters.adminPassword.value).toBe("private-password");
  });

  it("shows parameters and messages by name at both scopes and by ARM ID", async () => {
    const sub = await runPolicy(["assignment", "show", "--name", "CostManagement"]);
    expect(sub).toMatchObject({
      profile: "ci", name: "CostManagement", id: policyAssignment.id,
      display: "Storage Cost Management", scope: `/subscriptions/${SUB_A}`,
      definition: "ResourceNaming", enforcement: "Default", subscription: SUB_A,
      nonComplianceMessages: ["Storage SKU is not approved"],
    });
    expect(sub.parameters).toContain("Standard_A1");
    const rg = await runPolicy(["assignment", "show", "--name", "TagEnforcement", "--resource-group", "rg-demo"]);
    expect(rg).toMatchObject({ name: "TagEnforcement", scope: `${discoveryGroupId()}`,
      definition: SYN(42), enforcement: "DoNotEnforce" });
    await expect(runPolicy(["assignment", "show", "--ids", policyAssignment.id]))
      .resolves.toMatchObject({ name: "CostManagement", enforcement: "Default" });
    const options = requestMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(options["method"]).toBe("GET");
    expect(options["apiVersion"]).toBe("2021-06-01");
  });

  it("expands parameters and metadata on request", async () => {
    const full = await runPolicy(["assignment", "show", "--name", "CostManagement", "--full"]);
    expect(full).toMatchObject({ notScopes: [], metadata: {} });
    expect(full).not.toHaveProperty("help");
  });

  function discoveryGroupId(): string {
    return `/subscriptions/${SUB_A}/resourceGroups/rg-demo`;
  }
});

describe("policy definition list and show", () => {
  it.each([
    { id: policyDefinition.id, version: "1.2.1" },
    { id: policyDefinitions[1]!.id, version: "1.0.0" },
  ])("reads metadata version $version in all show representations", async ({ id, version }) => {
    expect(await runPolicy(["definition", "show", "--ids", id])).toMatchObject({ version });
    expect(await runPolicy(["definition", "show", "--ids", id, "--full"])).toMatchObject({ version });
    expect(await runPolicy(["definition", "show", "--ids", id, "--fields", "version"])).toEqual({ profile: "ci", version });
  });

  it.each([
    { kind: "definition", builtin: policyDefinition, arm: "policyDefinitions", noun: "policy definitions" },
    { kind: "set-definition", builtin: policySetDefinition, arm: "policySetDefinitions", noun: "policy initiatives" },
  ])("deduplicates $kind built-ins across subscriptions before counting and limiting", async ({ kind, builtin, arm, noun }) => {
    useProfile("ci", { auth: "token", subscriptions: [SUB_A, SUB_B] });
    allMock.mockImplementation(async (_profile, options) => ({ items: [
      { ...builtin, id: options.path.includes(SUB_A) ? builtin.id : builtin.id.toUpperCase() },
      { ...builtin, id: `${options.path}/custom`, name: "custom", properties: { ...builtin.properties, policyType: "Custom" } },
    ] }));
    const result = await runPolicy([kind, "list", "--limit", "1"]);
    expect(result).toMatchObject({ total: 3, count: `1 of 3 ${noun}`, byType: { BuiltIn: 1, Custom: 2 } });
    const filtered = await runPolicy([kind, "list", "--name", builtin.name]);
    expect(filtered.total).toBe(1);
    expect(listCalls().map((call) => call.path)).toContain(`/subscriptions/${SUB_B}/providers/Microsoft.Authorization/${arm}`);
  });

  it("lists built-in and custom definitions with effects and categories", async () => {
    const result = await runPolicy(["definition", "list"]);
    expect(result).toMatchObject({
      profile: "ci",
      total: 2,
      count: "2 policy definitions",
      byType: { BuiltIn: 1, Custom: 1 },
      rows: [
        { name: SYN(42), display: "Allowed storage account SKUs",
          type: "BuiltIn", effect: "Deny", category: "Storage" },
        { name: "ResourceNaming", display: "Naming Convention",
          type: "Custom", effect: "deny", category: "Naming" },
      ],
    });
    const options = listCalls();
    const list = options.find((call) => String(call["path"] ?? "").endsWith("/policyDefinitions"))!;
    expect(list["method"]).toBe("GET");
    expect(list["apiVersion"]).toBe("2021-06-01");
  });

  it("shows a custom definition by name and a built-in by tenant ARM ID", async () => {
    const custom = await runPolicy(["definition", "show", "--name", "ResourceNaming"]);
    expect(custom).toMatchObject({
      name: "ResourceNaming", mode: "All", type: "Custom", effect: "deny",
      category: "Naming", version: "1.0.0", subscription: SUB_A,
    });
    expect(custom.rule).toContain("prefix");
    const builtin = await runPolicy(["definition", "show", "--ids", policyDefinition.id]);
    expect(builtin).toMatchObject({ name: policyDefinition.name, type: "BuiltIn", effect: "Deny" });
    expect(builtin).toHaveProperty("subscription", SUB_A);
    const full = await runPolicy(["definition", "show", "--ids", policyDefinition.id, "--full"]);
    expect(full.rule).toContain("Microsoft.Storage/storageAccounts");
    expect(full).not.toHaveProperty("help");
  });
});

describe("policy set-definition list and show", () => {
  it("lists initiatives with member counts and shows member references", async () => {
    const list = await runPolicy(["set-definition", "list"]);
    expect(list).toMatchObject({
      total: 1, count: "1 policy initiatives",
      byType: { BuiltIn: 1 },
      rows: [{ name: policySetDefinition.name, display: "Audit public network access",
        type: "BuiltIn", definitions: 2, category: "Network" }],
    });
    const options = listCalls();
    expect(options.find((call) => String(call["path"] ?? "").endsWith("/policySetDefinitions"))!["apiVersion"])
      .toBe("2021-06-01");
    const show = await runPolicy(["set-definition", "show", "--ids", policySetDefinition.id]);
    expect(show).toMatchObject({ name: policySetDefinition.name, type: "BuiltIn", category: "Network" });
    expect(show.definitions).toEqual([SYN(42), "ResourceNaming"]);
    const full = await runPolicy(["set-definition", "show", "--ids", policySetDefinition.id, "--full"]);
    expect(full.definitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ policyDefinitionReferenceId: "storageSkus" }),
    ]));
    expect(full).not.toHaveProperty("help");
  });
});

describe("policy state list", () => {
  it.each([{ scope: [] }, { scope: ["--resource-group", "rg-demo"] }])("finds states beyond the first hundred at scope $scope", async ({ scope }) => {
    const states = Array.from({ length: 150 }, (_, index) => ({
      ...policyStates[0], resourceId: `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Compute/virtualMachines/resource-${index}`,
    }));
    requestMock.mockImplementation(async (_profile, options) => ({ value: options.query?.$top ? states.slice(0, Number(options.query.$top)) : states }) as never);
    const all = await runPolicy(["state", "list", ...scope, "--limit", "1"]);
    expect(all).toMatchObject({ total: 150, count: "1 of 150 policy states", byCompliance: { NonCompliant: 150 } });
    const filtered = await runPolicy(["state", "list", ...scope, "--name", "resource-149"]);
    expect(filtered).toMatchObject({ total: 1, rows: [expect.objectContaining({ resource: "resource-149" })] });
  });

  it("stops service pagination at the page cap and reports lower bounds", async () => {
    requestMock.mockResolvedValue(policyStateEnvelope([policyStates[0]], 1,
      "https://management.azure.com/queryResults?$skiptoken=next-page") as never);
    expect(await runPolicy(["state", "list"])).toMatchObject({ total: "10+", count: "10 of 10+ policy states" });
    expect(requestMock).toHaveBeenCalledTimes(10);
  });

  it.each([
    { flags: [], total: "1+", count: "1 of 1+ policy states" },
    { flags: ["--compliance", "Compliant"], total: "0+", count: "0 of 0+ policy states" },
    { flags: ["--assignment", "missing"], total: "0+", count: "0 of 0+ policy states" },
    { flags: ["--name", "missing"], total: "0+", count: "0 of 0+ policy states" },
  ])("retains lower bounds when paging stops with filters $flags", async ({ flags, total, count }) => {
    requestMock.mockResolvedValueOnce(policyStateEnvelope([policyStates[0]], 1, "https://management.azure.com/next?page=2") as never);
    expect(await runPolicy(["state", "list", ...flags])).toMatchObject({ total, count });
  });

  it("counts states from every subscription even when a response has no page count", async () => {
    useProfile("ci", { auth: "token", subscriptions: [SUB_A, SUB_B] });
    requestMock.mockResolvedValueOnce(policyStateEnvelope([policyStates[0]], 1, null) as never);
    requestMock.mockResolvedValueOnce({ value: policyStates } as never);
    expect(await runPolicy(["state", "list"])).toMatchObject({ total: 3, byCompliance: { NonCompliant: 2, Compliant: 1 } });
  });

  it("queries latest states with a bodyless read POST and summarizes compliance", async () => {
    const result = await runPolicy(["state", "list"]);
    expect(result).toMatchObject({
      profile: "ci",
      total: 2,
      count: "2 policy states",
      byCompliance: { Compliant: 1, NonCompliant: 1 },
      rows: [
        { resource: "mysa1", assignment: "TagEnforcement", compliance: "Compliant",
          definition: "ResourceNaming", time: shortDate("2026-10-03T18:02:11Z") },
        { resource: "mypubip1", assignment: "CostManagement", compliance: "NonCompliant",
          definition: "storageSkus", time: shortDate("2026-10-03T17:48:05Z") },
      ],
    });
    expect(result.help).toEqual([
      `Run \`az-axi policy assignment show --ids /subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Authorization/policyAssignments/TagEnforcement\` for the assigned policy`,
    ]);
    const options = requestMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(options["method"]).toBe("POST");
    expect(options["apiVersion"]).toBe("2024-10-01");
    expect(String(options["path"] ?? "")).toBe(
      `/subscriptions/${SUB_A}/providers/Microsoft.PolicyInsights/policyStates/latest/queryResults`);
    expect(options["body"]).toBeUndefined();
    expect(options["query"]).toEqual({});
  });

  it("scopes to a resource group and filters by assignment, compliance and resource", async () => {
    const scoped = await runPolicy(["state", "list", "--resource-group", "rg-demo"]);
    expect(scoped).toMatchObject({ total: 2 });
    expect(String((requestMock.mock.calls[0]![1] as Record<string, unknown>)["path"] ?? ""))
      .toBe(`/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.PolicyInsights/policyStates/latest/queryResults`);
    await expect(runPolicy(["state", "list", "--assignment", "costmanagement"]))
      .resolves.toMatchObject({ total: 1, count: "1 policy states" });
    await expect(runPolicy(["state", "list", "--compliance", "noncompliant"]))
      .resolves.toMatchObject({ total: 1, rows: [expect.objectContaining({ compliance: "NonCompliant" })] });
    await expect(runPolicy(["state", "list", "--name", "mysa1"]))
      .resolves.toMatchObject({ total: 1, rows: [expect.objectContaining({ resource: "mysa1" })] });
    await expect(runPolicy(["state", "list", "--name", "missing"]))
      .resolves.toMatchObject({ total: 0, rows: expect.stringContaining("0 policy states found") });
  });

  it("follows skip tokens across pages and counts fetched states", async () => {
    requestMock.mockReset();
    mockPagedStates();
    const result = await runPolicy(["state", "list"]);
    expect(result).toMatchObject({ total: 3, count: "3 policy states" });
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect((requestMock.mock.calls[1]![1] as Record<string, unknown>)["query"]).toMatchObject({ $skiptoken: "token-2" });
  });

  it("discloses an unfollowable next link as a lower bound", async () => {
    requestMock.mockResolvedValueOnce(
      policyStateEnvelope([policyStates[0]], 2, "https://management.azure.com/next?page=2") as never);
    const result = await runPolicy(["state", "list"]);
    expect(result).toMatchObject({ total: "1+", count: "1 of 1+ policy states" });
    expect(result.help).toEqual(expect.arrayContaining([expect.stringContaining("lower bounds")]));
  });

  function mockPagedStates() {
    requestMock.mockImplementation(async (_profile: unknown, requestOptions: Record<string, unknown>) => {
      const query = (requestOptions["query"] ?? {}) as Record<string, unknown>;
      if (!query["$skiptoken"]) {
        return policyStateEnvelope(policyStates, 2,
          `https://management.azure.com/subscriptions/x/queryResults?$skiptoken=token-2`) as never;
      }
      return policyStateEnvelope([policyStates[1]], 1, null) as never;
    });
  }
});

describe("lock list and show", () => {
  it("lists locks with levels, scopes and a level aggregate", async () => {
    const result = await runLock(["list"]);
    expect(result).toMatchObject({
      profile: "ci",
      total: 2,
      count: "2 management locks",
      byLevel: { CanNotDelete: 1, ReadOnly: 1 },
      rows: [
        { name: "rg-lock", level: "ReadOnly", scope: `${SUB_A}/rg-demo` },
        { name: "sub-lock", level: "CanNotDelete", scope: SUB_A },
      ],
    });
    const options = listCalls();
    const list = options.find((call) => String(call["path"] ?? "").endsWith("/locks"))!;
    expect(list["method"]).toBe("GET");
    expect(list["apiVersion"]).toBe("2020-05-01");
  });

  it("shows notes and owners at subscription and resource-group scope", async () => {
    const sub = await runLock(["show", "--name", "sub-lock"]);
    expect(sub).toMatchObject({
      name: "sub-lock", level: "CanNotDelete", scope: `/subscriptions/${SUB_A}`,
      notes: "Protect the subscription from accidental deletion", subscription: SUB_A,
    });
    expect(sub.owners).toBe("00000000-0000-0000-0000-000000000030");
    const rg = await runLock(["show", "--name", "rg-lock", "--resource-group", "rg-demo"]);
    expect(rg).toMatchObject({ name: "rg-lock", level: "ReadOnly" });
    await expect(runLock(["show", "--ids", managementLock.id]))
      .resolves.toMatchObject({ name: "sub-lock" });
  });
});

describe("deny-assignment list and show", () => {
  it("lists denies with scopes, actions and a scope-kind aggregate", async () => {
    const result = await runDeny(["list"]);
    expect(result).toMatchObject({
      profile: "ci",
      total: 2,
      count: "2 deny assignments",
      byScopeKind: { subscription: 1, resourceGroup: 1 },
      rows: [
        { name: "deny-example", scope: `${SUB_A}/rg-demo`, actions: "Microsoft.Storage/storageAccounts/write", dataActions: "" },
        { name: "sub-deny", scope: SUB_A,
          actions: "*", dataActions: "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read" },
      ],
    });
    expect(result.help).toEqual([
      `Run \`az-axi deny-assignment show --ids ${denyAssignment.id}\` for the first row in detail`,
    ]);
    const options = listCalls();
    const list = options.find((call) => String(call["path"] ?? "").endsWith("/denyAssignments"))!;
    expect(list["method"]).toBe("GET");
    expect(list["apiVersion"]).toBe("2022-04-01");
  });

  it("shows permissions, principals and protection flags by ARM ID", async () => {
    const show = await runDeny(["show", "--ids", denyAssignment.id]);
    expect(show).toMatchObject({
      name: "deny-example", scope: `/subscriptions/${SUB_A}/resourceGroups/rg-demo`,
      description: "Deny assignment description", totalPrincipals: 1,
      doNotApplyToChildScopes: false, systemProtected: true, subscription: SUB_A,
    });
    expect(show.actions).toEqual(["Microsoft.Storage/storageAccounts/write"]);
    expect(show.principals).toEqual(["00000000-0000-0000-0000-000000000031"]);
    const sub = await runDeny(["show", "--name", "sub-deny"]);
    expect(sub).toMatchObject({ name: "sub-deny", doNotApplyToChildScopes: true });
    expect(sub.notActions).toEqual(["Microsoft.Resources/subscriptions/resourceGroups/read"]);
  });

  it.each([
    { mode: "compact", flags: [] },
    { mode: "full", flags: ["--full"] },
    { mode: "selected", flags: ["--fields", "actions,dataActions,notActions,notDataActions"] },
    { mode: "selected full", flags: ["--fields", "actions,dataActions,notActions,notDataActions", "--full"] },
  ])("keeps permission planes and exceptions separate in $mode detail", async ({ flags }) => {
    requestMock.mockResolvedValueOnce({
      ...denyAssignment,
      properties: { ...denyAssignment.properties, permissions: [{
        actions: ["Microsoft.Storage/storageAccounts/write"],
        dataActions: ["Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write"],
        notActions: ["Microsoft.Storage/storageAccounts/read"],
        notDataActions: ["Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read"],
      }] },
    } as never);
    expect(await runDeny(["show", "--ids", denyAssignment.id, ...flags])).toMatchObject({
      actions: ["Microsoft.Storage/storageAccounts/write"],
      dataActions: ["Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write"],
      notActions: ["Microsoft.Storage/storageAccounts/read"],
      notDataActions: ["Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read"],
    });
  });

  it("distinguishes control-plane and data-plane wildcards in full list output", async () => {
    allMock.mockResolvedValueOnce({ items: [
      { ...denyAssignment, name: "control-deny", properties: { ...denyAssignment.properties,
        permissions: [{ actions: ["*"], dataActions: [], notActions: [], notDataActions: [] }] } },
      { ...denyAssignment, id: denyAssignments[1]!.id, name: "data-deny", properties: { ...denyAssignment.properties,
        permissions: [{ actions: [], dataActions: ["*"], notActions: [], notDataActions: [] }] } },
    ] });
    expect(await runDeny(["list", "--full", "--fields", "name,actions,dataActions"])).toMatchObject({ rows: [
      { name: "control-deny", actions: "*", dataActions: "" },
      { name: "data-deny", actions: "", dataActions: "*" },
    ] });
  });

  it.each([
    { mode: "compact", flags: [], expected: [`${SYN(32)}, ${SYN(33)}`] },
    { mode: "full", flags: ["--full"], expected: [SYN(32), SYN(33)] },
    { mode: "selected", flags: ["--fields", "excludePrincipals"], expected: [`${SYN(32)}, ${SYN(33)}`] },
    { mode: "selected full", flags: ["--fields", "excludePrincipals", "--full"], expected: [SYN(32), SYN(33)] },
  ])("preserves excluded principals in $mode detail output", async ({ flags, expected }) => {
    requestMock.mockResolvedValueOnce({
      ...denyAssignment,
      properties: { ...denyAssignment.properties, excludePrincipals: [
        { id: SYN(32), type: "Group" }, { id: SYN(33), type: "User" },
      ] },
    } as never);
    const show = await runDeny(["show", "--ids", denyAssignment.id, ...flags]);
    expect(show.excludePrincipals).toEqual(expected);
  });

  it("shows empty principal exclusions by name", async () => {
    const show = await runDeny(["show", "--name", "sub-deny", "--fields", "excludePrincipals", "--full"]);
    expect(show.excludePrincipals).toEqual([]);
  });
});

describe("governance reads stay read-only and validate before transport", () => {
  describe.each([
    { scope: "another subscription", profile: { auth: "token", subscriptions: [SUB_B] }, subscription: SUB_A },
    { scope: "a management group", profile: { auth: "token", managementGroup: "root" }, subscription: SUB_A },
    { scope: "multiple selected subscriptions", profile: { auth: "token", subscriptions: [SUB_B] }, subscription: `${SUB_A},${SUB_B}` },
  ])("detail hints override a profile scoped to $scope", ({ profile, subscription }) => {
    it.each([
      { source: "assignment", target: "definition", arm: "policyDefinitions" },
      { source: "assignment", target: "set-definition", arm: "policySetDefinitions" },
      { source: "state", target: "assignment", arm: "policyAssignments" },
      { source: "definition", target: "definition", arm: "policyDefinitions" },
      { source: "set-definition", target: "set-definition", arm: "policySetDefinitions" },
    ])("preserves the explicit subscription in the $source to $target hint", async ({ source, target, arm }) => {
      useProfile("ci", profile);
      const id = `/subscriptions/${SUB_A}/providers/Microsoft.Authorization/${arm}/demo`;
      const item = { ...policyAssignment, id, properties: { ...policyAssignment.properties, policyDefinitionId: id } };
      allMock.mockResolvedValue({ items: [item] });
      requestMock.mockResolvedValue({ value: [{ ...policyStates[0], policyAssignmentId: id }] } as never);
      const routed = routeArgv(["policy", source, "list", "-s", subscription]);
      const result = await runPolicy(routed.argv.slice(1));
      const command = (result.help as string[])[0]!.split("`")[1]!;
      const argv = command.replace(/^az-axi /, "").split(" ");
      expect(argv).toEqual(["policy", target, "show", "--ids", id, "--subscription", subscription]);
      requestMock.mockResolvedValueOnce(item as never);
      await expect(runPolicy(argv.slice(1))).resolves.toMatchObject({ id, subscription: SUB_A });
    });
  });

  it.each([
    { source: "assignment", target: "set-definition", arm: "policySetDefinitions" },
    { source: "state", target: "assignment", arm: "policyAssignments" },
    { source: "definition", target: "definition", arm: "policyDefinitions" },
    { source: "set-definition", target: "set-definition", arm: "policySetDefinitions" },
  ])("emits a runnable quoted hint from $source to $target", async ({ source, target, arm }) => {
    const id = `/subscriptions/${SUB_A}/providers/Microsoft.Authorization/${arm}/Team's policy`;
    const item = { ...policyAssignment, id, properties: { ...policyAssignment.properties, policyDefinitionId: id } };
    allMock.mockResolvedValue({ items: [item] });
    requestMock.mockResolvedValue({ value: [{ ...policyStates[0], policyAssignmentId: id }] } as never);
    const result = await runPolicy([source, "list"]);
    const command = (result.help as string[])[0]!.split("`")[1]!;
    const script = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";
    const shell = spawnSync("sh", ["-c", command.replace(/^az-axi/, `${quoteFlagValue(process.execPath)} -e ${quoteFlagValue(script)}`)], { encoding: "utf8" });
    expect(shell.status, shell.stderr).toBe(0);
    const argv = JSON.parse(shell.stdout) as string[];
    expect(argv).toEqual(["policy", target, "show", "--ids", id]);
    requestMock.mockResolvedValueOnce(item as never);
    await expect(runPolicy(argv.slice(1))).resolves.toMatchObject({ id });
  });

  it("omits detail hints for inherited management-group assignments", async () => {
    requestMock.mockResolvedValueOnce({ value: [{ ...policyStates[0],
      policyAssignmentId: "/providers/Microsoft.Management/managementGroups/root/providers/Microsoft.Authorization/policyAssignments/inherited",
    }] } as never);
    expect(await runPolicy(["state", "list"])).toMatchObject({ help: [] });
  });

  it("rejects unknown verbs and leaves without transport", async () => {
    await expect(runPolicy(["assignment", "update"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(runPolicy(["state", "show"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(runPolicy(["definition", "delete"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(runPolicy(["exemption", "list"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(runLock(["delete"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(runLock([])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(runDeny(["create"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(runPolicy(["assignment"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(allMock).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("rejects bad selectors, flags and identities before transport", async () => {
    await expect(runPolicy(["assignment", "list", "--kind", "Basic"]))
      .rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
    await expect(runPolicy(["assignment", "show", "--name", "CostManagement", "--ids", policyAssignment.id]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("not both") });
    await expect(runPolicy(["assignment", "show"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("--name or --ids") });
    await expect(runPolicy(["assignment", "show", "--ids", policyDefinition.id]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("--ids must be one policy assignment") });
    await expect(runPolicy(["assignment", "show", "--ids", managementLock.id]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("--ids must be one policy assignment") });
    await expect(runPolicy(["assignment", "show", "--ids", `${policyAssignment.id}?api-version=2021-06-01`]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("unescaped") });
    await expect(runPolicy(["assignment", "show", "--name", "a/b", "--resource-group", "rg-demo"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("one resource path segment") });
    await expect(runPolicy(["definition", "list", "--resource-group", "rg-demo"]))
      .rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
    await expect(runPolicy(["definition", "show", "--name", "ResourceNaming", "--resource-group", "rg-demo"]))
      .rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
    await expect(runPolicy(["definition", "show", "--ids", policyAssignment.id]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("--ids must be one policy definition") });
    await expect(runPolicy(["state", "list", "--workspace", "x"]))
      .rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
    await expect(runPolicy(["assignment", "list", "--fields", "properties"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("--fields supports only") });
    await expect(runPolicy(["assignment", "list", "--limit", "0"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(runPolicy(["assignment", "list", "--management-group", "contoso-root"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("management-group") });
    await expect(runPolicy(["assignment", "list", "--limit", "1001"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(runLock(["show", "--name", "sub-lock", "--ids", managementLock.id]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("not both") });
    await expect(runLock(["show", "--ids", denyAssignment.id]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("--ids must be one management lock") });
    await expect(runLock(["list", "--limit", "1001"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(runDeny(["show", "--ids", managementLock.id]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("--ids must be one deny assignment") });
    for (const runArgs of [
      runPolicy(["assignment", "show", "--ids", `${denyAssignment.id}`]),
      runDeny(["show", "--name", "sub-deny", "--ids", denyAssignments[1]!.id]),
      runPolicy(["assignment", "show", "--ids", `${policyDefinition.id}`]),
      runPolicy(["definition", "show", "--name", "ResourceNaming", "--ids", policyDefinitions[1]!.id]),
    ]) {
      allMock.mockClear();
      requestMock.mockClear();
      await expect(runArgs).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(allMock).not.toHaveBeenCalled();
      expect(requestMock).not.toHaveBeenCalled();
    }
  });

  it("needs exactly one subscription for by-name show", async () => {
    useProfile("ci", { auth: "token", subscriptions: [SUB_A, SUB_B] });
    await expect(runPolicy(["assignment", "show", "--name", "CostManagement"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("exactly one subscription") });
    expect(allMock).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("uses the ID subscription for show --ids and refuses scope conflicts", async () => {
    useProfile("ci", { auth: "token" });
    await expect(runPolicy(["assignment", "show", "--ids", policyAssignment.id]))
      .resolves.toMatchObject({ name: "CostManagement", subscription: SUB_A });
    useProfile("ci", { auth: "token", subscriptions: [SUB_B] });
    await expect(runPolicy(["assignment", "show", "--ids", policyAssignment.id]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("conflicts with selected subscriptions") });
    useProfile("ci", { auth: "token" });
    await expect(runLock(["show", "--ids", managementLock.id]))
      .resolves.toMatchObject({ name: "sub-lock", subscription: SUB_A });
    useProfile("ci", { auth: "token", subscriptions: [SUB_B] });
    await expect(runLock(["show", "--ids", managementLock.id]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("conflicts with selected subscriptions") });
  });

  it("shows tenant-scoped built-ins without a subscription in the ID", async () => {
    useProfile("ci", { auth: "token", subscriptions: [SUB_B] });
    await expect(runPolicy(["definition", "show", "--ids", policyDefinition.id]))
      .resolves.toMatchObject({ name: policyDefinition.name });
  });

  it("surfaces access-denied failures without masking them as empty", async () => {
    requestMock.mockRejectedValueOnce(new AxiError("access denied: Denied", "FORBIDDEN", []));
    await expect(runPolicy(["assignment", "show", "--name", "CostManagement"]))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("governance truncation hints", () => {
  it("discloses truncated assignment descriptions with a selector-preserving hint", async () => {
    const item = { ...policyAssignment, properties: { ...policyAssignment.properties, description: "x".repeat(250) } };
    requestMock.mockResolvedValue(item as never);
    const result = await runPolicy(["assignment", "show", "--ids", item.id]);
    expect(result.description).toContain("truncated, 250 chars total");
    expect(result.help).toEqual([`Run \`az-axi policy assignment show --ids ${item.id} --full\` for every nested row`]);
    const full = await runPolicy(["assignment", "show", "--ids", item.id, "--full"]);
    expect(full.description).toBe("x".repeat(250));
    expect(full).not.toHaveProperty("help");
    await expect(runPolicy(["assignment", "show", "--ids", item.id, "--fields", "name"]))
      .resolves.toEqual({ profile: "ci", name: item.name });
  });

  it("discloses truncated definition rules and parameters in list and show", async () => {
    const item = { ...policyDefinitions[1]!, properties: { ...policyDefinitions[1]!.properties,
      displayName: "x".repeat(250) } };
    allMock.mockResolvedValueOnce({ items: [item] });
    requestMock.mockResolvedValue(item as never);
    const list = await runPolicy(["definition", "list"]);
    expect(list.help).toEqual(expect.arrayContaining([
      "Run `az-axi policy definition list --full` to show every fetched row",
    ]));
    const show = await runPolicy(["definition", "show", "--ids", item.id]);
    expect(show.description).toBeDefined();
    const long = { ...item, properties: { ...item.properties, description: "y".repeat(300) } };
    requestMock.mockResolvedValueOnce(long as never);
    const truncated = await runPolicy(["definition", "show", "--ids", item.id]);
    expect(truncated.description).toContain("truncated, 300 chars total");
    expect(truncated.help).toEqual([`Run \`az-axi policy definition show --ids ${item.id} --full\` for every nested row`]);
  });

  it("quotes wildcard selectors and preserves explicit identity in detail hints", async () => {
    allMock.mockResolvedValueOnce({ items: [policyAssignments[0]] });
    const result = await runPolicy(["assignment", "list",
      "--profile", "ci", "--config", join(dir, "config.json"), "--tenant", SUB_B]);
    expect(result.help).toEqual([
      `Run \`az-axi policy definition show --ids /subscriptions/${SUB_A}/providers/Microsoft.Authorization/policyDefinitions/ResourceNaming --profile ci --config ${quoteFlagValue(join(dir, "config.json"))} --tenant ${SUB_B}\` for the assigned definition`,
    ]);
  });

  it("routes every governance leaf through the registry without Azure access", async () => {
    for (const argv of [
      ["policy", "assignment", "list"],
      ["policy", "assignment", "show", "--ids", policyAssignment.id],
      ["policy", "definition", "list"],
      ["policy", "definition", "show", "--name", "ResourceNaming"],
      ["policy", "set-definition", "list"],
      ["policy", "set-definition", "show", "--ids", policySetDefinition.id],
      ["policy", "state", "list"],
    ]) {
      const routed = routeArgv(argv);
      await expect(runPolicy(routed.argv.slice(1))).resolves.toMatchObject({ profile: "ci" });
    }
  });
});
