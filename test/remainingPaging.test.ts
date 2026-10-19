import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { COMMAND_LEAVES, runCommand } from "../src/lib/registry.js";
import { routeArgv } from "../src/lib/router.js";
import * as samples from "./samples.js";

const remaining = [
  { command: "activity list", item: samples.activityEvents[0] },
  { command: "defender alerts --status all", item: samples.defenderAlerts[0] },
  { command: "defender assessments --status all", item: samples.defenderAssessments[0], graph: true },
  { command: "defender score", item: samples.defenderScores[0], graph: true },
  { command: "rbac list", item: samples.rbacAssignments[0], graph: true },
  { command: "exposure --check public-ips", item: samples.exposurePublicIps[0], graph: true },
  { command: "exposure --check mgmt-ports", item: samples.exposureMgmtPorts[0], graph: true },
  { command: "exposure --check any-any", item: samples.exposureAnyAny[0], graph: true },
  { command: "monitor log-analytics workspace list", item: samples.discoveryWorkspace },
  { command: "monitor metrics alert list", item: samples.monitorAlertRule },
  { command: "monitor action-group list", item: samples.monitorActionGroup },
  { command: "monitor diagnostic-settings list --resource " + samples.monitorResource, item: samples.monitorDiagnosticSetting },
  { command: "monitor metrics list --resource " + samples.monitorResource, item: samples.monitorMetricDefinition },
  { command: "security pricing list", item: samples.defenderPricing },
  { command: "security sub-assessment list", item: samples.securitySubAssessment },
  { command: "policy assignment list", item: samples.policyAssignment },
  { command: "policy definition list", item: samples.policyDefinition },
  { command: "policy set-definition list", item: samples.policySetDefinition },
  { command: "policy state list", item: samples.policyStates[0], state: true },
  { command: "lock list", item: samples.managementLock },
  { command: "deny-assignment list", item: samples.denyAssignment },
  { command: "role definition list", item: samples.roleDefinition },
  { command: "vm list", item: samples.computeVm },
  { command: "vmss list", item: samples.computeVmss },
  { command: "disk list", item: samples.computeDisk },
] as const;
let dir: string;
let pages: number;
let endAfter: number;
let item: Record<string, unknown>;
let graph: boolean;
let state: boolean;
const json = (body: unknown) => new Response(JSON.stringify(body));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-remaining-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ version: 1, profiles: { ci: { auth: "token", subscriptions: [samples.SUB_A] } } }));
  vi.stubEnv("AZ_AXI_CONFIG", join(dir, "config.json"));
  vi.stubEnv("AZ_AXI_PROFILE", "ci");
  vi.stubEnv("AZ_AXI_ARM_TOKEN", "offline-arm");
  vi.stubEnv("AZ_AXI_GRAPH_TOKEN", "offline-graph");
  vi.stubEnv("AZ_AXI_SUBSCRIPTIONS", samples.SUB_A);
  pages = 0;
  endAfter = Infinity;
  graph = false;
  state = false;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "graph.microsoft.com") return json({ value: [] });
    if (url.pathname === "/subscriptions") return json({ value: samples.subscriptionList });
    if (init?.method === "POST" && url.pathname.includes("/incidents/")) return json(url.pathname.endsWith("/alerts")
      ? { value: samples.sentinelIncidentAlerts } : samples.sentinelIncidentEntities);
    expect(init?.method).toBe(graph || state ? "POST" : "GET");
    pages++;
    const row = { ...item, id: String(item.id ?? "/example") + pages, name: "example-" + pages,
      eventDataId: "event-" + pages, recommendation: "recommendation-" + pages };
    const next = pages < endAfter ? url.origin + url.pathname + "?api-version=2025-01-01&$skiptoken=page-" + pages : undefined;
    if (graph) return json({ data: [row], ...(next ? { $skipToken: "page-" + pages, resultTruncated: true } : {}) });
    if (state) return json({ value: [row], ...(next ? { "@odata.nextLink": next } : {}) });
    return json({ value: [row], ...(next ? { nextLink: next } : {}) });
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

async function run(command: string, flags: string[]) {
  const { argv } = routeArgv([...command.split(" "), ...flags]);
  return runCommand(argv[0]!, argv.slice(1));
}

it("every native Azure collection declares the shared fetch controls, and queries and writes do not", () => {
  const collections = COMMAND_LEAVES.filter((leaf) => leaf.capability === "native" && leaf.path !== "config list" &&
    (leaf.path.endsWith(" list") || ["defender alerts", "defender assessments", "defender score", "exposure", "acr repository show-tags", "sentinel incident list-alert", "sentinel incident list-entity"].includes(leaf.path)));
  expect(collections.length).toBe(56);
  expect(collections.filter((leaf) => !("max-rows" in (leaf.flags ?? {}))).map((leaf) => leaf.path)).toEqual([]);
  expect(COMMAND_LEAVES.filter((leaf) => leaf.effect !== "read" || leaf.path.endsWith(" query"))
    .filter((leaf) => "max-rows" in (leaf.flags ?? {}))).toEqual([]);
});

it.each(remaining)("$command caps paged rows independently of full and limit, with a lower-bound total", async (entry) => {
  item = entry.item;
  graph = "graph" in entry;
  state = "state" in entry;
  const result = await run(entry.command, ["--max-rows", "2", "--limit", "1", "--full"]);
  expect(result.rows).toHaveLength(2);
  expect(result.total).toBe("2+");
  expect(JSON.stringify(result.help)).toContain("--max-rows");
  expect(pages).toBe(2);
});

it.each(remaining)("$command retains exact totals when paging ends, with display limited separately", async (entry) => {
  item = entry.item;
  graph = "graph" in entry;
  state = "state" in entry;
  endAfter = 2;
  const result = await run(entry.command, ["--limit", "1"]);
  expect(result.rows).toHaveLength(1);
  expect(result.total).toBe(2);
  expect(pages).toBe(2);
});

it.each(remaining)("$command rejects invalid budgets and unknown flags before transport", async (entry) => {
  await expect(run(entry.command, ["--max-rows", "0"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  await expect(run(entry.command, ["--max-row", "2"])).rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
  await expect(run(entry.command, ["--all=maybe"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(fetch).not.toHaveBeenCalled();
});

it("activity filters do not bypass the scanned-row budget", async () => {
  item = samples.activityEvents[0]!;
  const result = await run("activity list --caller missing", ["--max-rows", "1", "--full"]);
  expect(result.total).toBe("0+");
  expect(JSON.stringify(result.help)).toContain("lower bounds");
  expect(pages).toBe(1);
});

it.each([
  { verb: "list-alert", total: samples.sentinelIncidentAlerts.length },
  { verb: "list-entity", total: samples.sentinelIncidentEntities.entities.length },
])("Sentinel $verb caps non-paged rows locally while retaining the service total", async ({ verb, total }) => {
  const result = await run("sentinel incident " + verb + " --name " + samples.sentinelIncidents[0]!.name +
    " --resource-group rg-demo --workspace-name logs-demo", ["--max-rows", "1", "--full"]);
  expect(result.rows).toHaveLength(1);
  expect(result.total).toBe(total);
  expect(JSON.stringify(result.help)).toContain("--max-rows");
});

it("metric time-series queries reject collection fetch flags before transport", async () => {
  await expect(run("monitor metrics list --resource " + samples.monitorResource + " --metric CPU", ["--all"]))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(fetch).not.toHaveBeenCalled();
});

it("metric definition hints retain fetch controls only when expanding definitions", async () => {
  item = samples.monitorMetricDefinition;
  const result = await run("monitor metrics list --resource " + samples.monitorResource, ["--max-rows", "2", "--limit", "1"]);
  const hints = result.help as string[];
  expect(hints.find((hint) => hint.includes("values of the first metric"))).not.toContain("--max-rows");
  expect(hints.find((hint) => hint.includes("show every fetched row"))).toContain("--max-rows 2");
});
