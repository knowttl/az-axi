import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ sendRequest: vi.fn(), request: vi.fn(), requestAll: vi.fn() }));

import { runDisk, runVm, runVmss } from "../src/commands/compute.js";
import { request, requestAll } from "../src/lib/client.js";
import { clearSubscriptionCache } from "../src/lib/scope.js";
import {
  SUB_A, SUB_B,
  computeDisk, computeDisks, computeInstanceView, computeVm, computeVmExpanded, computeVms,
  computeVmss, computeVmsss,
} from "./samples.js";

const allMock = vi.mocked(requestAll);
const requestMock = vi.mocked(request);

let dir: string;
const ENV_KEYS = ["AZ_AXI_CONFIG", "AZ_AXI_PROFILE", "AZ_AXI_SUBSCRIPTION", "AZ_AXI_TENANT"];
let saved: Record<string, string | undefined>;

const SUBSCRIPTIONS = [
  { subscriptionId: SUB_A, displayName: "Sandbox" },
  { subscriptionId: SUB_B, displayName: "Lab" },
];

function mockTransport() {
  allMock.mockImplementation(async (_profile: unknown, requestOptions: Record<string, unknown>) => {
    const path = String(requestOptions["path"] ?? "");
    if (path === "/subscriptions") return { items: SUBSCRIPTIONS };
    if (path.endsWith("/virtualMachines")) return { items: computeVms };
    if (path.endsWith("/virtualMachineScaleSets")) return { items: computeVmsss };
    if (path.endsWith("/disks")) return { items: computeDisks };
    throw new Error(`unexpected offline path: ${path}`);
  });
  requestMock.mockImplementation(async (_profile: unknown, requestOptions: Record<string, unknown>) => {
    const path = String(requestOptions["path"] ?? "");
    const query = (requestOptions["query"] ?? {}) as Record<string, unknown>;
    if (path.toLowerCase() === computeVm.id.toLowerCase()) {
      return (query["$expand"] === "instanceView" ? computeVmExpanded : computeVm) as never;
    }
    if (path.toLowerCase() === `${computeVm.id.toLowerCase()}/instanceview`) return computeInstanceView as never;
    for (const item of [computeVmss, computeDisk]) {
      if (path.toLowerCase() === item.id.toLowerCase()) return item as never;
    }
    throw new AxiError(`not found: ${path}`, "NOT_FOUND", []);
  });
}

function useProfile(name = "ci", profile: Record<string, unknown> = { auth: "token", subscriptions: [SUB_A] }) {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { [name]: profile } }));
  process.env.AZ_AXI_PROFILE = name;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-compute-"));
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AZ_AXI_CONFIG = join(dir, "config.json");
  useProfile();
  clearSubscriptionCache();
  allMock.mockReset();
  requestMock.mockReset();
  mockTransport();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
  clearSubscriptionCache();
});

function sentPaths(): string[] {
  return [
    ...allMock.mock.calls.map((call) => String((call[1] as Record<string, unknown>)["path"] ?? "")),
    ...requestMock.mock.calls.map((call) => String((call[1] as Record<string, unknown>)["path"] ?? "")),
  ];
}

function sentMethods(): unknown[] {
  return [
    ...allMock.mock.calls.map((call) => (call[1] as Record<string, unknown>)["method"]),
    ...requestMock.mock.calls.map((call) => (call[1] as Record<string, unknown>)["method"]),
  ];
}

describe("vm list", () => {
  it("lists compact rows with location aggregates and a detail hint", async () => {
    const result = await runVm(["list", "--resource-group", "rg-demo"]);
    expect(result).toMatchObject({
      profile: "ci",
      total: 2,
      count: "2 virtual machines",
      byLocation: { westus: 1, westeurope: 1 },
      rows: [
        { name: "vm-demo", location: "westus", size: "Standard_D2s_v3", os: "Linux", provisioning: "Succeeded" },
        { name: "vm-stopped", location: "westeurope", size: "Standard_B1s", os: "Windows", provisioning: "Succeeded" },
      ],
    });
    expect(result.help).toEqual([expect.stringContaining("vm show --ids")]);
    const options = allMock.mock.calls.map((call) => call[1] as Record<string, unknown>);
    const list = options.find((call) => String(call["path"] ?? "").endsWith("/virtualMachines"))!;
    expect(list["method"]).toBe("GET");
    expect(list["apiVersion"]).toBe("2024-11-01");
    expect(list["path"]).toBe(`/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Compute/virtualMachines`);
    expect(JSON.stringify(result)).not.toContain("never-output-this-value");
  });

  it("filters by exact name and caps rows with lower-bound disclosure", async () => {
    const filtered = await runVm(["list", "--name", "vm-demo"]);
    expect(filtered).toMatchObject({ total: 1, count: "1 virtual machines" });
    const capped = await runVm(["list", "--limit", "1"]);
    expect(capped).toMatchObject({ total: 2, count: "1 of 2 virtual machines" });
    expect(capped.help).toEqual(expect.arrayContaining([expect.stringContaining("--full")]));
    const full = await runVm(["list", "--full"]);
    expect((full.rows as unknown[])).toHaveLength(2);
    const fields = await runVm(["list", "--fields", "name,size"]);
    expect(fields.rows).toEqual([{ name: "vm-demo", size: "Standard_D2s_v3" }, { name: "vm-stopped", size: "Standard_B1s" }]);
  });

  it("reports an explicit empty state", async () => {
    const result = await runVm(["list", "--name", "missing"]);
    expect(result).toMatchObject({
      total: 0, count: "0 virtual machines",
      rows: expect.stringContaining("0 virtual machines found in subscription"),
    });
  });
});

describe("vm show", () => {
  it("reads the model with instanceView expansion and reports live power state", async () => {
    const result = await runVm(["show", "--name", "vm-demo", "--resource-group", "rg-demo"]);
    expect(result).toMatchObject({
      profile: "ci",
      name: "vm-demo",
      size: "Standard_D2s_v3",
      os: "Linux",
      power: "VM running",
      provisioning: "Provisioning succeeded",
    });
    expect(result.help).toEqual([expect.stringContaining("vm get-instance-view"),
      expect.stringContaining("--full")]);
    const options = requestMock.mock.calls.map((call) => call[1] as Record<string, unknown>);
    expect(options).toHaveLength(1);
    expect(options[0]!["method"]).toBe("GET");
    expect(options[0]!["apiVersion"]).toBe("2024-11-01");
    expect(options[0]!["path"]).toBe(computeVm.id);
    expect(options[0]!["query"]).toMatchObject({ $expand: "instanceView" });
    expect(JSON.stringify(options[0])).not.toContain("userData");
  });

  it("projects disks and NICs in full and caps nested rows with totals", async () => {
    const full = await runVm(["show", "--ids", computeVm.id, "--full"]);
    expect(full).toMatchObject({
      computer: "vm-demo",
      image: "Canonical UbuntuServer 22.04-LTS latest",
      osDisk: { name: "vm-demo-os", sizeGb: 30 },
      totalDataDisks: 2,
      nics: ["nic-demo"],
      zone: "1",
      availabilitySet: "as-demo",
    });
    expect((full.dataDisks as unknown[])).toHaveLength(2);
    const capped = await runVm(["show", "--ids", computeVm.id, "--limit", "1"]);
    expect((capped.dataDisks as unknown[])).toHaveLength(1);
    expect(capped).toMatchObject({ totalDataDisks: 2 });
    expect(capped.help).toEqual(expect.arrayContaining([expect.stringContaining("--full")]));
  });

  it("never projects osProfile secrets, extension settings or boot-diagnostic URIs", async () => {
    for (const argv of [["show", "--name", "vm-demo", "--resource-group", "rg-demo"],
      ["show", "--ids", computeVm.id, "--full"],
      ["show", "--ids", computeVm.id, "--fields", "name,computer,image"]]) {
      const result = await runVm(argv);
      expect(JSON.stringify(result)).not.toContain("never-output-this-value");
    }
  });

  it.each([
    ["--ids", computeVm.id],
    ["--name", "vm-demo", "--resource-group", "rg-demo"],
  ])("returns selected VM metadata for %j", async (...selector) => {
    const result = await runVm(["show", ...selector, "--fields", "id,computer,image,osDisk,nics,zone,availabilitySet,tags"]);
    expect(result).toMatchObject({
      id: computeVm.id,
      computer: "vm-demo",
      image: "Canonical UbuntuServer 22.04-LTS latest",
      osDisk: { name: "vm-demo-os", sizeGb: 30 },
      nics: ["nic-demo"],
      zone: "1",
      availabilitySet: "as-demo",
      tags: { env: "test" },
    });
    expect(JSON.stringify(result)).not.toContain("never-output-this-value");
  });

  it("falls back to the model provisioning state without an instance view", async () => {
    requestMock.mockImplementationOnce(async () => computeVm as never);
    const result = await runVm(["show", "--ids", computeVm.id]);
    expect(result).toMatchObject({ power: "", provisioning: "Succeeded" });
  });
});

describe("vm get-instance-view", () => {
  it("returns the runtime view by name and by ARM ID", async () => {
    const result = await runVm(["get-instance-view", "--name", "vm-demo", "--resource-group", "rg-demo"]);
    expect(result).toMatchObject({
      profile: "ci",
      name: "vm-demo",
      power: "VM running",
      provisioning: "Provisioning succeeded",
      os: "Ubuntu 22.04",
      agent: "2.11.0.2",
    });
    const options = requestMock.mock.calls.map((call) => call[1] as Record<string, unknown>);
    expect(options[0]!["path"]).toBe(`${computeVm.id}/instanceView`);
    expect(options[0]!["method"]).toBe("GET");
    expect(options[0]!["apiVersion"]).toBe("2024-11-01");
    const byId = await runVm(["get-instance-view", "--ids", `${computeVm.id}/instanceView`, "--full"]);
    expect(byId).toMatchObject({
      computer: "vm-demo",
      totalDisks: 2,
      totalExtensions: 1,
      disks: [{ name: "vm-demo-os", status: "Provisioning succeeded" }, { name: "vm-demo-data0", status: "Provisioning succeeded" }],
      extensions: [{ name: "CustomScript", type: "Microsoft.Azure.Extensions.CustomScript", version: "2.1",
        status: "Provisioning succeeded" }],
    });
    expect(JSON.stringify(byId)).not.toContain("never-output-this-value");
  });

  it("caps nested rows at the limit with totals disclosed", async () => {
    const capped = await runVm(["get-instance-view", "--ids", computeVm.id, "--limit", "1"]);
    expect((capped.disks as unknown[])).toHaveLength(1);
    expect(capped).toMatchObject({ totalDisks: 2, totalExtensions: 1 });
    expect(capped.help).toEqual([expect.stringContaining("--full")]);
  });

  it.each(["disks", "extensions"])("discloses capped %s and returns every row in full", async (field) => {
    const view = { ...computeInstanceView,
      extensions: [...computeInstanceView.extensions, { ...computeInstanceView.extensions[0], name: "SecondExtension" }],
    };
    requestMock.mockResolvedValue(view as never);
    const capped = await runVm(["get-instance-view", "--ids", computeVm.id, "--limit", "1", "--fields", field]);
    expect(capped[field]).toHaveLength(1);
    expect(capped.help).toEqual([expect.stringContaining("--full")]);
    const full = await runVm(["get-instance-view", "--ids", computeVm.id, "--limit", "1", "--fields", field, "--full"]);
    expect(full[field]).toHaveLength(2);
    expect(full).not.toHaveProperty("help");
  });
});

describe("vmss list and show", () => {
  it("lists compact rows and shows one by ARM ID", async () => {
    const result = await runVmss(["list", "--resource-group", "rg-demo"]);
    expect(result).toMatchObject({
      profile: "ci",
      total: 2,
      count: "2 virtual machine scale sets",
      byLocation: { westus: 1, westeurope: 1 },
      rows: [
        { name: "vmss-demo", location: "westus", sku: "Standard_D2s_v3", capacity: 3,
          orchestration: "Flexible", provisioning: "Succeeded" },
        { name: "vmss-uniform", location: "westeurope", sku: "Standard_B2s", capacity: 1,
          orchestration: "Uniform", provisioning: "Succeeded" },
      ],
    });
    const options = allMock.mock.calls.map((call) => call[1] as Record<string, unknown>);
    const list = options.find((call) => String(call["path"] ?? "").endsWith("/virtualMachineScaleSets"))!;
    expect(list["apiVersion"]).toBe("2024-11-01");
    const shown = await runVmss(["show", "--ids", computeVmss.id, "--full"]);
    expect(shown).toMatchObject({
      upgradeMode: "Automatic",
      computerPrefix: "vmss",
      image: "Canonical UbuntuServer 22.04-LTS latest",
      osType: "Linux",
      zones: ["1", "2"],
    });
    expect(JSON.stringify(shown)).not.toContain("never-output-this-value");
  });

  it("reports an explicit empty state", async () => {
    const result = await runVmss(["list", "--name", "missing"]);
    expect(result).toMatchObject({ total: 0, rows: expect.stringContaining("0 virtual machine scale sets found") });
  });
});

describe("disk list and show", () => {
  it.each([
    ["--ids", computeDisk.id],
    ["--ids", computeDisk.id, "--full"],
    ["--ids", computeDisk.id, "--fields", "attached"],
    ["--name", "disk-demo", "--resource-group", "rg-demo"],
    ["--name", "disk-demo", "--resource-group", "rg-demo", "--full"],
    ["--name", "disk-demo", "--resource-group", "rg-demo", "--fields", "attached"],
  ])("returns the disk attachment for %j", async (...selector) => {
    expect(await runDisk(["show", ...selector])).toMatchObject({ attached: "vm-demo" });
  });

  it("lists compact rows and shows the attachment without secret actions", async () => {
    const result = await runDisk(["list", "--resource-group", "rg-demo"]);
    expect(result).toMatchObject({
      profile: "ci",
      total: 2,
      count: "2 managed disks",
      rows: [
        { name: "disk-demo", location: "westus", sizeGb: 128, sku: "Premium_LRS", state: "Attached", os: "Linux" },
        { name: "disk-free", location: "westeurope", sizeGb: 32, sku: "Standard_LRS", state: "Unattached", os: "" },
      ],
    });
    const options = allMock.mock.calls.map((call) => call[1] as Record<string, unknown>);
    const list = options.find((call) => String(call["path"] ?? "").endsWith("/disks"))!;
    expect(list["apiVersion"]).toBe("2024-03-02");
    const shown = await runDisk(["show", "--ids", computeDisk.id, "--full"]);
    expect(shown).toMatchObject({
      attached: "vm-demo",
      encryption: "EncryptionAtRestWithCustomerKey",
      networkAccess: "AllowPrivate",
      provisioningState: "Succeeded",
    });
    for (const path of sentPaths()) {
      expect(path.toLowerCase()).not.toContain("grantaccess");
      expect(path.toLowerCase()).not.toContain("access");
    }
    expect(sentMethods().every((method) => method === "GET")).toBe(true);
  });

  it("reports an explicit empty state", async () => {
    const result = await runDisk(["list", "--name", "missing"]);
    expect(result).toMatchObject({ total: 0, rows: expect.stringContaining("0 managed disks found") });
  });
});

describe("compute validation", () => {
  it.each([
    [runVm, "show", computeVmExpanded],
    [runVm, "get-instance-view", computeInstanceView],
    [runVmss, "show", computeVmss],
    [runDisk, "show", computeDisk],
  ] as const)("encodes Unicode resource groups once for named reads %#", async (run, verb, item) => {
    requestMock.mockResolvedValueOnce(item as never);
    await run([verb, "--name", "demo", "--resource-group", "rg-é", "--subscription", SUB_A]);
    expect(requestMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      path: expect.stringContaining(`/subscriptions/${SUB_A}/resourceGroups/rg-%C3%A9/providers/Microsoft.Compute/`),
    }));
  });

  it.each([
    ["vm", ["show", "--name", "vm-demo"]],
    ["vm", ["show", "--name", "vm-demo", "--resource-group", "rg-demo", "--ids", computeVm.id]],
    ["vm", ["show", "--ids", computeVmss.id]],
    ["vm", ["show", "--ids", "/subscriptions/not-a-guid/resourceGroups/rg-demo/providers/Microsoft.Compute/virtualMachines/vm-demo"]],
    ["vm", ["get-instance-view", "--name", "vm-demo"]],
    ["vm", ["get-instance-view", "--ids", computeDisk.id]],
    ["vm", ["start"]],
    ["vm", ["list", "--bogus", "x"]],
    ["vm", ["list", "--limit", "0"]],
    ["vm", ["list", "--fields", "properties"]],
    ["vmss", ["show", "--name", "vmss-demo"]],
    ["vmss", ["show", "--ids", computeVm.id]],
    ["disk", ["show", "--name", "disk-demo"]],
    ["disk", ["show", "--ids", computeVm.id]],
    ["disk", ["list", "--fields", "sasUri"]],
  ])("refuses %s %j before transport", async (top, argv) => {
    const run = top === "vm" ? runVm : top === "vmss" ? runVmss : runDisk;
    await expect(run(argv)).rejects.toMatchObject({ code: expect.stringMatching(/^(VALIDATION_ERROR|UNKNOWN_FLAG)$/) });
    expect(allMock).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("rejects management-group scope for every compute verb", async () => {
    for (const [run, argv] of [
      [runVm, ["list"]], [runVm, ["show", "--name", "vm-demo", "--resource-group", "rg-demo"]],
      [runVm, ["get-instance-view", "--ids", computeVm.id]],
      [runVmss, ["list"]], [runDisk, ["list"]],
    ] as const) {
      await expect(run([...argv, "--management-group", "mg-demo"])).rejects.toThrow("management-group scope is unsupported");
      expect(allMock).not.toHaveBeenCalled();
      expect(requestMock).not.toHaveBeenCalled();
    }
  });
});
