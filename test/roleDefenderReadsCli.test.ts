import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SUB_A, SYN,
  defenderPricing, defenderPricings,
  roleDefinition, roleDefinitions,
  securitySubAssessment, securitySubAssessments,
  subscriptionList,
} from "./samples.js";

describe("built CLI role and Defender reads offline", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "az-axi-role-defender-cli-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: {
      ci: { auth: "token", subscriptions: [SUB_A] },
    } }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  function run(argv: string[], mode = "normal") {
    const stub = `
      const data = ${JSON.stringify({
        roleDefinitions, defenderPricings, securitySubAssessments, subscriptionList,
      })};
      const mode = ${JSON.stringify(mode)};
      const itemsFor = (path) => {
        if (path === '/subscriptions') return data.subscriptionList;
        if (path.endsWith('/roleDefinitions')) return mode === 'empty' ? [] : data.roleDefinitions;
        if (path.endsWith('/pricings')) return mode === 'empty' ? [] : data.defenderPricings;
        if (path.endsWith('/subAssessments')) return mode === 'empty' ? [] : data.securitySubAssessments;
        return undefined;
      };
      globalThis.fetch = async (url, options) => {
        process.stderr.write(JSON.stringify({url, method: options.method}) + '\\n');
        const path = new URL(url).pathname;
        if (options.method !== 'GET') throw new Error('non-GET request');
        const items = itemsFor(path);
        if (items) return Response.json({value: items});
        const all = [...data.roleDefinitions, ...data.defenderPricings, ...data.securitySubAssessments];
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

  it("lists role definitions with permission planes and shows one by GUID", () => {
    const roles = run(["role", "definition", "list"]);
    expect(roles.status, roles.stdout).toBe(0);
    expect(roles.stdout).toContain("Contoso On-call");
    expect(roles.stdout).toContain("total: 2");
    expect(roles.stderr).toContain("Microsoft.Authorization/roleDefinitions?api-version=2022-04-01");
    expect(decode(roles.stdout)).toMatchObject({ byType: { BuiltInRole: 1, CustomRole: 1 } });
    const named = run(["role", "definition", "list", "--name", "Reader"]);
    expect(named.status, named.stdout).toBe(0);
    expect(decode(named.stdout)).toMatchObject({ total: 1 });
    const customs = run(["role", "definition", "list", "--custom-role-only"]);
    expect(customs.status, customs.stdout).toBe(0);
    expect(decode(customs.stdout)).toMatchObject({ total: 1 });
    const shown = run(["role", "definition", "show", "--name", SYN(40)]);
    expect(shown.status, shown.stdout).toBe(0);
    expect(decode(shown.stdout)).toMatchObject({ role: "Contoso On-call", type: "CustomRole" });
    expect(run(["role", "definition", "show", "--ids", roleDefinition.id]).stdout).toContain("Contoso On-call");
  });

  it("lists Defender plans and shows extensions by name", () => {
    const plans = run(["security", "pricing", "list"]);
    expect(plans.status, plans.stdout).toBe(0);
    expect(plans.stdout).toContain("VirtualMachines");
    expect(plans.stdout).toContain("total: 2");
    expect(plans.stderr).toContain("Microsoft.Security/pricings?api-version=2024-01-01");
    expect(decode(plans.stdout)).toMatchObject({ byTier: { Standard: 1, Free: 1 } });
    const plan = run(["security", "pricing", "show", "--name", "VirtualMachines"]);
    expect(plan.status, plan.stdout).toBe(0);
    expect(decode(plan.stdout)).toMatchObject({ tier: "Standard", subPlan: "P2" });
    expect(run(["security", "pricing", "show", "--ids", defenderPricing.id]).stdout).toContain("VirtualMachines");
  });

  it("lists sub-assessments worst-first and shows one by ARM ID", () => {
    const findings = run(["security", "sub-assessment", "list"]);
    expect(findings.status, findings.stdout).toBe(0);
    expect(findings.stdout).toContain("total: 2");
    expect(findings.stderr).toContain("Microsoft.Security/subAssessments?api-version=2019-01-01-preview");
    expect(decode(findings.stdout)).toMatchObject({
      byStatus: { Unhealthy: 1, Healthy: 1 },
      rows: [{ severity: "High" }, { severity: "Low" }],
    });
    const filtered = run(["security", "sub-assessment", "list",
      "--assessed-resource-id", securitySubAssessment.properties.resourceDetails.id]);
    expect(filtered.status, filtered.stdout).toBe(0);
    expect(decode(filtered.stdout)).toMatchObject({ total: 1 });
    const shown = run(["security", "sub-assessment", "show", "--ids", securitySubAssessment.id]);
    expect(shown.status, shown.stdout).toBe(0);
    expect(decode(shown.stdout)).toMatchObject({ status: "Unhealthy", severity: "High" });
  });

  it("reports empty states and rejects mutations without transport", () => {
    const empty = run(["role", "definition", "list", "--name", "missing"], "empty");
    expect(empty.status, empty.stdout).toBe(0);
    expect(empty.stdout).toContain("0 role definitions found");
    const create = run(["security", "pricing", "create", "--name", "VirtualMachines", "--tier", "Standard"]);
    expect(create.status).toBe(2);
    expect(create.stdout).toContain("VALIDATION_ERROR");
    expect(create.stderr).not.toContain("Microsoft.Security/pricings");
  });
});
