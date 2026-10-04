import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ sendRequest: vi.fn(), request: vi.fn(), requestAll: vi.fn() }));

import { run as runRole } from "../src/commands/role.js";
import { run as runSecurity } from "../src/commands/security.js";
import { request, requestAll } from "../src/lib/client.js";
import { routeArgv } from "../src/lib/router.js";
import { clearSubscriptionCache } from "../src/lib/scope.js";
import {
  SUB_A, SUB_B, SYN,
  defenderPricing, defenderPricings,
  roleDefinition, roleDefinitions,
  securitySubAssessment, securitySubAssessments,
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
  if (path.endsWith("/roleDefinitions")) return roleDefinitions;
  if (path.endsWith("/pricings")) return defenderPricings;
  if (path.endsWith("/subAssessments")) return securitySubAssessments;
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
    const all = [...roleDefinitions, ...defenderPricings, ...securitySubAssessments];
    const found = all.find((item) => item.id.toLowerCase() === path.toLowerCase());
    if (!found) throw new Error(`unexpected offline path: ${path}`);
    return found as never;
  });
}

function useProfile(name = "ci", profile: Record<string, unknown> = { auth: "token", subscriptions: [SUB_A] }) {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { [name]: profile } }));
  process.env.AZ_AXI_PROFILE = name;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-role-defender-"));
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

describe("role definition list and show", () => {
  it("lists built-in and custom definitions with separately labelled permission planes", async () => {
    const result = await runRole(["definition", "list"]);
    expect(result).toMatchObject({
      profile: "ci",
      total: 2,
      count: "2 role definitions",
      byType: { BuiltInRole: 1, CustomRole: 1 },
      rows: [
        { name: SYN(40), role: "Contoso On-call", type: "CustomRole",
          actions: "Microsoft.Compute/*/read, Microsoft.Compute/virtualMachines/start/action",
          dataActions: "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/*" },
        { name: SYN(41), role: "Reader", type: "BuiltInRole", actions: "*/read", dataActions: "" },
      ],
    });
    expect(result.help).toEqual([
      `Run \`az-axi role definition show --ids ${roleDefinition.id}\` for the first row in detail`,
    ]);
    const options = listCalls();
    const list = options.find((call) => String(call["path"] ?? "").endsWith("/roleDefinitions"))!;
    expect(list["method"]).toBe("GET");
    expect(list["apiVersion"]).toBe("2022-04-01");
    expect(list["path"]).toBe(`/subscriptions/${SUB_A}/providers/Microsoft.Authorization/roleDefinitions`);
  });

  it("matches --name against the GUID or the role name and filters customs", async () => {
    expect(await runRole(["definition", "list", "--name", "Reader"])).toMatchObject({ total: 1 });
    expect(await runRole(["definition", "list", "--name", SYN(40)])).toMatchObject({ total: 1 });
    const customs = await runRole(["definition", "list", "--custom-role-only"]);
    expect(customs).toMatchObject({ total: 1, byType: { CustomRole: 1 } });
    const fields = await runRole(["definition", "list", "--fields", "name,role"]);
    expect(fields.rows).toEqual([
      { name: SYN(40), role: "Contoso On-call" },
      { name: SYN(41), role: "Reader" },
    ]);
  });

  it("reports an explicit empty state", async () => {
    const result = await runRole(["definition", "list", "--name", "missing"]);
    expect(result).toMatchObject({
      total: 0, count: "0 role definitions",
      rows: expect.stringContaining("0 role definitions found in subscription"),
    });
  });

  it("shows a custom definition by GUID and a built-in by tenant ARM ID", async () => {
    const custom = await runRole(["definition", "show", "--name", SYN(40)]);
    expect(custom).toMatchObject({
      name: SYN(40), role: "Contoso On-call", type: "CustomRole", subscription: SUB_A,
      actions: ["Microsoft.Compute/*/read, Microsoft.Compute/virtualMachines/start/action"],
      dataActions: ["Microsoft.Storage/storageAccounts/blobServices/containers/blobs/*"],
      notActions: [""],
      notDataActions: ["Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write"],
    });
    expect(custom.assignableScopes).toEqual([`/subscriptions/${SUB_A}`]);
    const builtin = await runRole(["definition", "show", "--ids", roleDefinitions[1]!.id]);
    expect(builtin).toMatchObject({ name: SYN(41), role: "Reader", type: "BuiltInRole" });
    const full = await runRole(["definition", "show", "--ids", roleDefinition.id, "--full"]);
    expect(full).toMatchObject({ createdOn: "2026-09-01T12:00:00Z", updatedOn: "2026-10-01T12:00:00Z" });
    expect(full).not.toHaveProperty("help");
  });
});

describe("security pricing list and show", () => {
  it("lists Defender plans with tiers and coverage aggregates", async () => {
    const result = await runSecurity(["pricing", "list"]);
    expect(result).toMatchObject({
      profile: "ci",
      total: 2,
      count: "2 Defender plans",
      byTier: { Standard: 1, Free: 1 },
      rows: [
        { name: "AppServices", tier: "Free", subPlan: "", coverage: "NotCovered" },
        { name: "VirtualMachines", tier: "Standard", subPlan: "P2", coverage: "PartiallyCovered" },
      ],
    });
    const options = listCalls();
    const list = options.find((call) => String(call["path"] ?? "").endsWith("/pricings"))!;
    expect(list["method"]).toBe("GET");
    expect(list["apiVersion"]).toBe("2024-01-01");
    expect(list["path"]).toBe(`/subscriptions/${SUB_A}/providers/Microsoft.Security/pricings`);
  });

  it("filters by exact plan name and reports an explicit empty state", async () => {
    expect(await runSecurity(["pricing", "list", "--name", "VirtualMachines"])).toMatchObject({ total: 1 });
    const empty = await runSecurity(["pricing", "list", "--name", "missing"]);
    expect(empty).toMatchObject({
      total: 0, count: "0 Defender plans",
      rows: expect.stringContaining("0 Defender plans found in subscription"),
    });
  });

  it("shows one plan by name with extensions and by ARM ID", async () => {
    const plan = await runSecurity(["pricing", "show", "--name", "VirtualMachines"]);
    expect(plan).toMatchObject({
      name: "VirtualMachines", tier: "Standard", subPlan: "P2", coverage: "PartiallyCovered",
      freeTrial: "PT0S", enforce: "False", subscription: SUB_A,
    });
    expect(plan.extensions).toEqual(["AgentlessVmScanning (True), MdeDesignatedSubscription (True)"]);
    const byId = await runSecurity(["pricing", "show", "--ids", defenderPricing.id]);
    expect(byId).toMatchObject({ name: "VirtualMachines", tier: "Standard" });
    const full = await runSecurity(["pricing", "show", "--ids", defenderPricing.id, "--full"]);
    expect(full.extensions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "AgentlessVmScanning", enabled: "True" }),
    ]));
    expect(full).not.toHaveProperty("help");
  });
});

describe("security sub-assessment list and show", () => {
  it("lists findings worst severity first with status and severity aggregates", async () => {
    const result = await runSecurity(["sub-assessment", "list"]);
    expect(result).toMatchObject({
      profile: "ci",
      total: 2,
      count: "2 security sub-assessments",
      byStatus: { Unhealthy: 1, Healthy: 1 },
      bySeverity: { High: 1, Low: 1 },
      rows: [
        { name: SYN(51), assessment: SYN(50), resource: "database1", status: "Unhealthy", severity: "High" },
        { name: SYN(52), assessment: SYN(50), resource: "sqlserver1demo", status: "Healthy", severity: "Low" },
      ],
    });
    const options = listCalls();
    const list = options.find((call) => String(call["path"] ?? "").endsWith("/subAssessments"))!;
    expect(list["method"]).toBe("GET");
    expect(list["apiVersion"]).toBe("2019-01-01-preview");
    expect(list["path"]).toBe(`/subscriptions/${SUB_A}/providers/Microsoft.Security/subAssessments`);
  });

  it("filters by parent assessment, assessed resource and finding name", async () => {
    expect(await runSecurity(["sub-assessment", "list", "--assessment-name", SYN(50)]))
      .toMatchObject({ total: 2 });
    expect(await runSecurity(["sub-assessment", "list", "--assessment-name", "missing"]))
      .toMatchObject({ total: 0 });
    const resource = `${securitySubAssessment.properties.resourceDetails.id}`;
    expect(await runSecurity(["sub-assessment", "list", "--assessed-resource-id", resource]))
      .toMatchObject({ total: 1 });
    expect(await runSecurity(["sub-assessment", "list", "--name", SYN(52)]))
      .toMatchObject({ total: 1 });
    const empty = await runSecurity(["sub-assessment", "list", "--assessed-resource-id",
      `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Compute/virtualMachines/vm1`]);
    expect(empty).toMatchObject({ total: 0, count: "0 security sub-assessments" });
  });

  it("shows one finding by assessment and name with truncated detail", async () => {
    requestMock.mockResolvedValueOnce(securitySubAssessment as never);
    const shown = await runSecurity(["sub-assessment", "show",
      "--assessment-name", SYN(50), "--name", SYN(51)]);
    expect(requestMock.mock.calls.at(-1)?.[1]).toMatchObject({
      method: "GET",
      path: `/subscriptions/${SUB_A}/providers/Microsoft.Security/assessments/${SYN(50)}/subAssessments/${SYN(51)}`,
      apiVersion: "2019-01-01-preview",
    });
    expect(shown).toMatchObject({
      name: SYN(51), assessment: SYN(50), status: "Unhealthy", severity: "High",
      category: "SurfaceAreaReduction",
      resource: securitySubAssessment.properties.resourceDetails.id,
    });
    expect(shown.description as string).toContain("(truncated,");
    expect(shown.help).toEqual([
      `Run \`az-axi security sub-assessment show --name ${SYN(51)} --assessment-name ${SYN(50)} --full\` for every nested row`,
    ]);
    const full = await runSecurity(["sub-assessment", "show", "--ids", securitySubAssessment.id, "--full"]);
    expect(full).toMatchObject({ vulnId: "VA2064" });
    expect(full.additionalData).toMatchObject({ assessedResourceType: "SqlServerVulnerability" });
    expect(full).not.toHaveProperty("help");
  });

  it("shows a resource-scoped finding by ARM ID", async () => {
    const shown = await runSecurity(["sub-assessment", "show", "--ids", securitySubAssessment.id]);
    expect(shown).toMatchObject({ name: SYN(51), status: "Unhealthy" });
  });
});

describe("role and Defender reads stay read-only and validate before transport", () => {
  it("rejects unknown verbs and leaves without transport", async () => {
    await expect(runRole(["definition", "update"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(runRole(["assignment", "list"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(runRole([])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(runSecurity(["pricing", "create"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(runSecurity(["sub-assessment", "delete"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(runSecurity(["pricing"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(allMock).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("rejects bad selectors, flags and identities before transport", async () => {
    await expect(runRole(["definition", "list", "--kind", "Basic"]))
      .rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
    await expect(runRole(["definition", "show", "--name", SYN(40), "--ids", roleDefinition.id]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("not both") });
    await expect(runRole(["definition", "show"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("needs --name or --ids") });
    await expect(runSecurity(["pricing", "show", "--name", "VirtualMachines", "--ids", defenderPricing.id]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("not both") });
    await expect(runSecurity(["sub-assessment", "show", "--name", SYN(51)]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("--assessment-name") });
    await expect(runSecurity(["sub-assessment", "list", "--resource-group", "rg-demo"]))
      .rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
    await expect(runSecurity(["sub-assessment", "list", "--assessed-resource-id", "not-an-arm-id"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("--assessed-resource-id") });
    await expect(runSecurity(["sub-assessment", "list", "--assessed-resource-id",
      `/subscriptions/${SUB_B}/resourceGroups/rg-demo/providers/Microsoft.Compute/virtualMachines/vm1`]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("conflicts with selected subscriptions") });
    expect(allMock).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("needs exactly one subscription for by-name show", async () => {
    useProfile("ci", { auth: "token", subscriptions: [SUB_A, SUB_B] });
    await expect(runRole(["definition", "show", "--name", SYN(40)]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("exactly one subscription") });
    await expect(runSecurity(["pricing", "show", "--name", "VirtualMachines"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("exactly one subscription") });
    expect(allMock).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("routes every new leaf through the registry without Azure access", async () => {
    for (const argv of [
      ["role", "definition", "list"],
      ["role", "definition", "show", "--ids", roleDefinition.id],
      ["security", "pricing", "list"],
      ["security", "pricing", "show", "--ids", defenderPricing.id],
      ["security", "sub-assessment", "list"],
      ["security", "sub-assessment", "show", "--ids", securitySubAssessment.id],
    ]) {
      const routed = routeArgv(argv);
      const top = argv[0]!;
      const run = top === "role" ? runRole : runSecurity;
      await expect(run(routed.argv.slice(1))).resolves.toMatchObject({ profile: "ci" });
    }
  });
});
