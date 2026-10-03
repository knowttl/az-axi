import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SUB_A, SUB_B, WORKSPACE, activityEvents, defenderAlerts, defenderScores,
  graphNames, logsResponse, rbacAssignments, resourceGraphPage, subscriptionList,
} from "./samples.js";

describe("built CLI exact-leaf routing with fake transport", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "az-axi-router-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { ci: { auth: "token", subscriptions: [SUB_A] } } }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(args: string[], input = "", graphPage: Record<string, unknown> = resourceGraphPage) {
    const payloads = { activityEvents, defenderAlerts, defenderScores, graphNames, logsResponse, rbacAssignments, resourceGraphPage: graphPage, subscriptionList };
    const stub = `
      const data = ${JSON.stringify(payloads)};
      const RealDate = Date;
      globalThis.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : ['2026-10-03T12:00:00Z'])); }
        static now() { return RealDate.parse('2026-10-03T12:00:00Z'); }
      };
      globalThis.fetch = async (url, options) => {
        const body = options.body ? JSON.parse(options.body) : undefined;
        process.stderr.write(JSON.stringify({url, method: options.method, body}) + '\\n');
        const query = body?.query || '';
        const result = url.includes('graph.microsoft.com') ? data.graphNames
          : url.includes('api.loganalytics.io') ? data.logsResponse
          : url.includes('/eventtypes/') ? {value: data.activityEvents}
          : url.includes('/alerts') ? {value: data.defenderAlerts}
          : url.includes('/subscriptions?') ? {value: data.subscriptionList}
          : query.includes('roleassignments') ? {totalRecords: data.rbacAssignments.length, data: data.rbacAssignments}
          : query.includes('securescores') ? {totalRecords: data.defenderScores.length, data: data.defenderScores}
          : data.resourceGraphPage;
        return new Response(JSON.stringify(result), {headers: {'content-type': 'application/json'}});
      };
    `;
    return spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(stub)}`, "dist/bin/az-axi.js", ...args], {
      encoding: "utf8", input, env: {
        ...process.env, AZ_AXI_CONFIG: join(dir, "config.json"), AZ_AXI_PROFILE: "ci",
        AZ_AXI_ARM_TOKEN: "router-token", AZ_AXI_GRAPH_TOKEN: "router-token", AZ_AXI_LOGS_TOKEN: "router-token",
        AZ_AXI_SUBSCRIPTION: "", AZ_AXI_READ_ONLY: "1",
      },
    });
  }

  it.each([
    { legacy: ["rbac", "list"], native: ["role", "assignment", "list"], flags: ["--full"] },
    { legacy: ["activity", "list", "--since", "24h"], native: ["monitor", "activity-log", "list", "--offset", "24h"], flags: ["--full"] },
    { legacy: ["defender", "alerts"], native: ["security", "alert", "list"], flags: ["--full", "--severity", "High"] },
    { legacy: ["defender", "score"], native: ["security", "secure-scores", "list"], flags: ["--full"] },
    { legacy: ["rg", "query", "Resources | take 5"], native: ["graph", "query", "-q", "Resources | take 5"], flags: ["--fields", "name", "--limit", "2"] },
    { legacy: ["logs", "query", "Heartbeat", "--workspace", WORKSPACE], native: ["monitor", "log-analytics", "query", "--analytics-query", "Heartbeat", "-w", WORKSPACE], flags: ["--full", "--limit", "2"] },
  ])("$native preserves legacy output and operations", ({ legacy, native, flags }) => {
    const oldResult = run([...legacy, ...flags]);
    const newResult = run([...native, ...flags]);
    expect(oldResult.status).toBe(0);
    expect(newResult.status).toBe(0);
    expect(newResult.stdout).toBe(oldResult.stdout);
    expect(newResult.stderr).toBe(oldResult.stderr);
    expect(newResult.stderr).toContain('"url":');
  });

  it("keeps profile scope and the 50-row Graph default instead of az's all-accessible default", () => {
    const result = run(["graph", "query", "--graph-query", "Resources"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`"subscriptions":["${SUB_A}"]`);
    expect(result.stderr).toContain('"$top":50');
    const help = run(["graph", "query", "--help"]);
    expect(help.stdout).toContain("Azure CLI defaults to all accessible subscriptions");
  });

  it("keeps profile management-group precedence unless explicit subscriptions select the scope", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { ci: { auth: "token", managementGroup: "parent", subscriptions: [SUB_A] } } }));
    const defaultScope = run(["graph", "query", "-q", "Resources"]);
    expect(defaultScope.status).toBe(0);
    expect(defaultScope.stderr).toContain('"managementGroups":["parent"]');
    expect(defaultScope.stderr).not.toContain('"subscriptions":');
    const explicitScope = run(["graph", "query", "-q", "Resources", "--subscriptions", SUB_B]);
    expect(explicitScope.status).toBe(0);
    expect(explicitScope.stderr).toContain(`"subscriptions":["${SUB_B}"]`);
    expect(explicitScope.stderr).not.toContain('"managementGroups":');
  });

  it("queries all accessible subscriptions only when neither flags nor profile specify scope", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { ci: { auth: "token" } } }));
    const result = run(["graph", "query", "-q", "Resources"]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('"subscriptions":');
    expect(result.stderr).not.toContain('"managementGroups":');
  });

  it("maps Graph plural subscription scope and --first onto the existing request", () => {
    const native = run(["graph", "query", "-q", "Resources", "--subscriptions", SUB_A, SUB_B, "--first", "2"]);
    const legacy = run(["rg", "query", "Resources", "--subscription", `${SUB_A},${SUB_B}`, "--limit", "2"]);
    expect(native.status).toBe(0);
    expect(native.stdout).toBe(legacy.stdout);
    expect(native.stderr).toBe(legacy.stderr);
  });

  it("retains the legacy 1000-row full Graph page even with --first", () => {
    const result = run(["graph", "query", "-q", "Resources", "--full", "--first", "2"]);
    const legacy = run(["rg", "query", "Resources", "--full", "--limit", "2"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(legacy.stdout);
    expect(result.stderr).toBe(legacy.stderr);
    expect(result.stderr).toContain('"$top":1000');
  });

  it("sends all explicitly selected management groups and preserves them in pagination hints", () => {
    const result = run(["graph", "query", "-q", "Resources", "--management-groups", "parent", "other"], "", { ...resourceGraphPage, $skipToken: "next-page" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('"managementGroups":["parent","other"]');
    expect(result.stderr).not.toContain('"subscriptions":');
    expect(result.stdout).toContain("--management-groups parent,other");
    const next = run(["graph", "query", "--graph-query", "Resources", "--management-groups", "parent,other", "--skip-token", "next-page"]);
    expect(next.status).toBe(0);
    expect(next.stderr).toContain('"$skipToken":"next-page"');
    expect(next.stderr).toContain('"managementGroups":["parent","other"]');
  });

  it("retains P1D in the request and TOON instead of az's all-available log timespan", () => {
    const result = run(["monitor", "log-analytics", "query", "--analytics-query", "Heartbeat", "-w", WORKSPACE]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('"timespan":"P1D"');
    expect(result.stdout).toContain("timespan: P1D");
    expect(run(["monitor", "log-analytics", "query", "--help"]).stdout).toContain("Azure CLI defaults to all available data");
  });

  it.each([
    { path: ["graph", "query"], legacy: ["rg", "query"], query: "Resources" },
    { path: ["monitor", "log-analytics", "query", "-w", WORKSPACE], legacy: ["logs", "query", "--workspace", WORKSPACE], query: "Heartbeat" },
  ])("reads a KQL file on $path with unchanged output", ({ path, legacy, query }) => {
    const file = join(dir, "query.kql");
    writeFileSync(file, query);
    const result = run([...path, "--file", file]);
    const oldResult = run([...legacy, "--file", file]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(oldResult.stdout);
    expect(result.stderr).toBe(oldResult.stderr);
  });

  it.each([
    { path: ["graph", "query"], legacy: ["rg", "query"], query: "Resources" },
    { path: ["monitor", "log-analytics", "query", "-w", WORKSPACE], legacy: ["logs", "query", "--workspace", WORKSPACE], query: "Heartbeat" },
  ])("reads stdin on $path with unchanged output", ({ path, legacy, query }) => {
    const result = run(path, `${query}\n`);
    const oldResult = run(legacy, `${query}\n`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(oldResult.stdout);
    expect(result.stderr).toBe(oldResult.stderr);
  });

  it("maps short flags and repeated space/comma lists to the original scope", () => {
    const oldResult = run(["rbac", "list", "--subscription", `${SUB_A},${SUB_B}`, "--privileged=false", "--full"]);
    const newResult = run(["-s", SUB_A, "role", "assignment", "list", "--subscription", SUB_B, "--privileged", "false", "--full", "true"]);
    expect(newResult.status).toBe(0);
    // Leading selectors retain their position after normalization, so use an
    // explicit list to verify the ordering of the effective request scope.
    const listResult = run(["role", "assignment", "list", "-s", SUB_A, SUB_B, "--privileged=false", "--full"]);
    expect(listResult.stdout).toBe(oldResult.stdout);
    expect(listResult.stderr).toBe(oldResult.stderr);
    expect(newResult.stderr).toContain(SUB_A);
    expect(newResult.stderr).toContain(SUB_B);
  });

  it("keeps rg query as Resource Graph and handles -- plus workspace/time short flags", () => {
    const rg = run(["rg", "query", "--", "Resources | take 1"]);
    expect(rg.status).toBe(0);
    expect(rg.stderr).toContain("Microsoft.ResourceGraph/resources");
    const beforeQuery = run(["rg", "query", "--subscription", SUB_A, "--fields", "name", "Resources | take 1"]);
    const afterQuery = run(["rg", "query", "Resources | take 1", "--subscription", SUB_A, "--fields", "name"]);
    expect(beforeQuery.status).toBe(0);
    expect(beforeQuery.stdout).toBe(afterQuery.stdout);
    expect(beforeQuery.stderr).toBe(afterQuery.stderr);
    const oldResult = run(["logs", "query", "--workspace", WORKSPACE, "--timespan", "P1D", "--", "--help"]);
    const shortResult = run(["logs", "query", "-w", WORKSPACE, "-t", "P1D", "--", "--help"]);
    expect(shortResult.status).toBe(0);
    expect(shortResult.stdout).toBe(oldResult.stdout);
    expect(shortResult.stderr).toBe(oldResult.stderr);
    expect(shortResult.stderr).toContain('"query":"--help"');
  });

  it("maps assignee and resource-group short flags without changing native filters", () => {
    const oldRole = run(["rbac", "list", "--principal", "00000000-0000-0000-0000-000000000040", "--full"]);
    const newRole = run(["role", "assignment", "list", "--assignee", "00000000-0000-0000-0000-000000000040", "--full"]);
    expect(newRole.status).toBe(0);
    expect(newRole.stdout).toBe(oldRole.stdout);
    expect(newRole.stderr).toBe(oldRole.stderr);
    const oldActivity = run(["activity", "list", "--resource-group", "rg-demo"]);
    const newActivity = run(["monitor", "activity-log", "list", "-g", "rg-demo"]);
    expect(newActivity.status).toBe(0);
    expect(newActivity.stdout).toBe(oldActivity.stdout);
    expect(newActivity.stderr).toBe(oldActivity.stderr);
  });

  it("preserves negative inline JSON numbers as flag values", () => {
    const result = run(["api", "POST", "/providers/Microsoft.ResourceGraph/resources", "--api-version", "2024-04-01", "--body", "-1"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('"body":-1');
  });

  it("accepts the name short flag for local profile initialization", () => {
    const result = run(["config", "init", "-n", "added", "--auth", "token"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("added");
    expect(result.stderr).toBe("");
  });

  it.each([
    ["graph", "query", "-q"],
    ["graph", "query"],
    ["graph", "query", "-q", "Resources", "--file", "query.kql"],
    ["graph", "query", "-q", "Resources", "extra"],
    ["graph", "query", "-q", "Resources", "--graph-query", "Other"],
    ["graph", "query", "-q", "Resources", "--first", "2", "--limit", "3"],
    ["graph", "query", "-q", "Resources", "--subscriptions", SUB_A, "--management-groups", "parent"],
    ["graph", "query", "-q", "Resources", "--skip", "1"],
    ["graph", "query", "-q", "Resources", "--allow-partial-scopes"],
    ["graph", "query", "--query", "Resources"],
    ["rg", "query", "-q", "Resources"],
    ["monitor", "log-analytics", "query", "--analytics-query"],
    ["monitor", "log-analytics", "query", "--analytics-query", "Heartbeat"],
    ["monitor", "log-analytics", "query", "--analytics-query", "Heartbeat", "-w", WORKSPACE, "--workspaces", WORKSPACE],
    ["logs", "query", "--analytics-query", "Heartbeat", "-w", WORKSPACE],
    ["role", "assignment"],
    ["role", "assignment", "lis"],
    ["security", "alert", "list", "--bogus"],
    ["security", "alert", "list", "--status"],
    ["security", "alert", "list", "--severity", ""],
    ["security", "alert", "list", "--severity", ",,"],
    ["role", "assignment", "list", "--privileged=maybe"],
    ["role", "assignment", "list", "--privileged", "--privileged=false"],
    ["role", "assignment", "list", "--profile", "ci", "--profile", "other"],
    ["role", "assignment", "list", "--principal", "a", "--assignee", "b"],
    ["monitor", "activity-log", "list", "--since", "24h", "--offset", "7d"],
    ["role", "assignment", "list", "-p", "ci"],
    ["role", "assignment", "list", "-profile", "ci"],
    ["security", "alert", "list", "-hs"],
    ["security", "alert", "list", "--query", "x"],
    ["security", "alert", "list", "--output", "json"],
    ["security", "alert", "list", "--profile", "--full"],
    ["role", "assignment", "list", "-s"],
    ["defender", "alerts", "get", "--severity", "High"],
    ["api", "DELETE", "/subscriptions/x/resourceGroups/rg-demo", "--api-version", "1", "--execute"],
  ])("refuses %j before any fetch", (...argv) => {
    const result = run(argv);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("code:");
    expect(result.stderr).toBe("");
  });
});
