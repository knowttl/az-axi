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

  function run(args: string[]) {
    const payloads = { activityEvents, defenderAlerts, defenderScores, graphNames, logsResponse, rbacAssignments, resourceGraphPage, subscriptionList };
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
      encoding: "utf8", input: "", env: {
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
  ])("$native preserves legacy output and operations", ({ legacy, native, flags }) => {
    const oldResult = run([...legacy, ...flags]);
    const newResult = run([...native, ...flags]);
    expect(oldResult.status).toBe(0);
    expect(newResult.status).toBe(0);
    expect(newResult.stdout).toBe(oldResult.stdout);
    expect(newResult.stderr).toBe(oldResult.stderr);
    expect(newResult.stderr).toContain('"url":');
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
