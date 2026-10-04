import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leafHelp, COMMAND_LEAVES, type CommandLeaf } from "../src/lib/registry.js";
import {
  SUB_A,
  computeDisk, computeDisks, computeInstanceView, computeVm, computeVmExpanded, computeVms,
  computeVmss, computeVmsss, computeVmssInstanceView, subscriptionList,
} from "./samples.js";

describe("built CLI compute reads offline", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "az-axi-compute-cli-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: {
      ci: { auth: "token", subscriptions: [SUB_A] },
    } }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  function run(argv: string[], mode = "normal") {
    const stub = `
      const data = ${JSON.stringify({
        computeVms, computeVmExpanded, computeInstanceView, computeVmsss, computeVmssInstanceView, computeDisks, subscriptionList,
      })};
      const mode = ${JSON.stringify(mode)};
      const itemsFor = (path) => {
        if (path === '/subscriptions') return data.subscriptionList;
        if (path.endsWith('/virtualMachines')) return mode === 'empty' ? [] : data.computeVms;
        if (path.endsWith('/virtualMachineScaleSets')) return mode === 'empty' ? [] : data.computeVmsss;
        if (path.endsWith('/disks')) return mode === 'empty' ? [] : data.computeDisks;
        return undefined;
      };
      globalThis.fetch = async (url, options) => {
        process.stderr.write(JSON.stringify({url, method: options.method}) + '\\n');
        if (options.method !== 'GET') throw new Error('non-GET request');
        const parsed = new URL(url);
        const path = parsed.pathname;
        if (mode === 'denied' && path.includes('/providers/Microsoft.Compute/')) {
          return Response.json({error:{code:'AuthorizationFailed',message:'Denied'}},{status:403});
        }
        const items = itemsFor(path);
        if (items) return Response.json({value: items});
        const singles = [...data.computeVms, ...data.computeVmsss, ...data.computeDisks];
        const match = (id) => singles.find((item) => item.id.toLowerCase() === id.toLowerCase());
        if (path.toLowerCase().endsWith('/instanceview')) {
          const found = match(path.slice(0, -'/instanceView'.length));
          if (!found) return Response.json({error:{code:'NotFound',message:'Missing'}},{status:404});
          return Response.json(found.type === 'Microsoft.Compute/virtualMachineScaleSets'
            ? data.computeVmssInstanceView : data.computeInstanceView);
        }
        const found = match(path);
        if (!found) return Response.json({error:{code:'NotFound',message:'Missing'}},{status:404});
        const expanded = parsed.searchParams.get('$expand') === 'instanceView' ? data.computeVmExpanded : found;
        return Response.json(expanded);
      };
    `;
    const preload = `data:text/javascript,${encodeURIComponent(stub)}`;
    return spawnSync(process.execPath, ["--import", preload, "dist/bin/az-axi.js", ...argv], {
      encoding: "utf8",
      // Git Bash must pass ARM IDs to Node without converting them to Windows paths.
      env: { ...process.env, MSYS2_ARG_CONV_EXCL: "*", AZ_AXI_CONFIG: join(dir, "config.json"), AZ_AXI_PROFILE: "ci", AZ_AXI_TENANT: "", AZ_AXI_SUBSCRIPTION: "", AZ_AXI_ARM_TOKEN: "offline-token", AZ_AXI_READ_ONLY: "1", AZ_AXI_USAGE_LOG: "0" },
    });
  }
  const selectors = ["--resource-group", "rg-demo"];

  it("lists VMs and shows one with the live power state from the instance view", () => {
    const list = run(["vm", "list", ...selectors]);
    expect(list.status, list.stdout).toBe(0);
    expect(list.stdout).toContain("vm-demo");
    expect(list.stdout).toContain("total: 2");
    expect(list.stderr).toContain("Microsoft.Compute/virtualMachines?api-version=2024-11-01");
    const show = run(["vm", "show", "--name", "vm-demo", ...selectors]);
    expect(show.status, show.stdout).toBe(0);
    expect(decode(show.stdout)).toMatchObject({ power: "VM running", provisioning: "Provisioning succeeded" });
    expect(show.stderr).toContain("expand=instanceView");
    expect(show.stderr).not.toContain("userData");
    expect(run(["vm", "show", "--ids", computeVm.id]).stdout).toContain("Standard_D2s_v3");
  });

  it("returns the dedicated instance view and never secret values", () => {
    const view = run(["vm", "get-instance-view", "--name", "vm-demo", ...selectors]);
    expect(view.status, view.stdout).toBe(0);
    expect(decode(view.stdout)).toMatchObject({ power: "VM running", agent: "2.11.0.2" });
    expect(view.stderr).toContain("virtualMachines/vm-demo/instanceView?api-version=2024-11-01");
    for (const argv of [
      ["vm", "show", "--ids", computeVm.id, "--full"],
      ["vm", "get-instance-view", "--ids", computeVm.id, "--full"],
    ]) {
      const result = run(argv);
      expect(result.status, result.stdout).toBe(0);
      expect(result.stdout).not.toContain("never-output-this-value");
    }
  });

  it("lists scale sets and shows one by ARM ID", () => {
    const list = run(["vmss", "list", ...selectors]);
    expect(list.status, list.stdout).toBe(0);
    expect(list.stdout).toContain("vmss-demo");
    expect(list.stderr).toContain("Microsoft.Compute/virtualMachineScaleSets?api-version=2024-11-01");
    expect(run(["vmss", "show", "--ids", computeVmss.id]).stdout).toContain("Flexible");
  });

  it("reads scale-set aggregate runtime counts through one GET", () => {
    const result = run(["vmss", "get-instance-view", "--ids", computeVmss.id, "--full", "--limit", "1"]);
    expect(result.status, result.stdout).toBe(0);
    expect(decode(result.stdout)).toMatchObject({
      totalStatuses: 2, totalVmStatuses: 2,
      vmStatuses: [{ code: "PowerState/running", count: 2 }, { code: "PowerState/deallocated", count: 1 }],
    });
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain("virtualMachineScaleSets/vmss-demo/instanceView?api-version=2024-11-01");
    expect(result.stdout).not.toContain("never-output-this-value");
  });

  it("lists disks and shows one by ARM ID without secret actions", () => {
    const list = run(["disk", "list", ...selectors]);
    expect(list.status, list.stdout).toBe(0);
    expect(list.stdout).toContain("disk-demo");
    expect(list.stderr).toContain("Microsoft.Compute/disks?api-version=2024-03-02");
    const show = run(["disk", "show", "--ids", computeDisk.id]);
    expect(show.status, show.stdout).toBe(0);
    expect(show.stdout).toContain("vm-demo");
    expect(list.stderr).not.toContain("grantAccess");
    expect(show.stderr).not.toContain("grantAccess");
  });

  it("accepts short flags and exact name filters", () => {
    const short = run(["vm", "list", "-g", "rg-demo", "-s", SUB_A]);
    expect(short.status, short.stdout).toBe(0);
    expect(short.stdout).toContain("total: 2");
    const filtered = run(["disk", "list", ...selectors, "--name", "disk-free"]);
    expect(filtered.status, filtered.stdout).toBe(0);
    expect(filtered.stdout).toContain("disk-free");
    expect(filtered.stdout).not.toContain("disk-demo");
  });

  it("reports empty and access-denied output", () => {
    expect(run(["vm", "list", ...selectors], "empty").stdout).toContain("0 virtual machines found in subscription");
    expect(run(["disk", "list", ...selectors], "empty").stdout).toContain("0 managed disks found in subscription");
    const denied = run(["vmss", "list", ...selectors], "denied");
    expect(denied.status).toBe(2);
    expect(denied.stdout).toContain("FORBIDDEN");
  });

  it.each([
    ["vm", "start", ...selectors],
    ["vm", "list", ...selectors, "--fields", "osProfile"],
    ["vm", "show", "--name", "vm-demo"],
    ["vm", "show", "--name", "vm-demo", ...selectors, "--ids", computeVm.id],
    ["vm", "show", "--ids", computeDisk.id],
    ["vm", "get-instance-view", "--name", "vm-demo"],
    ["vm", "get-instance-view", "--ids", computeVmss.id],
    ["vm", "get-instance-view", "--ids", `${computeVm.id}/instanceView`],
    ["vm", "list", "--name", "a", "--name", "b"],
    ["vmss", "show", "--name", "vmss-demo"],
    ["vmss", "show", "--ids", computeVm.id],
    ["vmss", "get-instance-view", "--ids", `${computeVmss.id}/virtualMachines/0`],
    ["vmss", "get-instance-view", "--ids", `${computeVmss.id}/instanceView`],
    ["disk", "show", "--name", "disk-demo"],
    ["disk", "show", "--ids", computeVmss.id],
    ["disk", "list", ...selectors, "--management-group", "mg-demo"],
  ])("refuses %j without Azure transport", (...argv) => {
    const result = run(argv);
    expect(result.status, result.stdout).toBe(2);
    expect(result.stderr).toBe("");
  });

  it.each(COMMAND_LEAVES.filter((leaf: CommandLeaf) =>
    leaf.path.startsWith("vm ") || leaf.path.startsWith("vmss ") || leaf.path.startsWith("disk ")))(
    "prints leaf help matching the registry without Azure access for $path", (leaf) => {
      const result = run([...leaf.path.split(" "), "--help"]);
      expect(result.status).toBe(0);
      expect(result.stdout.trimEnd()).toBe(leafHelp(leaf, leaf.path).trimEnd());
    });

  it("emits a runnable detail hint for the first row", () => {
    const list = run(["vm", "list", ...selectors]);
    expect(list.status, list.stdout).toBe(0);
    const command = (decode(list.stdout) as { help: string[] }).help[0]!;
    const followed = run(command.split("`")[1]!.replace(/^az-axi /, "").split(" "));
    expect(followed.status, followed.stdout).toBe(0);
    expect(decode(followed.stdout)).toMatchObject({ name: "vm-demo" });
  });
});
