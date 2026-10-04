// Policy and effect snapshot (PLAN.md Sections 6.13.1, 6.13.9, 7.1). Changing any table here
// changes what az-axi may send, so CODEOWNERS routes this file to the owner.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxiError } from "axi-sdk-js";
import { sendRequest } from "../src/lib/client.js";
import { clearCredentialCache } from "../src/lib/auth.js";
import type { Resource, ResolvedProfile } from "../src/lib/config.js";
import { enforceGates } from "../src/lib/gates.js";
import {
  DESTRUCTIVE_ACTIONS,
  PROTECTED_AUTHORIZATION_TYPES,
  SECRET_ACTIONS,
  SECRET_PARAMETER_ACTIONS,
  assertReadOnlyBoundary,
  classifyRequest,
  type RequestClass,
} from "../src/lib/policy.js";
import { COMMANDS, assertEffectAllows, runWithEffect, type Effect } from "../src/lib/registry.js";

const SUB = "/subscriptions/00000000-0000-0000-0000-000000000020";
const RG = `${SUB}/resourceGroups/rg-demo`;
const STORAGE = `${RG}/providers/Microsoft.Storage/storageAccounts/stdemo`;

type Row = [Resource, string, string, RequestClass];

const CLASSIFICATION: Row[] = [
  // read: GET and HEAD, always
  ["arm", "GET", "/subscriptions", "read"],
  ["arm", "HEAD", STORAGE, "read"],
  ["arm", "GET", `${RG}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/incidents`, "read"],
  ["arm", "GET", `${RG}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/incidents/00000000-0000-0000-0000-000000000090`, "read"],
  ["arm", "GET", `${RG}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/alertRules`, "read"],
  ["arm", "GET", `${RG}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/alertRules/00000000-0000-0000-0000-000000000096`, "read"],
  ["arm", "GET", `${RG}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/dataConnectors`, "read"],
  ["arm", "GET", `${RG}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/dataConnectors/00000000-0000-0000-0000-000000000098`, "read"],
  ["logs", "GET", "/v1/workspaces", "read"],
  ["graph", "GET", "/v1.0/me", "read"],
  // query: exactly the listed POST paths
  ["arm", "POST", "/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01", "query"],
  ["arm", "POST", `${SUB}/providers/Microsoft.Resources/deployments/d1/whatIf`, "query"],
  ["arm", "POST", `${RG}/providers/Microsoft.Resources/deployments/d1/whatIf`, "query"],
  ["logs", "POST", "/v1/workspaces/00000000-0000-0000-0000-000000000010/query", "query"],
  ["graph", "POST", "/v1.0/directoryObjects/getByIds", "query"],
  // query paths are per host: the logs path on arm is just an unknown POST
  ["arm", "POST", "/v1/workspaces/00000000-0000-0000-0000-000000000010/query", "write"],
  ["arm", "POST", `${SUB}/providers/Microsoft.Resources/deployments/d1/whatIf/extra`, "write"],
  ["arm", "POST", "/providers/Microsoft.Management/managementGroups/mg/providers/Microsoft.Resources/deployments/d1/whatIf", "write"],
  // reviewed Sentinel incident related reads: exact bodyless POST actions only
  ["arm", "POST", `${RG}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/incidents/00000000-0000-0000-0000-000000000090/alerts`, "query"],
  ["arm", "POST", `${RG}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/incidents/00000000-0000-0000-0000-000000000090/entities`, "query"],
  ["arm", "POST", `${RG}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/incidents/00000000-0000-0000-0000-000000000090/ALERTS`, "query"],
  ["arm", "POST", `${RG}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/incidents/00000000-0000-0000-0000-000000000090/alerts/?api-version=2025-09-01`, "query"],
  // every neighboring POST shape stays a write: sibling actions, non-GUID
  // incidents, other providers, child paths and non-POST verbs
  ["arm", "POST", `${RG}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/incidents/00000000-0000-0000-0000-000000000090/comments`, "write"],
  ["arm", "POST", `${RG}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/incidents/00000000-0000-0000-0000-000000000090/relations`, "write"],
  ["arm", "POST", `${RG}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/incidents/00000000-0000-0000-0000-000000000090/bookmarks`, "write"],
  ["arm", "POST", `${RG}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/incidents/3177/alerts`, "write"],
  ["arm", "POST", `${RG}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/incidents/not-a-guid/entities`, "write"],
  ["arm", "POST", `${RG}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.Security/alerts`, "write"],
  ["arm", "POST", `${RG}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/incidents/00000000-0000-0000-0000-000000000090/alerts/extra`, "write"],
  ["arm", "GET", `${RG}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/incidents/00000000-0000-0000-0000-000000000090/alerts`, "read"],
  ["arm", "PUT", `${RG}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/incidents/00000000-0000-0000-0000-000000000090/alerts`, "write"],
  ["logs", "POST", `${RG}/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/incidents/00000000-0000-0000-0000-000000000090/alerts`, "write"],
  ...SECRET_ACTIONS.map((action): Row => ["arm", "POST", `${STORAGE}/${action}`, "secret"]),
  ["arm", "POST", `${STORAGE}/LISTKEYS`, "secret"],
  ["arm", "POST", `${STORAGE}/list%4Beys`, "secret"],
  ["arm", "POST", `${STORAGE}/listKeys/?api-version=2023-01-01`, "secret"],
  ["arm", "POST", `${RG}/providers/Microsoft.ContainerService/managedClusters/cluster1/listClusterAdminCredential`, "secret"],
  ["arm", "POST", `${RG}/providers/Microsoft.ContainerService/managedClusters/cluster1/listClusterUserCredential`, "secret"],
  ["arm", "POST", `${RG}/providers/Microsoft.ContainerService/managedClusters/cluster1/listClusterMonitoringUserCredential`, "secret"],
  ["arm", "POST", `${RG}/providers/Microsoft.ContainerService/managedClusters/cluster1/accessProfiles/clusterUser/listCredential`, "secret"],
  ["arm", "POST", `${RG}/providers/Microsoft.Search/searchServices/search1/listAdminKeys`, "secret"],
  ["arm", "POST", `${RG}/providers/Microsoft.Search/searchServices/search1/listQueryKeys`, "secret"],
  ["arm", "POST", `${RG}/providers/Microsoft.Search/searchServices/search1/createQueryKey/key1`, "secret"],
  ["arm", "POST", `${RG}/providers/Microsoft.Search/searchServices/search1/regenerateAdminKey/primary`, "secret"],
  ["arm", "POST", `${RG}/providers/Microsoft.Search/searchServices/search1/regenerateAdminKey/secondary`, "secret"],
  ["arm", "POST", `${STORAGE}/listAccountSas`, "secret"],
  ["arm", "POST", `${STORAGE}/listServiceSas`, "secret"],
  ["arm", "POST", `${STORAGE}/localUsers/user1/regeneratePassword`, "secret"],
  // destructive: DELETE, destructive POST actions, protected Microsoft.Authorization types
  ["arm", "DELETE", STORAGE, "destructive"],
  ["arm", "delete", STORAGE, "destructive"],
  ["arm", "POST", `${RG}/providers/Microsoft.Compute/virtualMachineScaleSets/scale1/delete`, "destructive"],
  ...DESTRUCTIVE_ACTIONS.map((action): Row => ["arm", "POST", `${RG}/providers/Microsoft.Compute/virtualMachines/vm1/${action}`, "destructive"]),
  ...PROTECTED_AUTHORIZATION_TYPES.flatMap((type): Row[] =>
    ["PUT", "PATCH", "DELETE"].map((method): Row => [
      "arm",
      method,
      `${SUB}/providers/Microsoft.Authorization/${type}/name1`,
      "destructive",
    ]),
  ),
  ["arm", "PUT", `${STORAGE}/providers/Microsoft.Authorization/locks/lock1`, "destructive"],
  ["arm", "PUT", `${SUB}/providers/microsoft.authorization/ROLEASSIGNMENTS/ra1`, "destructive"],
  // write: any other PUT, PATCH or POST on arm, and anything unrecognized
  ["arm", "PUT", STORAGE, "write"],
  ["arm", "PATCH", RG, "write"],
  ["arm", "POST", `${RG}/providers/Microsoft.Compute/virtualMachines/vm1/start`, "write"],
  ["arm", "POST", `${RG}/providers/Microsoft.Compute/virtualMachines/createQueryKey/start`, "write"],
  ["arm", "POST", `${RG}/providers/Microsoft.Compute/virtualMachines/regenerateAdminKey/start`, "write"],
  ["arm", "POST", "/providers/Microsoft.Authorization/checkAccess", "write"],
  ["arm", "PUT", `${SUB}/providers/Microsoft.Authorization/policyDefinitions/pd1`, "write"],
  ["arm", "OPTIONS", STORAGE, "write"],
  ["arm", "TRACE", STORAGE, "write"],
  // graph and logs never reach read-only classes through non-query requests
  ["graph", "POST", "/v1.0/users", "write"],
  ["graph", "DELETE", "/v1.0/users/x", "destructive"],
  ["logs", "PUT", "/v1/workspaces/x", "write"],
];

describe("classifyRequest", () => {
  it.each(CLASSIFICATION)("%s %s %s -> %s", (resource, method, path, expected) => {
    expect(classifyRequest({ resource, method, path })).toBe(expected);
  });
});

describe("policy rule lists", () => {
  it("snapshots the credential, destructive and protected lists", () => {
    expect(SECRET_ACTIONS).toEqual([
      "listKeys",
      "listKey",
      "listCredentials",
      "listConnectionStrings",
      "listSecrets",
      "listAdminCredentials",
      "listPublishingCredentials",
      "publishxml",
      "listClusterAdminCredential",
      "listClusterUserCredential",
      "listClusterMonitoringUserCredential",
      "listCredential",
      "listAdminKeys",
      "listQueryKeys",
      "listAccountSas",
      "listServiceSas",
      "regeneratePassword",
      "regenerateCredential",
      "generateCredentials",
      "sharedKeys",
      "regenerateSharedKey",
      "readonlykeys",
      "listCallbackUrl",
      "retrieveBootDiagnosticsData",
    ]);
    expect(SECRET_PARAMETER_ACTIONS).toEqual(["createQueryKey", "regenerateAdminKey"]);
    expect(DESTRUCTIVE_ACTIONS).toEqual([
      "delete",
      "purge",
      "regenerateKey",
      "regenerateKeys",
      "regeneratePrimaryKey",
      "regenerateSecondaryKey",
      "revoke",
      "deallocate",
      "powerOff",
      "stop",
      "restart",
      "failover",
      "reimage",
      "redeploy",
      "reimageall",
      "simulateEviction",
    ]);
    expect(PROTECTED_AUTHORIZATION_TYPES).toEqual(["roleAssignments", "roleDefinitions", "locks", "policyAssignments"]);
  });
});

describe("command effect registry", () => {
  it("snapshots every command's declared effect", async () => {
    const effects: Record<string, string> = {};
    for (const [name, load] of Object.entries(COMMANDS)) {
      const { meta } = await load();
      expect(meta.name).toBe(name);
      effects[name] = meta.effect;
    }
    expect(effects).toEqual({
      group: "read", resource: "read",
      account: "read", monitor: "read",
      home: "read",
      doctor: "read",
      config: "read",
      sub: "read",
      rg: "read",
      rbac: "read",
      activity: "read",
      defender: "read",
      security: "write",
      sentinel: "read",
      exposure: "read",
      logs: "read",
      op: "read",
      api: "dynamic",
      az: "read",
      storage: "read",
      keyvault: "read",
      acr: "read",
      tag: "write",
    });
  });

  it.each<[Effect, RequestClass, boolean]>([
    ["read", "read", true],
    ["read", "query", true],
    ["read", "write", false],
    ["read", "destructive", false],
    ["write", "write", true],
    ["write", "destructive", false],
    ["destructive", "destructive", true],
    ["dynamic", "destructive", true],
  ])("a command declared %s sending a %s request: allowed=%s", async (effect, cls, allowed) => {
    const attempt = runWithEffect(effect, async () => assertEffectAllows(cls));
    if (allowed) await expect(attempt).resolves.toBeUndefined();
    else await expect(attempt).rejects.toMatchObject({ code: "READ_ONLY" });
  });

  it("does not restrict requests outside a command", () => {
    expect(() => assertEffectAllows("write")).not.toThrow();
  });
});

function profile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return { name: "test", source: "implicit", auth: "token", writeSubscriptions: [], ...overrides };
}

describe("read-only boundary and gates", () => {
  it.each(CLASSIFICATION.filter(([, , , cls]) => cls === "secret"))(
    "blocks secret request %s %s with READ_ONLY",
    (resource, method, path) => {
      const request = { resource, method, path };
      expect(() => assertReadOnlyBoundary(request, "secret")).toThrowError(
        expect.objectContaining({ code: "READ_ONLY" }),
      );
    },
  );

  it.each(CLASSIFICATION.filter(([resource, , , cls]) => resource !== "arm" && cls !== "read" && cls !== "query"))(
    "blocks non-arm write %s %s %s with READ_ONLY",
    (resource, method, path, cls) => {
      expect(() => assertReadOnlyBoundary({ resource, method, path }, cls)).toThrowError(
        expect.objectContaining({ code: "READ_ONLY" }),
      );
    },
  );

  it.each(CLASSIFICATION.filter(([, , , cls]) => cls === "write" || cls === "destructive"))(
    "the gates block %s %s %s on a default profile with WRITES_DISABLED",
    (resource, method, path, cls) => {
      expect(() => enforceGates(profile(), { resource, method, path }, cls)).toThrowError(
        expect.objectContaining({ code: "WRITES_DISABLED" }),
      );
    },
  );

  it("lets a write-enabled profile reach the dry run without --execute", () => {
    const enabled = profile({
      allowWrites: true,
      subscriptions: ["00000000-0000-0000-0000-000000000020"],
      writeSubscriptions: ["00000000-0000-0000-0000-000000000020"],
    });
    expect(() =>
      enforceGates(enabled, { resource: "arm", method: "PATCH", path: SUB }, "write"),
    ).not.toThrow();
  });

  it("lets read and query requests through the gates", () => {
    for (const cls of ["read", "query"] as const) {
      expect(() => enforceGates(profile(), { resource: "arm", method: "GET", path: "/subscriptions" }, cls)).not.toThrow();
    }
  });

  it("never tells an agent how to enable writes", () => {
    let error: AxiError | undefined;
    try {
      enforceGates(profile(), { resource: "arm", method: "DELETE", path: STORAGE }, "destructive");
    } catch (err) {
      error = err as AxiError;
    }
    const text = [error?.message, ...(error?.suggestions ?? [])].join("\n");
    expect(text).toContain("README.md#writes");
    expect(text).not.toMatch(/allowWrites|AZ_AXI_READ_ONLY|config file|--execute/i);
  });
});

describe("client enforces policy before anything is sent", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    clearCredentialCache();
    process.env.AZ_AXI_ARM_TOKEN = "policy-test-token";
    process.env.AZ_AXI_GRAPH_TOKEN = "policy-test-token";
    process.env.AZ_AXI_LOGS_TOKEN = "policy-test-token";
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AZ_AXI_ARM_TOKEN;
    delete process.env.AZ_AXI_GRAPH_TOKEN;
    delete process.env.AZ_AXI_LOGS_TOKEN;
  });

  const BLOCKED = CLASSIFICATION.filter(([, , , cls]) => cls !== "read" && cls !== "query");

  it.each(BLOCKED)("%s %s %s sends nothing", async (resource, method, path) => {
    await expect(
      sendRequest(profile(), { resource, method, path, apiVersion: "2022-12-01" }),
    ).rejects.toBeInstanceOf(AxiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends read and query requests", async () => {
    await sendRequest(profile(), { path: "/subscriptions", apiVersion: "2022-12-01" });
    await sendRequest(profile(), {
      method: "POST",
      path: "/providers/Microsoft.ResourceGraph/resources",
      apiVersion: "2024-04-01",
      body: { query: "Resources | take 1" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("blocks a command declared read that sends a write, before the gates", async () => {
    await expect(
      runWithEffect("read", () =>
        sendRequest(profile(), { method: "PATCH", path: RG, apiVersion: "2022-12-01" }),
      ),
    ).rejects.toMatchObject({ code: "READ_ONLY" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
