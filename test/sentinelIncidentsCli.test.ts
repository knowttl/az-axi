import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leafHelp, COMMAND_LEAVES, type CommandLeaf } from "../src/lib/registry.js";
import { SUB_A, WORKSPACE, discoveryWorkspace, sentinelIncidentDetail, sentinelIncidents, subscriptionList } from "./samples.js";

const INCIDENT_A = sentinelIncidents[0]!;
const INCIDENT_B = sentinelIncidents[1]!;

describe("built CLI sentinel incident reads offline", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "az-axi-sentinel-cli-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: {
      ci: { auth: "token", subscriptions: [SUB_A] },
      alias: { auth: "token", subscriptions: [SUB_A], workspaces: { sentinel: WORKSPACE } },
    } }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  function run(argv: string[], mode = "normal", profile = "ci") {
    const stub = `
      const data = ${JSON.stringify({ discoveryWorkspace, sentinelIncidents, sentinelIncidentDetail, subscriptionList })};
      const mode = ${JSON.stringify(mode)};
      globalThis.fetch = async (url, options) => {
        process.stderr.write(JSON.stringify({url, method: options.method}) + '\\n');
        if (options.method !== 'GET') throw new Error('non-GET request');
        const path = new URL(url).pathname;
        if (mode === 'denied' && path.includes('/incidents')) {
          return Response.json({error:{code:'AuthorizationFailed',message:'Denied'}},{status:403});
        }
        if (mode === 'missing' && path.includes('/incidents/')) {
          return Response.json({error:{code:'NotFound',message:'Missing'}},{status:404});
        }
        let body;
        if (path === '/subscriptions') body = {value: data.subscriptionList};
        else if (path.endsWith('/workspaces')) body = {value: mode === 'empty' ? [] : [data.discoveryWorkspace]};
        else if (path.endsWith('/incidents')) body = {value: mode === 'empty' ? [] : data.sentinelIncidents};
        else if (path.includes('/incidents/')) body = data.sentinelIncidents.find(i => i.name === path.split('/').pop()) || data.sentinelIncidentDetail;
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

  it("lists incidents and shows one by GUID, number and ARM ID", () => {
    const list = run(["sentinel", "incident", "list", ...selectors]);
    expect(list.status, list.stdout).toBe(0);
    expect(list.stdout).toContain("3177");
    expect(list.stdout).toContain("Suspicious sign-in activity");
    expect(list.stdout).toContain("total: 2");
    expect(list.stderr).toContain("Microsoft.SecurityInsights/incidents?api-version=2025-09-01");
    const show = run(["sentinel", "incident", "show", "--name", INCIDENT_A.name, ...selectors]);
    expect(show.status, show.stdout).toBe(0);
    expect(decode(show.stdout)).toMatchObject({ number: 3177, owner: "Casey Hunter", labels: ["reviewed"] });
    expect(run(["sentinel", "incident", "show", "--name", "3176", ...selectors]).stdout).toContain("Unusual data transfer");
    expect(run(["sentinel", "incident", "show", "--ids", INCIDENT_B.id]).stdout).toContain("3176");
  });

  it("accepts short flags and workspace aliases", () => {
    const short = run(["sentinel", "incident", "list", "-g", "rg-demo", "--workspace-name", "logs-demo", "-s", SUB_A]);
    expect(short.status, short.stdout).toBe(0);
    expect(short.stdout).toContain("total: 2");
    const aliased = run(["sentinel", "incident", "list", "--workspace", "sentinel"], "normal", "alias");
    expect(aliased.status, aliased.stdout).toBe(0);
    expect(aliased.stdout).toContain("workspace: logs-demo");
    expect(aliased.stderr).toContain("Microsoft.OperationalInsights/workspaces?api-version=2025-07-01");
  });

  it("reports empty and access-denied output", () => {
    expect(run(["sentinel", "incident", "list", ...selectors], "empty").stdout).toContain("0 incidents found in workspace logs-demo");
    const denied = run(["sentinel", "incident", "list", ...selectors], "denied");
    expect(denied.status).toBe(2);
    expect(denied.stdout).toContain("FORBIDDEN");
    const missing = run(["sentinel", "incident", "show", "--name", INCIDENT_A.name, ...selectors], "missing");
    expect(missing.status).toBe(2);
    expect(missing.stdout).toContain("NOT_FOUND");
  });

  it.each([
    ["sentinel", "incident", "list"],
    ["sentinel", "incident", "list", ...selectors, "--status"],
    ["sentinel", "incident", "list", ...selectors, "--output", "json"],
    ["sentinel", "incident", "show", "--name", INCIDENT_A.name],
    ["sentinel", "incident", "show", "--name", INCIDENT_A.name, ...selectors, "--ids", INCIDENT_A.id],
    ["sentinel", "incident", "show", "--ids", `${INCIDENT_A.id}/alerts`],
    ["sentinel", "incident", "show", "--name", "bogus", ...selectors],
  ])("refuses %j without incident transport", (...argv) => {
    const result = run(argv);
    expect(result.status, result.stdout).toBe(2);
    expect(result.stderr).toBe("");
  });

  it("prints leaf help matching the registry without Azure access", () => {
    for (const path of ["sentinel incident list", "sentinel incident show"]) {
      const leaf = COMMAND_LEAVES.find((entry: CommandLeaf) => entry.path === path)!;
      const result = run([...path.split(" "), "--help"]);
      expect(result.status).toBe(0);
      expect(result.stdout.trimEnd()).toBe(leafHelp(leaf, path).trimEnd());
    }
  });

  it("emits a runnable detail hint for the newest incident", () => {
    const list = run(["sentinel", "incident", "list", ...selectors]);
    expect(list.status, list.stdout).toBe(0);
    const command = (decode(list.stdout) as { help: string[] }).help[0]!;
    const followed = run(command.split("`")[1]!.replace(/^az-axi /, "").split(" "));
    expect(followed.status, followed.stdout).toBe(0);
    expect(decode(followed.stdout)).toMatchObject({ number: 3177 });
  });
});
