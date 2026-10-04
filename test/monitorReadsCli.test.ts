import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SUB_A,
  monitorActionGroup,
  monitorActionGroups,
  monitorAlertRule,
  monitorAlertRules,
  monitorDiagnosticSetting,
  monitorDiagnosticSettings,
  monitorMetricDefinitions,
  monitorMetricValues,
  monitorResource,
  subscriptionList,
} from "./samples.js";

describe("built CLI Monitor reads offline", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "az-axi-monitor-cli-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: {
      ci: { auth: "token", subscriptions: [SUB_A] },
    } }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  function run(argv: string[], mode = "normal") {
    const stub = `
      const data = ${JSON.stringify({
        monitorAlertRules, monitorActionGroups, monitorDiagnosticSettings,
        monitorMetricDefinitions, monitorMetricValues, subscriptionList,
      })};
      const mode = ${JSON.stringify(mode)};
      if (mode === 'secrets') {
        data.monitorAlertRules[0].properties.actions = [{ actionGroupId: data.monitorAlertRules[0].properties.actions[0].actionGroupId,
          webHookProperties: { token: 'never-output-this-value', password: 'never-output-this-value' } }];
        data.monitorActionGroups[0].properties.webhookReceivers = [{ name: 'hook',
          serviceUri: 'https://hooks.contoso.com/alerts?code=never-output-this-value#never-output-this-value',
          properties: { token: 'never-output-this-value' } }];
        data.monitorActionGroups[0].properties.logicAppReceivers = [{ name: 'logic',
          resourceId: '/subscriptions/xxx/resourceGroups/rg/providers/Microsoft.Logic/workflows/wf',
          callbackUrl: 'https://prod.contoso.com:443/workflows/xxx/triggers/manual?sig=never-output-this-value' }];
        data.monitorActionGroups[0].properties.azureFunctionReceivers = [{ name: 'fn',
          functionAppResourceId: '/subscriptions/xxx/resourceGroups/rg/providers/Microsoft.Web/sites/fn',
          functionName: 'alert', httpTriggerUrl: 'https://fn.contoso.com/api/alert?code=never-output-this-value' }];
      }
      const itemsFor = (path) => {
        if (path === '/subscriptions') return data.subscriptionList;
        if (path.endsWith('/metricAlerts')) return mode === 'empty' ? [] : data.monitorAlertRules;
        if (path.endsWith('/actionGroups')) return mode === 'empty' ? [] : data.monitorActionGroups;
        if (path.endsWith('/diagnosticSettings')) return mode === 'empty' ? [] : data.monitorDiagnosticSettings;
        if (path.endsWith('/metricDefinitions')) return mode === 'empty' ? [] : data.monitorMetricDefinitions;
        return undefined;
      };
      globalThis.fetch = async (url, options) => {
        process.stderr.write(JSON.stringify({url, method: options.method}) + '\\n');
        const path = new URL(url).pathname;
        if (path.endsWith('/metrics')) {
          if (options.method !== 'GET') throw new Error('metrics values must GET');
          return Response.json(mode === 'empty' ? { value: [] } : data.monitorMetricValues);
        }
        if (options.method !== 'GET') throw new Error('non-GET request');
        const items = itemsFor(path);
        if (items) return Response.json({value: items});
        const all = [...data.monitorAlertRules, ...data.monitorActionGroups, ...data.monitorDiagnosticSettings];
        const found = all.find((item) => item.id.toLowerCase() === path.toLowerCase());
        if (!found) return Response.json({error:{code:'NotFound',message:'Missing'}},{status:404});
        return Response.json(found);
      };
    `;
    const preload = `data:text/javascript,${encodeURIComponent(stub)}`;
    return spawnSync(process.execPath, ["--import", preload, "dist/bin/az-axi.js", ...argv], {
      encoding: "utf8",
      // Git Bash must pass ARM IDs to Node without converting them to Windows paths.
      env: { ...process.env, MSYS2_ARG_CONV_EXCL: "*", AZ_AXI_CONFIG: join(dir, "config.json"), AZ_AXI_PROFILE: "ci", AZ_AXI_TENANT: "", AZ_AXI_SUBSCRIPTION: "", AZ_AXI_ARM_TOKEN: "offline-token", AZ_AXI_READ_ONLY: "1", AZ_AXI_USAGE_LOG: "0" },
    });
  }
  const group = ["--resource-group", "rg-demo"];

  it("lists metric alert rules and shows one by name and ARM ID", () => {
    const rules = run(["monitor", "metrics", "alert", "list", ...group]);
    expect(rules.status, rules.stdout).toBe(0);
    expect(rules.stdout).toContain("high-cpu");
    expect(rules.stdout).toContain("total: 2");
    expect(rules.stderr).toContain("Microsoft.Insights/metricAlerts?api-version=2026-01-01");
    const rule = run(["monitor", "metrics", "alert", "show", "--name", "high-cpu", ...group]);
    expect(rule.status, rule.stdout).toBe(0);
    expect(decode(rule.stdout)).toMatchObject({ severity: 3, enabled: true });
    expect(run(["monitor", "metrics", "alert", "show", "--ids", monitorAlertRule.id]).stdout).toContain("Percentage CPU");
  });

  it("lists action groups and shows webhook receivers without secrets", () => {
    const groups = run(["monitor", "action-group", "list", ...group]);
    expect(groups.status, groups.stdout).toBe(0);
    expect(groups.stdout).toContain("ag-demo");
    expect(groups.stderr).toContain("Microsoft.Insights/actionGroups?api-version=2023-01-01");
    const shown = run(["monitor", "action-group", "show", "--name", "ag-demo", ...group, "--full"]);
    expect(shown.status, shown.stdout).toBe(0);
    expect(decode(shown.stdout)).toMatchObject({ shortName: "agdemo", enabled: true });
  });

  it("keeps webhook secrets out of compact and full alert and action-group output", () => {
    for (const argv of [
      ["monitor", "metrics", "alert", "list"],
      ["monitor", "metrics", "alert", "list", "--full"],
      ["monitor", "metrics", "alert", "show", "--ids", monitorAlertRule.id],
      ["monitor", "metrics", "alert", "show", "--ids", monitorAlertRule.id, "--full"],
      ["monitor", "action-group", "list"],
      ["monitor", "action-group", "list", "--full"],
      ["monitor", "action-group", "show", "--ids", monitorActionGroup.id],
      ["monitor", "action-group", "show", "--ids", monitorActionGroup.id, "--full"],
    ]) {
      const result = run(argv, "secrets");
      expect(result.status, `${argv.join(" ")}: ${result.stdout}`).toBe(0);
      expect(result.stdout, argv.join(" ")).not.toContain("never-output-this-value");
    }
    const shown = decode(run(["monitor", "action-group", "show", "--ids", monitorActionGroup.id, "--full"], "secrets").stdout) as {
      receivers: Array<{ type: string; uri?: string; properties?: string[] }>;
    };
    const webhook = shown.receivers.find((receiver) => receiver.type === "webhook");
    expect(webhook?.uri).toBe("https://hooks.contoso.com/alerts");
    expect(webhook?.properties).toEqual(["token"]);
  });

  it("lists diagnostic settings for one resource and shows one by name and ARM ID", () => {
    const settings = run(["monitor", "diagnostic-settings", "list", "--resource", monitorResource]);
    expect(settings.status, settings.stdout).toBe(0);
    expect(settings.stdout).toContain("to-hub");
    expect(settings.stdout).toContain("total: 1");
    expect(settings.stderr).toContain("Microsoft.Insights/diagnosticSettings?api-version=2021-05-01-preview");
    const setting = run(["monitor", "diagnostic-settings", "show", "--resource", monitorResource, "--name", "to-hub"]);
    expect(setting.status, setting.stdout).toBe(0);
    expect(decode(setting.stdout)).toMatchObject({ storage: expect.stringContaining("stdemo") });
    expect(run(["monitor", "diagnostic-settings", "show", "--ids", monitorDiagnosticSetting.id]).stdout).toContain("to-hub");
  });

  it("lists metric definitions without --metric and values with --metric", () => {
    const definitions = run(["monitor", "metrics", "list", "--resource", monitorResource]);
    expect(definitions.status, definitions.stdout).toBe(0);
    expect(definitions.stdout).toContain("Percentage CPU");
    expect(definitions.stdout).toContain("total: 2");
    expect(definitions.stderr).toContain("Microsoft.Insights/metricDefinitions?api-version=2024-02-01");
    const values = run(["monitor", "metrics", "list", "--resource", monitorResource,
      "--metric", "Percentage CPU", "--start-time", "2026-10-04T00:00:00Z", "--end-time", "2026-10-04T01:00:00Z"]);
    expect(values.status, values.stdout).toBe(0);
    expect(decode(values.stdout)).toMatchObject({ total: 1 });
    expect(values.stderr).toContain("metricnames=Percentage+CPU");
    expect(values.stderr).toContain("Microsoft.Insights/metrics?");
  });

  it("reports empty Monitor collections explicitly", () => {
    for (const argv of [
      ["monitor", "metrics", "alert", "list"],
      ["monitor", "action-group", "list"],
      ["monitor", "diagnostic-settings", "list", "--resource", monitorResource],
      ["monitor", "metrics", "list", "--resource", monitorResource],
      ["monitor", "metrics", "list", "--resource", monitorResource, "--metric", "Percentage CPU"],
    ]) {
      const result = run(argv, "empty");
      expect(result.status, argv.join(" ")).toBe(0);
      expect(result.stdout, argv.join(" ")).toContain("total: 0");
    }
  });

  it("refuses unbounded or malformed metric windows and selectors before any request", () => {
    const missing = run(["monitor", "metrics", "list"]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toBe("");
    const badStart = run(["monitor", "metrics", "list", "--resource", monitorResource,
      "--metric", "Percentage CPU", "--start-time", "yesterday"]);
    expect(badStart.status).toBe(2);
    const reversed = run(["monitor", "metrics", "list", "--resource", monitorResource,
      "--metric", "Percentage CPU", "--start-time", "2026-10-04T01:00:00Z", "--end-time", "2026-10-04T00:00:00Z"]);
    expect(reversed.status).toBe(2);
    const wide = run(["monitor", "metrics", "list", "--resource", monitorResource,
      "--metric", "Percentage CPU", "--start-time", "2026-09-01T00:00:00Z", "--end-time", "2026-10-04T00:00:00Z"]);
    expect(wide.status).toBe(2);
    const badAggregation = run(["monitor", "metrics", "list", "--resource", monitorResource,
      "--metric", "Percentage CPU", "--aggregation", "Median"]);
    expect(badAggregation.status).toBe(2);
    const subScope = run(["monitor", "metrics", "list", "--resource", `/subscriptions/${SUB_A}`]);
    expect(subScope.status).toBe(2);
    const badResource = run(["monitor", "diagnostic-settings", "list", "--resource", "not-an-id"]);
    expect(badResource.status).toBe(2);
    const nameless = run(["monitor", "metrics", "alert", "show", "--resource-group", "rg-demo"]);
    expect(nameless.status).toBe(2);
    for (const result of [missing, badStart, reversed, wide, badAggregation, subScope, badResource, nameless]) {
      expect(result.stderr, result.stdout).toBe("");
    }
  });

  it("rejects unknown flags before any request", () => {
    const result = run(["monitor", "metrics", "list", "--resource", monitorResource, "--offset", "24h"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("unknown flag");
  });
});
