import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";
import { scrub } from "../scripts/benchmark/scrub.mjs";
import { countTokens } from "../scripts/benchmark/tokens.mjs";
import { scenarios } from "../benchmark/scenarios.mjs";
import { OWNER_ROLE_ID } from "../src/lib/roles.js";

const root = resolve(import.meta.dirname, "..");
const scratchPaths: string[] = [];
function scratch(): string {
  mkdirSync(join(root, "benchmark/fixtures"), { recursive: true });
  const path = mkdtempSync(join(root, "benchmark/fixtures/test-"));
  scratchPaths.push(path);
  return path;
}
afterEach(() => { for (const path of scratchPaths.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("benchmark preload", () => {
  it.each([["sub", "list"], ["account", "list"], ["account", "show"]])("replays synthetic %s %s responses through the built CLI with no network", (group, verb) => {
    const dir = scratch();
    const file = join(dir, "recording.json");
    const bootstrap = join(dir, "bootstrap.mjs");
    const config = join(dir, "config.json");
    const nextLink = "https://management.azure.com/subscriptions?api-version=2022-12-01&$skiptoken=contoso-page";
    const sub = "00000000-0000-0000-0000-000000000001";
    const tenantId = "00000000-0000-0000-0000-000000000003";
    const account = { subscriptionId: sub, displayName: "contoso-sub", state: "Enabled", tenantId };
    writeFileSync(file, JSON.stringify({ responses: verb === "show" ? [
      { method: "GET", host: "management.azure.com", status: 200, body: scrub(account, { leakCheck: [tenantId] }) },
    ] : [
      { method: "GET", host: "management.azure.com", status: 200, body: scrub({ value: [account], nextLink }, { leakCheck: [tenantId] }) },
      { method: "GET", host: "management.azure.com", status: 200, body: { value: [] } },
    ] }));
    writeFileSync(bootstrap, 'globalThis.fetch = () => { throw new Error("NETWORK MUST NOT RUN"); };\n');
    writeFileSync(config, JSON.stringify({ profiles: { benchmark: { auth: "token" } } }));
    const child = spawnSync(process.execPath, ["--import", pathToFileURL(bootstrap).href, "--import", "./scripts/benchmark/fetch-hook.mjs",
      "dist/bin/az-axi.js", group, verb], {
      cwd: root, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "", AZ_AXI_CONFIG: config,
        AZ_AXI_PROFILE: "benchmark", AZ_AXI_SUBSCRIPTION: verb === "show" ? sub : "", AZ_AXI_TENANT: "", AZ_AXI_ARM_TOKEN: "benchmark-dummy",
        AZ_AXI_READ_ONLY: "1", AZ_AXI_BENCH_MODE: "replay", AZ_AXI_BENCH_FILE: file },
    });
    expect(child.status, child.stderr + child.stdout).toBe(0);
    expect(child.stdout).toContain(scrub("contoso-sub"));
    expect(child.stdout).toContain("Enabled");
    if (group === "account") expect(child.stdout).toContain(scrub(tenantId));
    expect(child.stdout).not.toContain(tenantId);
    expect(child.stdout).not.toContain("contoso-sub");
    expect(child.stdout).not.toContain("benchmark-dummy");
  });

  it.each(["missing", "mismatch", "unused"])("fails closed on %s replay responses", (kind) => {
    const dir = scratch();
    const file = join(dir, "recording.json");
    const entry = { method: kind === "mismatch" ? "POST" : "GET", host: "management.azure.com", status: 200, body: { value: [] } };
    writeFileSync(file, JSON.stringify({ responses: kind === "missing" ? [] : kind === "unused" ? [entry, entry] : [entry] }));
    const child = spawnSync(process.execPath, ["--import", "./scripts/benchmark/fetch-hook.mjs", "--input-type=module", "-e",
      'await fetch("https://management.azure.com/subscriptions").catch(() => {});'], {
      cwd: root, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "", AZ_AXI_BENCH_MODE: "replay", AZ_AXI_BENCH_FILE: file },
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("not fully consumed");
  });

  it("scrubs fake records before disk and refuses leakCheck survivors", () => {
    const dir = scratch();
    const bootstrap = join(dir, "bootstrap.mjs");
    writeFileSync(bootstrap, 'globalThis.fetch = async () => Response.json({ name: "contoso-private", severity: "High" });\n');
    for (const leakCheck of [["contoso-private"], ["HIGH"]]) {
      const file = join(dir, `record-${leakCheck.length}-${leakCheck[0]}.json`);
      const child = spawnSync(process.execPath, ["--import", pathToFileURL(bootstrap).href, "--import", "./scripts/benchmark/fetch-hook.mjs",
        "--input-type=module", "-e", 'await fetch("https://management.azure.com/subscriptions");'], {
        cwd: root, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "", AZ_AXI_READ_ONLY: "1",
          AZ_AXI_BENCH_MODE: "record", AZ_AXI_BENCH_FILE: file, AZ_AXI_BENCH_OWNER_CAPTURE: "1",
          AZ_AXI_BENCH_LEAK_CHECK: JSON.stringify(leakCheck) },
      });
      if (leakCheck[0] === "HIGH") {
        expect(child.status).toBe(1);
        expect(existsSync(file)).toBe(false);
        expect(child.stderr).not.toContain("HIGH");
      } else {
        expect(child.status, child.stderr).toBe(0);
        expect(readFileSync(file, "utf8")).not.toContain("contoso-private");
        expect(JSON.parse(readFileSync(file, "utf8")).responses[0].body.name).toBe(scrub("contoso-private"));
      }
    }
  });
});

describe("benchmark surface", () => {
  it.each([
    { details: {}, count: 18, notes: ["Skipped group-show", "Skipped resource-show", "Skipped workspace-show"], detailCalls: [] },
    { details: { resourceGroup: "owner-group" }, count: 19, notes: ["Skipped resource-show", "Skipped workspace-show"], detailCalls: [
      ["group", "show", "--name", "owner-group"],
    ] },
    { details: { resourceId: "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/owner-group/providers/Microsoft.Compute/virtualMachines/owner-vm" }, count: 19, notes: ["Skipped group-show", "Skipped workspace-show"], detailCalls: [
      ["resource", "show", "--ids", "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/owner-group/providers/Microsoft.Compute/virtualMachines/owner-vm", "--api-version", "2024-07-01"],
    ] },
  ])("captures configured owner targets and continues past unset targets $details", ({ details, count, notes, detailCalls }) => {
    const dir = scratch();
    for (const path of ["scripts/benchmark/capture.mjs", "benchmark/scenarios.mjs"]) {
      cpSync(join(root, path), join(dir, path), { recursive: true });
    }
    const targets = {
      profile: "owner",
      subscription: "00000000-0000-0000-0000-000000000001",
      workspace: "00000000-0000-0000-0000-000000000010",
      leakCheck: ["owner"],
      ...details,
    };
    writeFileSync(join(dir, "benchmark/targets.json"), JSON.stringify(targets));
    const bootstrap = join(dir, "bootstrap.mjs");
    const calls = join(dir, "calls.json");
    writeFileSync(bootstrap, [
      'import childProcess from "node:child_process";',
      'import { syncBuiltinESMExports } from "node:module";',
      'import { writeFileSync } from "node:fs";',
      'const calls = [];',
      'childProcess.spawnSync = (command, argv) => {',
      '  calls.push(argv);',
      `  writeFileSync(${JSON.stringify(calls)}, JSON.stringify(calls));`,
      '  return { status: 0 };',
      '};',
      'syncBuiltinESMExports();',
    ].join("\n"));
    const child = spawnSync(process.execPath, ["--import", pathToFileURL(bootstrap).href, "scripts/benchmark/capture.mjs"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" },
    });
    expect(child.status, child.stderr).toBe(0);
    const captured = JSON.parse(readFileSync(calls, "utf8"));
    expect(captured).toHaveLength(count);
    for (const note of notes) expect(child.stderr).toContain(note);
    for (const argv of detailCalls) expect(captured).toContainEqual([
      "--import", "./scripts/benchmark/fetch-hook.mjs", "dist/bin/az-axi.js", ...argv,
      "--profile", targets.profile, "--subscription", targets.subscription,
    ]);
    expect(captured.flat()).not.toContain("rg-demo");
    expect(captured.flat()).not.toContain("vm1");
    expect(captured).toContainEqual([
      "--import", "./scripts/benchmark/fetch-hook.mjs", "dist/bin/az-axi.js",
      "logs", "query", "SigninLogs | take 50", "--workspace", targets.workspace,
      "--profile", targets.profile, "--subscription", targets.subscription,
    ]);
    expect(captured).toContainEqual([
      "--import", "./scripts/benchmark/fetch-hook.mjs", "dist/bin/az-axi.js",
      "monitor", "log-analytics", "query", "--analytics-query", "SigninLogs | take 50", "--workspace", targets.workspace,
      "--profile", targets.profile, "--subscription", targets.subscription,
    ]);
  });

  it.each([
    { omitted: [], rows: "rows[21]", notes: [] },
    { omitted: ["group-show", "resource-show", "workspace-show"], rows: "rows[18]", notes: ["Skipped group-show", "Skipped resource-show", "Skipped workspace-show"] },
  ])("runs available scenarios through offline replay with omitted $omitted captures", ({ omitted, rows, notes }) => {
    const dir = scratch();
    for (const path of ["dist", "scripts/benchmark", "benchmark/scenarios.mjs"]) {
      cpSync(join(root, path), join(dir, path), { recursive: true });
    }
    symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "junction");
    mkdirSync(join(dir, "benchmark/fixtures"), { recursive: true });
    const sub = "00000000-0000-0000-0000-000000000001";
    const tenantId = "00000000-0000-0000-0000-000000000003";
    const principal = "00000000-0000-0000-0000-000000000002";
    const id = `/subscriptions/${sub}/resourceGroups/contoso-team/providers/Microsoft.Compute/virtualMachines/contoso-vm`;
    const response = (method: string, body: unknown, host = "management.azure.com") => ({ method, host, status: 200, body: scrub(body) });
    const subscriptions = () => response("GET", { value: [{ subscriptionId: sub, displayName: "contoso-sub", state: "Enabled", tenantId }] });
    for (const scenario of scenarios) {
      if (omitted.includes(scenario.name)) continue;
      let responses;
      if (scenario.name === "account-list") {
        responses = [response("GET", { value: [{ subscriptionId: sub, displayName: "contoso-sub", state: "Enabled", tenantId }],
          nextLink: "https://management.azure.com/subscriptions?api-version=2022-12-01&$skiptoken=contoso-page",
        }), response("GET", { value: [{ subscriptionId: principal, displayName: "other-sub", state: "Enabled", tenantId }] })];
      } else if (scenario.name === "account-show") {
        responses = [response("GET", { subscriptionId: sub, displayName: "contoso-sub", state: "Enabled", tenantId })];
      } else if (scenario.name === "workspace-list") {
        responses = [response("GET", { value: [] })];
      } else if (scenario.name === "workspace-show") {
        responses = [response("GET", { id: `/subscriptions/${sub}/resourceGroups/rg-demo/providers/Microsoft.OperationalInsights/workspaces/logs-demo`, name: "logs-demo", location: "westus", properties: { customerId: "00000000-0000-0000-0000-000000000010" } })];
      } else if (scenario.name === "group-list") {
        responses = [response("GET", { value: [] })];
      } else if (scenario.name === "group-show") {
        responses = [response("GET", { id: `/subscriptions/${sub}/resourceGroups/rg-demo`, name: "rg-demo", location: "westus" })];
      } else if (scenario.name === "resource-list") {
        responses = [response("GET", { value: [] })];
      } else if (scenario.name === "resource-show") {
        responses = [response("GET", { id, name: "vm1", type: "Microsoft.Compute/virtualMachines", location: "westus" })];
      } else if (scenario.name.startsWith("rg-") || scenario.name === "graph-query") {
        const count = scenario.name === "graph-query" ? 50 : Number(scenario.name.slice(3));
        responses = [response("POST", { totalRecords: count, data: Array.from({ length: count }, (_, index) => ({
          id, name: `contoso-vm-${index}`, type: "Microsoft.Compute/virtualMachines", location: "contoso-region",
        })) }), subscriptions()];
      } else if (scenario.name === "rbac-privileged" || scenario.name === "role-assignment-privileged") {
        responses = [response("POST", { totalRecords: 1, data: [{
          principalId: principal, principalType: "User", roleName: "contoso-role", roleDefinitionId: OWNER_ROLE_ID,
          scope: id, createdOn: "2026-10-02T12:34:56Z",
        }] }), response("POST", { value: [{ id: principal, displayName: "contoso-user" }] }, "graph.microsoft.com"), subscriptions()];
      } else if (scenario.name === "defender-alerts" || scenario.name === "security-alerts") {
        responses = [response("GET", { value: [{ id, properties: {
          alertDisplayName: "contoso-alert", severity: "High", status: "Active", timeGeneratedUtc: "2026-10-02T12:34:56Z",
          resourceIdentifiers: [{ azureResourceId: id }],
        } }] }), subscriptions()];
      } else if (scenario.name === "monitor-activity") {
        responses = [response("GET", { value: [] })];
      } else if (scenario.name === "security-scores") {
        responses = [response("POST", { totalRecords: 0, data: [] })];
      } else if (scenario.name === "exposure") {
        responses = [subscriptions(), ...Array.from({ length: 3 }, () => response("POST", {
          totalRecords: 1, data: [{ resource: "contoso-vm", resourceGroup: "contoso-team", subscriptionId: sub, detail: "contoso-detail" }],
        }))];
      } else {
        responses = [response("POST", { tables: [{ name: "PrimaryResult", columns: [{ name: "UserPrincipalName", type: "string" }], rows: [["analyst@contoso.com"]] }] }, "api.loganalytics.io")];
      }
      writeFileSync(join(dir, `benchmark/fixtures/${scenario.name}.json`), JSON.stringify({ responses }));
    }
    const bootstrap = join(dir, "bootstrap.mjs");
    const accountOutput = join(dir, "account-output.toon");
    writeFileSync(bootstrap, [
      'import childProcess from "node:child_process";',
      'import { syncBuiltinESMExports } from "node:module";',
      'import { writeFileSync } from "node:fs";',
      'const spawnSync = childProcess.spawnSync;',
      'childProcess.spawnSync = (command, argv, options) => {',
      '  const child = spawnSync(command, argv, options);',
      `  if (argv.includes("account") && argv.includes("list")) writeFileSync(${JSON.stringify(accountOutput)}, child.stdout);`,
      '  return child;',
      '};',
      'syncBuiltinESMExports();',
    ].join("\n"));
    const child = spawnSync(process.execPath, ["--import", pathToFileURL(bootstrap).href, "scripts/benchmark/bench.mjs"], { cwd: dir, encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    expect(decode(readFileSync(accountOutput, "utf8"))).toMatchObject({
      total: 1, count: "1 of 1 subscriptions",
      subscriptions: [{ id: scrub(sub), name: scrub("contoso-sub"), state: "Enabled", tenantId: scrub(tenantId) }],
    });
    expect(child.stdout).toContain(rows);
    for (const note of notes) expect(child.stderr).toContain(note);
    expect(child.stdout).toContain("rbac-privileged");
    expect(child.stdout).toContain("logs-query");
    expect(child.stdout).not.toContain("benchmark-dummy");
    expect(readFileSync(join(dir, "benchmark/fixtures/rg-1.json"), "utf8")).not.toContain("contoso-team");
  }, 20_000);

  it("measures the real skill and built help surface", () => {
    const child = spawnSync(process.execPath, ["scripts/benchmark/capture-surface.mjs"], { cwd: root, encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout);
    const skill = readFileSync(join(root, "skills/az-axi/SKILL.md"), "utf8");
    expect(result.skill.total).toBe(countTokens(skill));
    expect(result.skill.frontmatter).toBeLessThan(100);
    expect(result.skill.body).toBeGreaterThan(0);
    expect(result.help.topLevel).toBeGreaterThan(0);
    expect(Object.keys(result.help)).toHaveLength(20);
    expect(JSON.parse(readFileSync(join(root, "benchmark/tool-surface.json"), "utf8"))).toEqual(result);
  }, 20_000);

  it("keeps owner selectors out of scenario argv", () => {
    expect(scenarios.map((scenario: { name: string }) => scenario.name)).toEqual([
      "account-list", "account-show", "workspace-list", "workspace-show",
      "group-list", "group-show", "resource-list", "resource-show",
      "rg-1", "rg-10", "rg-50", "rbac-privileged", "role-assignment-privileged", "monitor-activity", "security-alerts", "security-scores", "defender-alerts", "exposure", "logs-query", "graph-query", "monitor-log-analytics-query",
    ]);
    for (const scenario of scenarios) {
      expect(scenario.argv).not.toContain("--profile");
      expect(scenario.argv).not.toContain("--subscription");
    }
  });
});
