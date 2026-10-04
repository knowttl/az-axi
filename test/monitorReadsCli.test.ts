import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SUB_A,
  SUB_B,
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
  function run(argv: string[] | string, mode = "normal") {
    const stub = `
      const data = ${JSON.stringify({
        monitorAlertRules, monitorActionGroups, monitorDiagnosticSettings,
        monitorMetricDefinitions, monitorMetricValues, subscriptionList,
      })};
      const mode = ${JSON.stringify(mode)};
      if (mode === 'prose') {
        data.monitorAlertRules[0].properties.description = 'CPU: overloaded? Restart the worker; Note: incident#123';
      }
      if (mode === 'aggregations') {
        data.monitorMetricValues.value[0].errorCode = 'Success';
        data.monitorMetricValues.value[0].timeseries[0].data = [
          { timeStamp: '2026-10-04T00:00:00Z', maximum: 95 },
          { timeStamp: '2026-10-04T01:00:00Z', average: 12, maximum: 90, minimum: 0, total: 102, count: 2 },
        ];
      }
      if (mode === 'failed' || mode === 'mixed') {
        const failure = { name: { value: 'Broken Metric' }, errorCode: 'InvalidSamplingType',
          errorMessage: 'Maximum is unsupported', timeseries: [] };
        data.monitorMetricValues.value = mode === 'failed' ? [failure] : [...data.monitorMetricValues.value, failure];
      }
      if (mode === 'diagnostic-groups') {
        data.monitorDiagnosticSettings[0].properties.logs = [{ categoryGroup: 'allLogs', enabled: true }];
        data.monitorDiagnosticSettings[0].properties.metrics = [{ categoryGroup: 'allMetrics', enabled: true }];
      }
      if (mode === 'partner') {
        data.monitorDiagnosticSettings[0].properties = { marketplacePartnerId: '/providers/Microsoft.Partner/partners/example' };
      }
      if (mode === 'two-settings') {
        data.monitorDiagnosticSettings.push({ ...data.monitorDiagnosticSettings[0], name: 'second',
          id: data.monitorDiagnosticSettings[0].id.replace('to-hub', 'second') });
      }
      if (mode === 'secrets') {
        data.monitorAlertRules[0].properties.actions = [{ actionGroupId: data.monitorAlertRules[0].properties.actions[0].actionGroupId,
          webHookProperties: { token: 'never-output-this-value', password: 'never-output-this-value' } }];
        data.monitorActionGroups[0].properties.webhookReceivers = [{ name: 'hook',
          serviceUri: 'https://never-output-this-user:never-output-this-password@hooks.contoso.com/alerts?code=never-output-this-value#never-output-this-value',
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
        if (items && (mode === 'paged' || mode === 'paged-empty')) {
          return Response.json({ value: mode === 'paged-empty' ? [] : items, nextLink: url });
        }
        if (items) return Response.json({value: items});
        const all = [...data.monitorAlertRules, ...data.monitorActionGroups, ...data.monitorDiagnosticSettings];
        const found = all.find((item) => item.id.toLowerCase() === path.toLowerCase());
        if (!found) return Response.json({error:{code:'NotFound',message:'Missing'}},{status:404});
        return Response.json(found);
      };
    `;
    const preload = `data:text/javascript,${encodeURIComponent(stub)}`;
    const command = typeof argv === "string" ? "sh" : process.execPath;
    const commandArgs = typeof argv === "string"
      ? ["-c", `exec "$1" --import "$2" "$3" ${argv}`, "monitor-hint", process.execPath, preload, "dist/bin/az-axi.js"]
      : ["--import", preload, "dist/bin/az-axi.js", ...argv];
    return spawnSync(command, commandArgs, {
      encoding: "utf8",
      // Git Bash must pass ARM IDs to Node without converting them to Windows paths.
      env: { ...process.env, MSYS2_ARG_CONV_EXCL: "*", AZ_AXI_CONFIG: join(dir, "config.json"), AZ_AXI_PROFILE: "ci", AZ_AXI_TENANT: "", AZ_AXI_SUBSCRIPTION: "", AZ_AXI_ARM_TOKEN: "offline-token", AZ_AXI_READ_ONLY: "1", AZ_AXI_USAGE_LOG: "0" },
    });
  }
  const group = ["--resource-group", "rg-demo"];
  const metrics = ["monitor", "metrics", "list", "--resource", monitorResource];
  const window = ["--start-time", "2026-10-04T00:00:00Z", "--end-time", "2026-10-04T01:00:00Z",
    "--interval", "PT1H", "--aggregation", "Average,Maximum"];

  it.each([
    ["diagnostic list", ["monitor", "diagnostic-settings", "list", "--resource", monitorResource]],
    ["diagnostic show", ["monitor", "diagnostic-settings", "show", "--name", "to-hub", "--resource", monitorResource]],
    ["diagnostic ID", ["monitor", "diagnostic-settings", "show", "--ids", monitorDiagnosticSetting.id]],
    ["metric definitions", metrics],
    ["metric values", ["monitor", "metrics", "list", "--metric", "Percentage CPU", "--resource", monitorResource]],
    ["alert ID", ["monitor", "metrics", "alert", "show", "--ids", monitorAlertRule.id]],
    ["action-group ID", ["monitor", "action-group", "show", "--ids", monitorActionGroup.id]],
  ].flatMap(([name, argv]) => ["\t", "\n", "\r"].map((control) => ({ name, argv: argv as string[], control }))))(
    "rejects URL-stripped controls before transport for $name with $control", ({ argv, control }) => {
      const escaped = argv.at(-1)!.replace(`/subscriptions/${SUB_A}`, `/subscriptions/${SUB_A}/.${control}./${SUB_B}`);
      const result = run([...argv.slice(0, -1), escaped]);
      expect(result.status).toBe(2);
      expect(result.stdout).toContain("must be one ARM");
      expect(result.stderr).toBe("");
    },
  );

  it.each([
    { noun: "metric definitions", argv: metrics, mode: "paged", total: "200+", shown: 1 },
    { noun: "metric definitions", argv: [...metrics, "--full"], mode: "paged", total: "200+", shown: 200 },
    { noun: "metric definitions", argv: metrics, mode: "paged-empty", total: "0+", shown: 0 },
    { noun: "metric definitions", argv: [...metrics, "--full"], mode: "paged-empty", total: "0+", shown: 0 },
    { noun: "diagnostic settings", argv: ["monitor", "diagnostic-settings", "list", "--resource", monitorResource], mode: "paged", total: "100+", shown: 1 },
    { noun: "diagnostic settings", argv: ["monitor", "diagnostic-settings", "list", "--resource", monitorResource, "--full"], mode: "paged", total: "100+", shown: 100 },
    { noun: "diagnostic settings", argv: ["monitor", "diagnostic-settings", "list", "--resource", monitorResource], mode: "paged-empty", total: "0+", shown: 0 },
    { noun: "diagnostic settings", argv: ["monitor", "diagnostic-settings", "list", "--resource", monitorResource, "--full"], mode: "paged-empty", total: "0+", shown: 0 },
  ])("discloses capped paging for $noun with $mode and $shown displayed", ({ noun, argv, mode, total, shown }) => {
    const result = run([...argv, "--limit", "1"], mode);
    expect(result.status, result.stdout).toBe(0);
    expect(decode(result.stdout)).toMatchObject({ total, count: `${shown} of ${total} ${noun}`,
      help: expect.arrayContaining(["More pages exist; paging stopped early. Counts are lower bounds. Narrow the target resource."]),
    });
    expect(result.stderr.match(/"method":"GET"/g)).toHaveLength(100);
  });

  it("discloses that capped empty metric pages are incomplete", () => {
    const result = run(metrics, "paged-empty");
    expect(decode(result.stdout)).toMatchObject({ rows: expect.stringContaining("in fetched pages; listing is incomplete") });
  });

  it.each([
    ["diagnostic list", ["monitor", "diagnostic-settings", "list", "--resource"]],
    ["diagnostic show", ["monitor", "diagnostic-settings", "show", "--name", "to-hub", "--resource"]],
    ["diagnostic ID", ["monitor", "diagnostic-settings", "show", "--ids"]],
    ["metric definitions", ["monitor", "metrics", "list", "--resource"]],
    ["metric values", ["monitor", "metrics", "list", "--metric", "Percentage CPU", "--resource"]],
  ])("rejects dot-segment subscription escapes before transport for %s", (_name, argv) => {
    const escape = monitorResource.replace(`/subscriptions/${SUB_A}`, `/subscriptions/${SUB_A}/../${SUB_B}`);
    const result = run([...argv, `${escape}/providers/Microsoft.Insights/diagnosticSettings/to-hub`]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("must not contain dot segments");
    expect(result.stderr).toBe("");
  });

  it.each([
    ["monitor", "metrics", "alert", "show", "--ids", monitorAlertRule.id.replace("rg-demo", ".")],
    ["monitor", "action-group", "show", "--ids", monitorActionGroup.id.replace("ag-demo", "..")],
    ["monitor", "diagnostic-settings", "show", "--ids", monitorDiagnosticSetting.id.replace("to-hub", ".")],
    ["monitor", "metrics", "list", "--resource", monitorResource.replace("vm-demo", ".")],
  ])("rejects dot segments in Monitor resource groups and names: %j", (...argv) => {
    const result = run(argv);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("must not contain dot segments");
    expect(result.stderr).toBe("");
  });

  it.each([
    ["2026-02-30T00:00:00Z", "2026-03-03T00:00:00Z"],
    ["2026-02-28T00:00:00Z", "2026-02-30T00:00:00Z"],
    ["2026-04-31T00:00:00+02:00", "2026-05-02T00:00:00+02:00"],
    ["2026-02-29T00:00:00Z", "2026-03-01T00:00:00Z"],
    ["2100-02-29T00:00:00Z", "2100-03-01T00:00:00Z"],
  ])("rejects impossible calendar dates in metric windows %s to %s", (start, end) => {
    const result = run([...metrics, "--metric", "Percentage CPU", "--start-time", start, "--end-time", end]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("must be an ISO 8601 datetime");
    expect(result.stderr).toBe("");
  });

  it.each([
    ["2024-02-29T23:30:00+02:00", "2024-03-01T00:30:00+02:00", "2024-02-29T21:30:00.000Z/2024-02-29T22:30:00.000Z"],
    ["2000-02-29T00:00:00Z", "2000-03-01T00:00:00Z", "2000-02-29T00:00:00.000Z/2000-03-01T00:00:00.000Z"],
  ])("preserves valid leap days and offsets in metric windows %s to %s", (start, end, timespan) => {
    const result = run([...metrics, "--metric", "Percentage CPU", "--start-time", start, "--end-time", end]);
    expect(result.status, result.stdout).toBe(0);
    expect(result.stderr).toContain(new URLSearchParams({ timespan }).toString());
  });

  it.each([{ flags: [] }, { flags: ["--full"] }])("preserves rule descriptions containing colons, question marks and hashes with $flags", ({ flags }) => {
    const result = run(["monitor", "metrics", "alert", "show", "--ids", monitorAlertRule.id, ...flags], "prose");
    expect(result.status, result.stdout).toBe(0);
    expect(decode(result.stdout)).toMatchObject({ description: "CPU: overloaded? Restart the worker; Note: incident#123" });
  });

  it.each([
    ["diagnostic list", ["monitor", "diagnostic-settings", "list"]],
    ["diagnostic show", ["monitor", "diagnostic-settings", "show", "--name", "to-hub"]],
    ["metric definitions", ["monitor", "metrics", "list"]],
    ["metric values", ["monitor", "metrics", "list", "--metric", "Percentage CPU"]],
  ])("rejects a resource outside selected subscriptions for %s", (_name, argv) => {
    const result = run([...argv, "--resource", monitorResource.replace(SUB_A, SUB_B)]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("--resource conflicts with selected subscriptions");
    expect(result.stderr).toBe("");
  });

  it("accepts a resource within multiple selected subscriptions", () => {
    const result = run([...metrics, "--subscription", `${SUB_B},${SUB_A.toUpperCase()}`]);
    expect(result.status, result.stdout).toBe(0);
    expect(decode(result.stdout)).toMatchObject({ total: 2 });
  });

  it("preserves labelled aggregations and points without an average", () => {
    const result = run([...metrics, "--metric", "Percentage CPU", ...window, "--full"], "aggregations");
    expect(result.status, result.stdout).toBe(0);
    expect(decode(result.stdout)).toMatchObject({ rows: [{
      latest: { average: 12, maximum: 90, minimum: 0, total: 102, count: 2 }, points: 2, series: [
      { time: "2026-10-04T00:00:00Z", maximum: 95 },
      { time: "2026-10-04T01:00:00Z", average: 12, maximum: 90, minimum: 0, total: 102, count: 2 },
    ] }] });
  });

  it.each(["failed", "mixed"])("fails metric queries with %s results", (mode) => {
    const result = run([...metrics, "--metric", "Percentage CPU,Broken Metric", ...window], mode);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Broken Metric: InvalidSamplingType: Maximum is unsupported");
    expect(result.stdout).not.toContain("points:");
  });

  it("preserves diagnostic category groups in list and show", () => {
    const list = ["monitor", "diagnostic-settings", "list", "--resource", monitorResource];
    expect(decode(run(list, "diagnostic-groups").stdout)).toMatchObject({ rows: [{
      logs: "allLogs (1 enabled)", metrics: "allMetrics (1 enabled)",
    }] });
    expect(decode(run([...list, "--full"], "diagnostic-groups").stdout)).toMatchObject({ rows: [{
      logs: [{ categoryGroup: "allLogs", enabled: true }], metrics: [{ categoryGroup: "allMetrics", enabled: true }],
    }] });
    const show = run(["monitor", "diagnostic-settings", "show", "--ids", monitorDiagnosticSetting.id,
      "--fields", "logs,metrics"], "diagnostic-groups");
    expect(show.status, show.stdout).toBe(0);
    expect(decode(show.stdout)).toMatchObject({ logs: [{ categoryGroup: "allLogs" }], metrics: [{ categoryGroup: "allMetrics" }] });
  });

  it("preserves partner destinations in compact, full and selected fields", () => {
    const list = ["monitor", "diagnostic-settings", "list", "--resource", monitorResource];
    expect(decode(run(list, "partner").stdout)).toMatchObject({ rows: [{ destinations: "partner" }] });
    expect(decode(run([...list, "--full"], "partner").stdout)).toMatchObject({ rows: [{
      destinations: { partner: "/providers/Microsoft.Partner/partners/example" },
    }] });
    const show = run(["monitor", "diagnostic-settings", "show", "--ids", monitorDiagnosticSetting.id,
      "--fields", "partner"], "partner");
    expect(show.status, show.stdout).toBe(0);
    expect(decode(show.stdout)).toMatchObject({ partner: "/providers/Microsoft.Partner/partners/example" });
  });

  it("formats dynamic alert evaluation and failure counts in list and show", () => {
    expect(run(["monitor", "metrics", "alert", "list"]).stdout).toContain("4 failing of 4 evaluation periods");
    const show = run(["monitor", "metrics", "alert", "show", "--name", "disk-full", ...group, "--full"]);
    expect(show.status, show.stdout).toBe(0);
    expect(decode(show.stdout)).toMatchObject({ criteria: ["Available Memory Bytes Dynamic(Medium) 4 failing of 4 evaluation periods"] });
  });

  it.each(["normal", "empty"])("executes metric expansion hints with the same %s query", (mode) => {
    const result = run([...metrics, "--metric", "Percentage CPU", ...window], mode);
    const output = decode(result.stdout) as { help: string[] };
    const hint = output.help[0]!.split("`")[1]!.replace(/^az-axi /, "");
    const expanded = run(hint, mode);
    expect(expanded.status, expanded.stdout).toBe(0);
    expect(expanded.stderr).toBe(result.stderr);
  });

  it("executes a metric definition hint with the supplied value query parameters", () => {
    const output = decode(run([...metrics, ...window]).stdout) as { help: string[] };
    const expanded = run(output.help[0]!.split("`")[1]!.replace(/^az-axi /, ""));
    const original = run([...metrics, "--metric", "Percentage CPU", ...window, "--full"]);
    expect(expanded.status, expanded.stdout).toBe(0);
    expect(expanded.stderr).toBe(original.stderr);
    expect(decode(expanded.stdout)).toEqual(decode(original.stdout));
  });

  it.each(["two-settings", "empty"])("executes diagnostic expansion hints for %s", (mode) => {
    const output = decode(run(["monitor", "diagnostic-settings", "list", "--resource", monitorResource,
      "--limit", "1"], mode).stdout) as { help: string[] };
    const expanded = run(output.help.at(-1)!.split("`")[1]!.replace(/^az-axi /, ""), mode);
    expect(expanded.status, expanded.stdout).toBe(0);
    expect(decode(expanded.stdout)).toMatchObject({ total: mode === "empty" ? 0 : 2 });
  });

  it("executes diagnostic detail hints with multiple selected subscriptions", () => {
    const output = decode(run(["monitor", "diagnostic-settings", "list", "--resource", monitorResource,
      "--subscription", `${SUB_A},${SUB_B}`]).stdout) as { help: string[] };
    const expanded = run(output.help[0]!.split("`")[1]!.replace(/^az-axi /, ""));
    expect(expanded.status, expanded.stdout).toBe(0);
    expect(decode(expanded.stdout)).toMatchObject({ name: "to-hub", id: monitorDiagnosticSetting.id });
  });

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

  it("keeps webhook URI credentials and secrets out of compact and full alert and action-group output", () => {
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
      expect(result.stdout, argv.join(" ")).not.toContain("never-output-this-user");
      expect(result.stdout, argv.join(" ")).not.toContain("never-output-this-password");
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
