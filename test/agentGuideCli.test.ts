import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OWNER_ROLE_ID } from "../src/lib/roles.js";
import { activityEvents, defenderAlerts, discoveryResource, discoveryWorkspace, graphNames, logsResponse,
  rbacAssignments, resourceGraphPage, sentinelIncidentAlerts, sentinelIncidentEntities, sentinelIncidents,
  SUB_A, subscriptionList, WORKSPACE } from "./samples.js";

const skill = readFileSync(new URL("../skills/az-axi/SKILL.md", import.meta.url), "utf8");
const guide = skill.split("## Investigation quickstart\n")[1]!.split("## Orientation\n")[0]!;
const examples = guide.match(/```sh\n([\s\S]*?)\n```/)![1]!.split("\n");

describe("investigation guide examples through the built CLI offline", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "az-axi-guide-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ version: 1, profiles: {
      demo: { auth: "token", subscriptions: [SUB_A], workspaces: { sentinel: WORKSPACE } },
    } }), { mode: 0o600 });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each(examples)("runs %s with synthetic responses", (example) => {
    const data = { activityEvents, defenderAlerts, discoveryResource, discoveryWorkspace, graphNames, logsResponse,
      rbacAssignments: [{ ...rbacAssignments[0], roleDefinitionId: `/providers/Microsoft.Authorization/roleDefinitions/${OWNER_ROLE_ID}` }],
      resourceGraphPage, sentinelIncidentAlerts, sentinelIncidentEntities, sentinelIncidents, subscriptionList };
    // Match the existing CLI tests' fetch boundary: no request can reach Azure.
    const stub = `
      const data = ${JSON.stringify(data)};
      globalThis.fetch = async (url, options) => {
        const { pathname: path, hostname: host } = new URL(url);
        const query = options.body ? JSON.parse(options.body).query : '';
        if (!['GET', 'POST'].includes(options.method)) throw new Error('unexpected mutation');
        if (host === 'graph.microsoft.com' && path.endsWith('/getByIds')) return Response.json(data.graphNames);
        if (host === 'api.loganalytics.io' && path.endsWith('/query')) return Response.json(data.logsResponse);
        if (path.endsWith('/Microsoft.ResourceGraph/resources')) {
          if (query.includes('authorizationresources')) return Response.json({data:data.rbacAssignments,totalRecords:1,count:1});
          if (query === 'Resources') return Response.json(data.resourceGraphPage);
          return Response.json({data:[{resource:'vm1',resourceGroup:'rg-demo',detail:'demo'}],count:1,totalRecords:1});
        }
        if (path.includes('/incidents/') && path.endsWith('/alerts')) return Response.json({value:data.sentinelIncidentAlerts});
        if (path.includes('/incidents/') && path.endsWith('/entities')) return Response.json(data.sentinelIncidentEntities);
        if (options.method !== 'GET') throw new Error('unexpected POST: ' + path);
        if (path === '/subscriptions') return Response.json({value:data.subscriptionList});
        if (path.endsWith('/workspaces')) return Response.json({value:[data.discoveryWorkspace]});
        if (path.endsWith('/incidents')) return Response.json({value:data.sentinelIncidents});
        if (path.includes('/incidents/')) return Response.json(data.sentinelIncidents[0]);
        if (path.endsWith('/resources')) return Response.json({value:[data.discoveryResource]});
        if (path.endsWith('/eventtypes/management/values')) return Response.json({value:data.activityEvents});
        if (path.endsWith('/alerts')) return Response.json({value:data.defenderAlerts});
        throw new Error('unexpected offline request: ' + url);
      };
    `;
    const argv = example.replace("npx -y @knowttl/az-axi ", "").match(/'[^']*'|\S+/g)!
      .map((token) => token.replace(/^'|'$/g, ""));
    const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(stub)}`,
      "dist/bin/az-axi.js", ...argv], {
      encoding: "utf8",
      env: { ...process.env, AZ_AXI_CONFIG: join(dir, "config.json"), AZ_AXI_ARM_TOKEN: "offline-token",
        AZ_AXI_GRAPH_TOKEN: "offline-token", AZ_AXI_LOGS_TOKEN: "offline-token", AZ_AXI_READ_ONLY: "1", AZ_AXI_USAGE_LOG: "0" },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const output = decode(result.stdout) as Record<string, unknown>;
    expect(output.error).toBeUndefined();
    expect(result.stdout).not.toMatch(/could not|unresolved|0 .* found/i);
    expect(result.stdout).not.toContain("offline-token");
  });
});
