import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leafHelp, COMMAND_LEAVES, type CommandLeaf } from "../src/lib/registry.js";
import { SUB_A, WORKSPACE, discoveryWorkspace, sentinelIncidentAlerts, sentinelIncidentDetail, sentinelIncidentEntities, sentinelIncidents, subscriptionList } from "./samples.js";

const INCIDENT_A = sentinelIncidents[0]!;

describe("built CLI sentinel incident related reads offline", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "az-axi-sentinel-related-cli-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ version: 1, profiles: {
      ci: { auth: "token", subscriptions: [SUB_A] },
      alias: { auth: "token", subscriptions: [SUB_A], workspaces: { sentinel: WORKSPACE } },
    } }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  function run(argv: string[], mode = "normal", profile = "ci") {
    const stub = `
      const data = ${JSON.stringify({ discoveryWorkspace, sentinelIncidents, sentinelIncidentDetail, sentinelIncidentAlerts, sentinelIncidentEntities, subscriptionList })};
      const mode = ${JSON.stringify(mode)};
      globalThis.fetch = async (url, options) => {
        process.stderr.write(JSON.stringify({url, method: options.method, body: options.body ?? null}) + '\\n');
        const path = new URL(url).pathname;
        if (mode === 'denied' && path.includes('/incidents')) {
          return Response.json({error:{code:'AuthorizationFailed',message:'Denied'}},{status:403});
        }
        if (path.endsWith('/alerts')) {
          if (mode === 'malformed-alerts') return Response.json({});
          if (mode === 'partial-alerts') return Response.json({error:{code:'AuthorizationFailed',message:'Denied'}},{status:403});
          if (options.method !== 'POST' || options.body) throw new Error('alerts must be a bodyless POST');
          return Response.json(mode === 'empty' ? {value: []} : {value: data.sentinelIncidentAlerts});
        }
        if (path.endsWith('/entities')) {
          if (mode === 'partial-entities') return Response.json({error:{code:'AuthorizationFailed',message:'Denied'}},{status:403});
          if (options.method !== 'POST' || options.body) throw new Error('entities must be a bodyless POST');
          return Response.json(mode === 'empty' ? {entities: []} : data.sentinelIncidentEntities);
        }
        if (options.method !== 'GET') throw new Error('non-GET incident request');
        let body;
        if (path === '/subscriptions') body = {value: data.subscriptionList};
        else if (path.endsWith('/workspaces')) body = {value: mode === 'empty' ? [] : [data.discoveryWorkspace]};
        else if (path.endsWith('/incidents')) body = {value: mode === 'ambiguous' ? [data.sentinelIncidents[0], {...data.sentinelIncidents[0], name: data.sentinelIncidents[1].name}] : mode === 'empty' ? [] : data.sentinelIncidents};
        else if (path.includes('/incidents/')) {
          if (mode === 'partial-detail') return Response.json({error:{code:'AuthorizationFailed',message:'Denied'}},{status:403});
          body = data.sentinelIncidents.find(i => i.name === path.split('/').pop()) || data.sentinelIncidentDetail;
        }
        else throw new Error('unexpected offline path: ' + path);
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
  const byName = ["--name", INCIDENT_A.name];

  it.each([
    ["--alert-limit", "0"], ["--entity-limit", "1001"], ["--max-rows", "0"],
    ["--limit", "1"], ["--fields", "name"], ["--execute"],
  ])("rejects unsupported or invalid bundle controls %j before transport", (...flags) => {
    const result = run(["sentinel", "incident", "bundle", ...byName, ...selectors, ...flags]);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
  });

  it("reports definitive empty related collections", () => {
    const result = run(["sentinel", "incident", "bundle", "--ids", INCIDENT_A.id], "empty");
    expect(result.status, result.stdout).toBe(0);
    expect(decode(result.stdout)).toMatchObject({ partial: false,
      alerts: { total: 0, count: "0 incident alerts", complete: true, rows: [] },
      entities: { total: 0, count: "0 incident entities", complete: true, rows: [] },
    });
  });

  it("discloses malformed related responses instead of reporting a clean empty result", () => {
    const result = run(["sentinel", "incident", "bundle", ...byName, ...selectors], "malformed-alerts");
    expect(result.status, result.stdout).toBe(0);
    expect(decode(result.stdout)).toMatchObject({ partial: true, failed: ["alerts"], alerts: { code: "API_ERROR" }, entities: { total: 2 } });
  });

  it("bundles detail and independently limited related reads after one number lookup", () => {
    const result = run(["sentinel", "incident", "bundle", "--name", "3177", ...selectors, "--alert-limit", "1", "--entity-limit", "2", "--full"]);
    expect(result.status, result.stdout).toBe(0);
    expect(decode(result.stdout)).toMatchObject({
      partial: false, failed: [], detail: { number: 3177, title: INCIDENT_A.properties.title },
      alerts: { total: 2, count: "1 of 2 incident alerts", complete: false, capped: false, rows: [{ name: sentinelIncidentAlerts[0]!.name, id: sentinelIncidentAlerts[0]!.id }] },
      entities: { total: 2, count: "2 incident entities", complete: true, rows: sentinelIncidentEntities.entities.map(entity => ({ name: entity.name, id: entity.id })) },
    });
    const requests = result.stderr.trim().split("\n").map(line => JSON.parse(line));
    expect(requests.map(({ url, method, body }) => ({ path: new URL(url).pathname.split("/incidents")[1], method, body })))
      .toEqual([
        { path: "", method: "GET", body: null },
        { path: `/${INCIDENT_A.name}`, method: "GET", body: null },
        { path: `/${INCIDENT_A.name}/alerts`, method: "POST", body: null },
        { path: `/${INCIDENT_A.name}/entities`, method: "POST", body: null },
      ]);
  });

  it("refuses ambiguous incident numbers before reading sections", () => {
    const result = run(["sentinel", "incident", "bundle", "--name", "3177", ...selectors], "ambiguous");
    expect(result.status).toBe(2);
    expect(decode(result.stdout)).toMatchObject({ code: "VALIDATION_ERROR", error: "ambiguous incident number 3177" });
    expect(result.stderr).not.toContain(`/incidents/${INCIDENT_A.name}`);
  });

  it("refuses an incomplete number search even when the fetched page contains a match", () => {
    const result = run(["sentinel", "incident", "bundle", "--name", "3177", ...selectors, "--max-rows", "1"]);
    expect(result.status).toBe(1);
    expect(decode(result.stdout)).toMatchObject({ code: "INCOMPLETE_SEARCH" });
    expect(result.stdout).toContain("uniqueness cannot be established");
    expect(result.stderr).not.toContain(`/incidents/${INCIDENT_A.name}`);
  });

  it("keeps collection budgets when full output is requested by ARM ID", () => {
    const result = run(["sentinel", "incident", "bundle", "--ids", INCIDENT_A.id, "--max-rows", "1", "--full"]);
    expect(result.status, result.stdout).toBe(0);
    expect(decode(result.stdout)).toMatchObject({
      alerts: { total: 2, capped: true, complete: false, count: "1 of 2 incident alerts", rows: [{ name: sentinelIncidentAlerts[0]!.name }] },
      entities: { total: 2, capped: true, complete: false, count: "1 of 2 incident entities", rows: [{ name: sentinelIncidentEntities.entities[0]!.name }] },
    });
  });

  it.each(["detail", "alerts", "entities"])("discloses a failed %s section and retains successful reads", (section) => {
    const result = run(["sentinel", "incident", "bundle", ...byName, ...selectors], `partial-${section}`);
    expect(result.status, result.stdout).toBe(0);
    const output = decode(result.stdout) as Record<string, unknown>;
    expect(output).toMatchObject({ partial: true, failed: [section], [section]: { complete: false, code: "FORBIDDEN" } });
    for (const successful of ["detail", "alerts", "entities"].filter(key => key !== section)) {
      expect(output[successful]).toMatchObject(successful === "detail" ? { number: 3177 } : { total: 2, complete: true });
    }
  });

  it("lists related alerts and entities with compact rows and aggregates", () => {
    const alerts = run(["sentinel", "incident", "list-alert", ...byName, ...selectors]);
    expect(alerts.status, alerts.stdout).toBe(0);
    expect(alerts.stdout).toContain("myAlert");
    expect(alerts.stdout).toContain("total: 2");
    expect(alerts.stdout).toContain("bySeverity");
    expect(alerts.stderr).toContain(`/incidents/${INCIDENT_A.name}/alerts?api-version=2025-09-01`);
    expect(alerts.stderr).toContain('"method":"POST"');
    expect(decode(alerts.stdout)).toMatchObject({ incident: INCIDENT_A.name, total: 2 });
    const entities = run(["sentinel", "incident", "list-entity", ...byName, ...selectors]);
    expect(entities.status, entities.stdout).toBe(0);
    expect(entities.stdout).toContain("administrator");
    expect(entities.stdout).toContain("byKind");
    expect(entities.stderr).toContain(`/incidents/${INCIDENT_A.name}/entities?api-version=2025-09-01`);
    expect(decode(entities.stdout)).toMatchObject({ byKind: { Account: 1, Host: 1 } });
  });

  it("accepts numbers, ARM IDs and workspace aliases", () => {
    expect(run(["sentinel", "incident", "list-alert", "--name", "3177", ...selectors]).stdout).toContain("myAlert");
    expect(run(["sentinel", "incident", "list-entity", "--ids", INCIDENT_A.id]).stdout).toContain("administrator");
    const aliased = run(["sentinel", "incident", "list-alert", ...byName, "--workspace", "sentinel"], "normal", "alias");
    expect(aliased.status, aliased.stdout).toBe(0);
    expect(aliased.stdout).toContain("workspace: logs-demo");
  });

  it("reports empty and access-denied output", () => {
    expect(run(["sentinel", "incident", "list-alert", ...byName, ...selectors], "empty").stdout)
      .toContain(`0 incident alerts found for incident ${INCIDENT_A.name} in workspace logs-demo`);
    expect(run(["sentinel", "incident", "list-entity", ...byName, ...selectors], "empty").stdout)
      .toContain("0 incident entities found");
    const denied = run(["sentinel", "incident", "list-alert", ...byName, ...selectors], "denied");
    expect(denied.status).toBe(2);
    expect(denied.stdout).toContain("FORBIDDEN");
  });

  it.each([
    ["sentinel", "incident", "alert", "list", ...byName, ...selectors],
    ["sentinel", "incident", "entity", "list", ...byName, ...selectors],
    ["sentinel", "incident", "list-alert"],
    ["sentinel", "incident", "list-alert", ...byName, ...selectors, "--status"],
    ["sentinel", "incident", "list-alert", ...byName, ...selectors, "--output", "json"],
    ["sentinel", "incident", "list-entity", ...byName],
    ["sentinel", "incident", "list-entity", ...byName, ...selectors, "--ids", INCIDENT_A.id],
    ["sentinel", "incident", "list-alert", "--name", "bogus", ...selectors],
  ])("refuses %j without related transport", (...argv) => {
    const result = run(argv);
    expect(result.status, result.stdout).toBe(2);
    expect(result.stderr).toBe("");
  });

  it("prints leaf help matching the registry without Azure access", () => {
    for (const path of ["sentinel incident list-alert", "sentinel incident list-entity"]) {
      const leaf = COMMAND_LEAVES.find((entry: CommandLeaf) =>
        entry.path === path || entry.aliases?.includes(path))!;
      const result = run([...path.split(" "), "--help"]);
      expect(result.status).toBe(0);
      expect(result.stdout.trimEnd()).toBe(leafHelp(leaf, path).trimEnd());
    }
  });

  it("emits a runnable entity hint from the alert list", () => {
    const alerts = run(["sentinel", "incident", "list-alert", ...byName, ...selectors]);
    expect(alerts.status, alerts.stdout).toBe(0);
    const command = (decode(alerts.stdout) as { help: string[] }).help[0]!;
    expect(command).toContain("sentinel incident list-entity");
    const followed = run(command.split("`")[1]!.replace(/^az-axi /, "").split(" "));
    expect(followed.status, followed.stdout).toBe(0);
    expect(decode(followed.stdout)).toMatchObject({ total: 2 });
  });
});
