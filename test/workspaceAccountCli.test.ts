import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoveryAccount, discoveryWorkspace, SUB_A, SUB_B, subscriptionList, WORKSPACE } from "./samples.js";

const workspace = ["monitor", "log-analytics", "workspace"];
describe("built CLI workspace and account reads offline", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "az-axi-workspace-account-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { ci: { auth: "token", subscriptions: [SUB_A] } } }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  function run(argv: string[], mode = "normal") {
    const stub = `
      const data = ${JSON.stringify({ discoveryAccount, discoveryWorkspace, subscriptionList })};
      const mode = ${JSON.stringify(mode)};
      globalThis.fetch = async (url, options) => {
        process.stderr.write(JSON.stringify({url, method: options.method}) + '\\n');
        if (options.method !== 'GET') throw new Error('non-GET request');
        const path = new URL(url).pathname;
        if (mode === 'missing') return Response.json({error:{code:'ResourceNotFound',message:'Missing'}},{status:404});
        let body;
        if (path === '/subscriptions') {
          const rows = mode === 'ambiguous' ? data.subscriptionList.map(s => ({...s,displayName:'Sandbox'})) : data.subscriptionList;
          body = {value: mode === 'empty' ? [] : rows};
        } else if (path.startsWith('/subscriptions/') && path.split('/').length === 3) body = data.discoveryAccount;
        else if (path.endsWith('/workspaces')) body = {value: mode === 'empty' ? [] : [data.discoveryWorkspace]};
        else if (path.endsWith('/workspaces/logs-demo')) body = data.discoveryWorkspace;
        else throw new Error('unexpected offline path: ' + path);
        if (mode === 'hostile' && path.includes('/workspaces')) {
          const item = body.value ? body.value[0] : body;
          item.properties.sharedKeys = {primarySharedKey:'opaque-key'};
          item.properties.customHeader = 'opaque-secret';
          item.properties.sku.secret = 'opaque-secret';
        }
        if ((path === '/subscriptions' || path.endsWith('/workspaces')) && mode !== 'empty') {
          body.nextLink = mode === 'cap' || !url.includes('page=2') ? url + '&page=2' : undefined;
          if (url.includes('page=2')) body.value = [];
        }
        return Response.json(body);
      };
    `;
    return spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(stub)}`, "dist/bin/az-axi.js", ...argv], {
      encoding: "utf8", env: { ...process.env, AZ_AXI_CONFIG: join(dir, "config.json"), AZ_AXI_PROFILE: "ci", AZ_AXI_TENANT: "", AZ_AXI_SUBSCRIPTION: "", AZ_AXI_ARM_TOKEN: "offline-token", AZ_AXI_READ_ONLY: "1", AZ_AXI_USAGE_LOG: "0" },
    });
  }
  it.each([{ path: ["account"] }, { path: workspace }])("lists $path across pages, resolves names, and reports empty results", ({ path }) => {
    const result = run([...path, "list", "-s", "Sandbox"]);
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain("total: 1");
    expect(result.stdout).toContain(SUB_A);
    expect(result.stderr).toContain("page=2");
    expect(run([...path, "list"], "empty").stdout).toContain("0 of 0");
  });
  it("scopes account list without changing legacy sub list", () => {
    expect(run(["account", "list"]).stdout).not.toContain(SUB_B);
    expect(run(["sub", "list"]).stdout).toContain(SUB_B);
    expect(run(["sub", "list"]).stdout).toContain("inScope");
  });
  it("shows account full metadata and requested fields", () => {
    const result = run(["account", "show", "-s", "Sandbox", "--full"]);
    expect(result.status, result.stdout).toBe(0);
    expect(decode(result.stdout)).toMatchObject({ account: { name: "Sandbox", id: SUB_A, quotaId: "PayAsYouGo" } });
    const fields = run(["account", "show", "--fields", "name,quotaId"]);
    expect(decode(fields.stdout)).toMatchObject({ account: { name: "Sandbox", quotaId: "PayAsYouGo" } });
    expect(fields.stdout).not.toContain(SUB_A);
  });
  it.each([
    ["show", "--ids", discoveryWorkspace.id],
    ["show", "--workspace-name", "logs-demo", "-g", "rg-demo"],
    ["show", "-n", "logs-demo", "-g", "rg-demo"],
    ["list", "-g", "rg-demo"],
  ])("shows only allowlisted workspace metadata with %j", (...flags) => {
    const result = run([...workspace, ...flags, "--full"], "hostile");
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain(WORKSPACE);
    expect(result.stdout).toContain("retentionInDays");
    expect(result.stdout).not.toMatch(/opaque-|sharedKeys|customHeader/);
    expect(result.stderr).toContain("api-version=2025-07-01");
    expect(result.stderr).toContain(`/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.OperationalInsights/workspaces`);
  });
  it("selects workspace metadata fields without widening the projection", () => {
    const result = run([...workspace, "show", "--ids", discoveryWorkspace.id, "--fields", "customerId,state"], "hostile");
    expect(decode(result.stdout)).toEqual({ profile: "ci", workspace: { customerId: WORKSPACE, state: "Succeeded" } });
  });
  it.each([{ path: ["account"] }, { path: workspace }])("discloses capped paging for $path", ({ path }) => {
    const result = run([...path, "list"], "cap");
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain("total: 1+");
    expect(result.stdout).toContain("Counts are lower bounds");
  });
  it("reports truncation and full escape with the selected account scope", () => {
    const result = run(["account", "list", "-s", SUB_A, SUB_B, "--limit", "1"]);
    expect(result.stdout).toContain("1 of 2 subscriptions");
    expect(run(["account", "list", "-s", SUB_A, SUB_B, "--full"]).stdout).toContain("2 of 2 subscriptions");
  });
  it.each([
    ["account", "show", "-s", SUB_A, SUB_B],
    ["account", "list", "--execute"],
    ["account", "list", "--fields", "accessToken"],
    ["account", "list", "--management-group", "root"],
    [...workspace, "show"],
    [...workspace, "show", "--ids", discoveryWorkspace.id + "/sharedKeys"],
    [...workspace, "show", "--ids", discoveryWorkspace.id + "/listKeys"],
    [...workspace, "show", "--ids", discoveryWorkspace.id, "-s", SUB_B],
    [...workspace, "show", "--ids", discoveryWorkspace.id, "-n", "logs-demo"],
    [...workspace, "show", "--workspace-name", "logs-demo/listKeys", "-g", "rg-demo"],
    [...workspace, "show", "--workspace-name", "logs-demo", "-n", "different", "-g", "rg-demo"],
    [...workspace, "list", "--fields", "properties"],
    [...workspace, "list", "--limit", "0"],
    [...workspace, "list", "--output", "json"],
  ])("refuses %j without transport", (...argv) => {
    const result = run(argv);
    expect(result.status, result.stdout).toBe(2);
    expect(result.stderr).toBe("");
  });
  it.each([{ argv: ["account", "show"] }, { argv: [...workspace, "show", "--ids", discoveryWorkspace.id] }])("reports a missing target for $argv", ({ argv }) => {
    const result = run(argv, "missing");
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("NOT_FOUND");
  });
  it("refuses ambiguous subscription names before workspace transport", () => {
    const result = run([...workspace, "list", "-s", "Sandbox"], "ambiguous");
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("matched 3 subscriptions");
    expect(result.stderr).not.toContain("OperationalInsights");
  });
});
