import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";
import { discoveryGroup, discoveryResource, discoveryWorkflow, SUB_A, subscriptionList } from "./samples.js";
import { REDACTED } from "../src/lib/redact.js";

describe("built CLI ARM discovery offline", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "az-axi-discovery-cli-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { ci: { auth: "token", subscriptions: [SUB_A] } } }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  function run(args: string[], empty = false, resource: Record<string, unknown> = discoveryResource) {
    const stub = `
      const data = ${JSON.stringify({ discoveryGroup, discoveryResource: resource, subscriptionList })};
      globalThis.fetch = async (url, options) => {
        process.stderr.write(JSON.stringify({url, method: options.method}) + '\\n');
        const path = new URL(url).pathname;
        let body;
        if (path === '/subscriptions') body = {value: data.subscriptionList};
        else if (path.endsWith('/resourcegroups') || path.endsWith('/resources')) {
          const item = path.endsWith('/resources') ? data.discoveryResource : data.discoveryGroup;
          body = {value: ${empty} ? [] : [item], nextLink: ${empty} ? undefined : url + '&page=2'};
          if (url.includes('page=2')) body = {value: []};
        } else if (path.endsWith('/providers/Microsoft.Compute')) body = {resourceTypes: [{resourceType:'virtualMachines',apiVersions:['2025-01-01']}]};
        else body = path.includes('/providers/') ? data.discoveryResource : data.discoveryGroup;
        return Response.json(body);
      };
    `;
    return spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(stub)}`, "dist/bin/az-axi.js", ...args], {
      encoding: "utf8", env: { ...process.env, AZ_AXI_CONFIG: join(dir, "config.json"), AZ_AXI_PROFILE: "ci", AZ_AXI_SUBSCRIPTION: "", AZ_AXI_ARM_TOKEN: "offline-token", AZ_AXI_READ_ONLY: "1" },
    });
  }
  it.each(["group", "resource"])("lists %s across pages as GETs with counts and IDs", (kind) => {
    const result = run([kind, "list", "-s", "Sandbox"]);
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain("total: 1");
    expect(result.stdout).toContain(SUB_A);
    expect(result.stderr).toContain("page=2");
    expect(result.stderr).not.toMatch(/POST|PUT|PATCH|DELETE/);
    expect(run([kind, "list"], true).stdout).toContain("0 of 0");
  });
  it("shows resource-group details and full tags", () => {
    const result = run(["group", "show", "-n", "rg-demo", "--full"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("tags:");
    expect(result.stdout).toContain("provisioningState: Succeeded");
  });
  it("resolves resource names and provider versions and shows requested fields", () => {
    const result = run(["resource", "show", "-n", "vm1", "-g", "rg-demo", "--resource-type", "Microsoft.Compute/virtualMachines", "--fields", "id,tags"]);
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain(discoveryResource.id);
    expect(result.stdout).toContain("tags:");
    expect(result.stderr).toContain("api-version=2025-01-01");
  });
  it.each([
    ["--ids", discoveryWorkflow.id, "--full"],
    ["--ids", discoveryWorkflow.id, "--fields", "properties"],
    ["--name", "http-demo", "--resource-group", "rg-demo", "--resource-type", "Microsoft.Logic/workflows", "--full"],
    ["--name", "http-demo", "--resource-group", "rg-demo", "--resource-type", "Microsoft.Logic/workflows", "--fields", "properties"],
  ])("redacts credential headers through resource show %j", (...flags) => {
    const result = run(["resource", "show", ...flags, "--api-version", "2019-05-01"], false, discoveryWorkflow);
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).not.toContain("opaque-header-value");
    expect(decode(result.stdout)).toMatchObject({ resource: { properties: { definition: { actions: { http: { inputs: { headers: {
      "x-api-key": REDACTED, authorization: REDACTED, Accept: "application/json",
    } } } } } } } });
    expect(result.stdout).toContain("application/json");
  });
  it.each([
    ["--name", "listKeys", "--resource-group", "rg-demo", "--resource-type", "Microsoft.Compute/virtualMachines"],
    ["--ids", `${discoveryGroup.id}/providers/Microsoft.Compute/virtualMachines/listKeys`],
  ])("shows a VM named listKeys through %j", (...flags) => {
    const item = { ...discoveryResource, id: `${discoveryGroup.id}/providers/Microsoft.Compute/virtualMachines/listKeys`, name: "listKeys" };
    const result = run(["resource", "show", ...flags], false, item);
    expect(result.status, result.stdout).toBe(0);
    expect(decode(result.stdout)).toMatchObject({ resource: { id: item.id, name: "listKeys" } });
    expect(result.stderr).toContain("api-version=2025-01-01");
  });
  it.each([
    ["group", "list", "--execute"], ["group", "show"],
    ["resource", "show", "--ids", discoveryResource.id + "/config/appsettings"],
    ["resource", "show", "--ids", discoveryResource.id + "/listKeys"],
    ["resource", "show", "--ids", discoveryResource.id, "--subscription", "00000000-0000-0000-0000-000000000021"],
    ["resource", "list", "--output", "json"],
  ])("refuses %j without transport", (...args) => {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("code:");
    expect(result.stderr).toBe("");
  });
});
