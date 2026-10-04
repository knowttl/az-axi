import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leafHelp, COMMAND_LEAVES, type CommandLeaf } from "../src/lib/registry.js";
import { SUB_A, WORKSPACE, discoveryWorkspace, sentinelAlertRules, sentinelDataConnectors, subscriptionList } from "./samples.js";

const RULE_A = sentinelAlertRules[0]!;
const RULE_B = sentinelAlertRules[1]!;
const CONNECTOR_A = sentinelDataConnectors[0]!;

describe("built CLI sentinel alert-rule and data-connector reads offline", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "az-axi-sentinel-4c-cli-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: {
      ci: { auth: "token", subscriptions: [SUB_A] },
      alias: { auth: "token", subscriptions: [SUB_A], workspaces: { sentinel: WORKSPACE } },
    } }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  function run(argv: string[], mode = "normal", profile = "ci") {
    const stub = `
      const data = ${JSON.stringify({ discoveryWorkspace, sentinelAlertRules, sentinelDataConnectors, subscriptionList })};
      const mode = ${JSON.stringify(mode)};
      globalThis.fetch = async (url, options) => {
        process.stderr.write(JSON.stringify({url, method: options.method}) + '\\n');
        if (options.method !== 'GET') throw new Error('non-GET request');
        const path = new URL(url).pathname;
        if (mode === 'denied' && (path.includes('/alertRules') || path.includes('/dataConnectors'))) {
          return Response.json({error:{code:'AuthorizationFailed',message:'Denied'}},{status:403});
        }
        let body;
        if (path === '/subscriptions') body = {value: data.subscriptionList};
        else if (path.endsWith('/workspaces')) body = {value: mode === 'empty' ? [] : [data.discoveryWorkspace]};
        else if (path.endsWith('/alertRules')) body = {value: mode === 'empty' ? [] : data.sentinelAlertRules};
        else if (path.endsWith('/dataConnectors')) body = {value: mode === 'empty' ? [] : data.sentinelDataConnectors};
        else if (path.includes('/alertRules/')) body = data.sentinelAlertRules.find(i => path.endsWith('/' + i.name));
        else if (path.includes('/dataConnectors/')) body = data.sentinelDataConnectors.find(i => path.endsWith('/' + i.name));
        else throw new Error('unexpected offline path: ' + path);
        if (body === undefined) return Response.json({error:{code:'NotFound',message:'Missing'}},{status:404});
        return Response.json(body);
      };
    `;
    const preload = `data:text/javascript,${encodeURIComponent(stub)}`;
    return spawnSync(process.execPath, ["--import", preload, "dist/bin/az-axi.js", ...argv], {
      encoding: "utf8",
      // Git Bash must pass ARM IDs to Node without converting them to Windows paths.
      env: { ...process.env, MSYS2_ARG_CONV_EXCL: "*", AZ_AXI_CONFIG: join(dir, "config.json"), AZ_AXI_PROFILE: profile, AZ_AXI_TENANT: "", AZ_AXI_SUBSCRIPTION: "", AZ_AXI_ARM_TOKEN: "offline-token", AZ_AXI_READ_ONLY: "1", AZ_AXI_USAGE_LOG: "0" },
    });
  }
  const selectors = ["--resource-group", "rg-demo", "--workspace-name", "logs-demo"];

  it("lists rules and connectors and shows one of each by name and ARM ID", () => {
    const rules = run(["sentinel", "alert-rule", "list", ...selectors]);
    expect(rules.status, rules.stdout).toBe(0);
    expect(rules.stdout).toContain("Suspicious sign-in burst");
    expect(rules.stdout).toContain("total: 2");
    expect(rules.stderr).toContain("Microsoft.SecurityInsights/alertRules?api-version=2025-09-01");
    const rule = run(["sentinel", "alert-rule", "show", "--name", RULE_A.name, ...selectors]);
    expect(rule.status, rule.stdout).toBe(0);
    expect(decode(rule.stdout)).toMatchObject({ rule: "Suspicious sign-in burst", kind: "Scheduled" });
    expect(rule.stdout).not.toContain("never-output-this-value");
    expect(run(["sentinel", "alert-rule", "show", "--ids", RULE_A.id]).stdout).toContain("Suspicious sign-in burst");
    const connectors = run(["sentinel", "data-connector", "list", ...selectors]);
    expect(connectors.status, connectors.stdout).toBe(0);
    expect(connectors.stdout).toContain("Office365");
    expect(connectors.stdout).toContain("total: 2");
    expect(connectors.stderr).toContain("Microsoft.SecurityInsights/dataConnectors?api-version=2025-09-01");
    expect(connectors.stdout).not.toContain("never-output-this-value");
    const connector = run(["sentinel", "data-connector", "show", "--name", CONNECTOR_A.name, ...selectors]);
    expect(connector.status, connector.stdout).toBe(0);
    expect(decode(connector.stdout)).toMatchObject({ kind: "AzureActiveDirectory", types: "alerts:Connected" });
    expect(run(["sentinel", "data-connector", "show", "--ids", CONNECTOR_A.id]).stdout).toContain("AzureActiveDirectory");
  });

  it("accepts short flags and workspace aliases", () => {
    const short = run(["sentinel", "alert-rule", "list", "-g", "rg-demo", "--workspace-name", "logs-demo", "-s", SUB_A]);
    expect(short.status, short.stdout).toBe(0);
    expect(short.stdout).toContain("total: 2");
    const aliased = run(["sentinel", "data-connector", "list", "--workspace", "sentinel"], "normal", "alias");
    expect(aliased.status, aliased.stdout).toBe(0);
    expect(aliased.stdout).toContain("workspace: logs-demo");
    expect(aliased.stderr).toContain("Microsoft.OperationalInsights/workspaces?api-version=2025-07-01");
  });

  it("reports empty and access-denied output", () => {
    expect(run(["sentinel", "alert-rule", "list", ...selectors], "empty").stdout).toContain("0 alert rules found in workspace logs-demo");
    expect(run(["sentinel", "data-connector", "list", ...selectors], "empty").stdout).toContain("0 data connectors found in workspace logs-demo");
    const denied = run(["sentinel", "alert-rule", "list", ...selectors], "denied");
    expect(denied.status).toBe(2);
    expect(denied.stdout).toContain("FORBIDDEN");
  });

  it.each([
    ["sentinel", "alert-rule", "list"],
    ["sentinel", "alert-rule", "list", ...selectors, "--fields", "query"],
    ["sentinel", "alert-rule", "show", "--name", RULE_A.name],
    ["sentinel", "alert-rule", "show", "--name", RULE_A.name, ...selectors, "--ids", RULE_A.id],
    ["sentinel", "alert-rule", "show", "--ids", `${RULE_A.id}/extra`],
    ["sentinel", "alert-rule", "update", ...selectors],
    ["sentinel", "data-connector", "list"],
    ["sentinel", "data-connector", "show", "--name", CONNECTOR_A.name],
    ["sentinel", "data-connector", "show", "--ids", `${CONNECTOR_A.id}/keys`],
    ["sentinel", "data-connector", "create", ...selectors],
  ])("refuses %j without rule or connector transport", (...argv) => {
    const result = run(argv);
    expect(result.status, result.stdout).toBe(2);
    expect(result.stderr).toBe("");
  });

  it("prints leaf help matching the registry without Azure access", () => {
    for (const path of ["sentinel alert-rule list", "sentinel alert-rule show", "sentinel data-connector list", "sentinel data-connector show"]) {
      const leaf = COMMAND_LEAVES.find((entry: CommandLeaf) => entry.path === path)!;
      const result = run([...path.split(" "), "--help"]);
      expect(result.status).toBe(0);
      expect(result.stdout.trimEnd()).toBe(leafHelp(leaf, path).trimEnd());
    }
  });

  it("emits a runnable detail hint for the first rule and connector", () => {
    const rules = run(["sentinel", "alert-rule", "list", ...selectors]);
    expect(rules.status, rules.stdout).toBe(0);
    const ruleCommand = (decode(rules.stdout) as { help: string[] }).help[0]!;
    const followed = run(ruleCommand.split("`")[1]!.replace(/^az-axi /, "").split(" "));
    expect(followed.status, followed.stdout).toBe(0);
    expect(decode(followed.stdout)).toMatchObject({ name: RULE_B.name });
    const connectors = run(["sentinel", "data-connector", "list", ...selectors]);
    const connectorCommand = (decode(connectors.stdout) as { help: string[] }).help[0]!;
    const followedConnector = run(connectorCommand.split("`")[1]!.replace(/^az-axi /, "").split(" "));
    expect(followedConnector.status, followedConnector.stdout).toBe(0);
    expect(decode(followedConnector.stdout)).toMatchObject({ name: CONNECTOR_A.name });
  });
});
