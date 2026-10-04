import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ sendRequest: vi.fn(), request: vi.fn(), requestAll: vi.fn() }));

import { run } from "../src/commands/network.js";
import { request, requestAll } from "../src/lib/client.js";
import { clearSubscriptionCache } from "../src/lib/scope.js";
import {
  SUB_A, SUB_B, discoveryGroup,
  networkDnsRecordSetDetail, networkDnsRecordSets, networkDnsZone, networkDnsZones,
  networkNic, networkNics, networkNsg, networkNsgs,
  networkPrivateEndpoint, networkPrivateEndpoints, networkPublicIp, networkPublicIps,
  networkVnet, networkVnets,
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

function collectionItems(path: string): unknown[] | undefined {
  if (path.endsWith("/networkSecurityGroups")) return networkNsgs;
  if (path.endsWith("/networkInterfaces")) return networkNics;
  if (path.endsWith("/virtualNetworks")) return networkVnets;
  if (path.endsWith("/publicIPAddresses")) return networkPublicIps;
  if (path.endsWith("/privateEndpoints")) return networkPrivateEndpoints;
  if (path.endsWith("/dnszones")) return networkDnsZones;
  const recordSets = /\/dnszones\/[^/]+\/recordsets$/i.test(path);
  const byType = /\/dnszones\/[^/]+\/([A-Za-z]+)$/i.exec(path);
  if (recordSets) return networkDnsRecordSets;
  if (byType) return networkDnsRecordSets.filter((record) => record.id.toUpperCase().includes(`/${byType[1]!.toUpperCase()}/`));
  return undefined;
}

function mockTransport() {
  allMock.mockImplementation(async (_profile: unknown, requestOptions: Record<string, unknown>) => {
    const path = String(requestOptions["path"] ?? "");
    if (path === "/subscriptions") return { items: SUBSCRIPTIONS };
    const items = collectionItems(path);
    if (items) return { items };
    throw new Error(`unexpected offline path: ${path}`);
  });
  requestMock.mockImplementation(async (_profile: unknown, requestOptions: Record<string, unknown>) => {
    const path = String(requestOptions["path"] ?? "");
    const all = [networkNsg, networkNic, networkVnet, networkPublicIp, networkPrivateEndpoint, networkDnsZone,
      ...networkDnsRecordSets];
    const found = all.find((item) => item.id.toLowerCase() === path.toLowerCase());
    if (!found) throw new AxiError(`not found: ${path}`, "NOT_FOUND", []);
    return found as never;
  });
}

function useProfile(name = "ci", profile: Record<string, unknown> = { auth: "token", subscriptions: [SUB_A] }) {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { [name]: profile } }));
  process.env.AZ_AXI_PROFILE = name;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-network-"));
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

function listCalls(): Array<Record<string, unknown>> {
  return allMock.mock.calls.map((call) => call[1] as Record<string, unknown>);
}

describe("network nsg list", () => {
  it("lists compact rows with rule counts, location aggregates and a detail hint", async () => {
    const result = await run(["nsg", "list", "--resource-group", "rg-demo"]);
    expect(result).toMatchObject({
      profile: "ci",
      total: 2,
      count: "2 network security groups",
      byLocation: { westus: 1, westeurope: 1 },
      rows: [
        { name: "nsg-empty", id: networkNsgs[1]!.id, location: "westeurope", rules: 0 },
        { name: "nsg-web", id: networkNsg.id, location: "westus", rules: 3 },
      ],
    });
    expect(result.help).toEqual([expect.stringContaining("network nsg show --name nsg-empty")]);
    const options = listCalls();
    const list = options.find((call) => String(call["path"] ?? "").endsWith("/networkSecurityGroups"))!;
    expect(list["method"]).toBe("GET");
    expect(list["apiVersion"]).toBe("2024-05-01");
    expect(list["path"]).toBe(`/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Network/networkSecurityGroups`);
    for (const path of options.map((call) => String(call["path"] ?? ""))) {
      expect(path).not.toContain("?");
    }
  });

  it("filters by exact name and caps pages with lower-bound disclosure", async () => {
    const filtered = await run(["nsg", "list", "--name", "nsg-web"]);
    expect(filtered).toMatchObject({ total: 1, count: "1 network security groups" });
    const capped = await run(["nsg", "list", "--limit", "1"]);
    expect(capped).toMatchObject({ total: 2, count: "1 of 2 network security groups" });
    expect(capped.help).toEqual(expect.arrayContaining([expect.stringContaining("--full")]));
    const full = await run(["nsg", "list", "--full"]);
    expect((full.rows as unknown[])).toHaveLength(2);
    const fields = await run(["nsg", "list", "--fields", "name,rules"]);
    expect(fields.rows).toEqual([{ name: "nsg-empty", rules: 0 }, { name: "nsg-web", rules: 3 }]);
  });

  it("reports an explicit empty state", async () => {
    const result = await run(["nsg", "list", "--name", "missing"]);
    expect(result).toMatchObject({
      total: 0, count: "0 network security groups",
      rows: expect.stringContaining("0 network security groups found in subscription"),
    });
  });
});

describe("network nsg show", () => {
  it("shows rules with ports and attachments by name and ARM ID", async () => {
    const result = await run(["nsg", "show", "--name", "nsg-web", "--resource-group", "rg-demo"]);
    expect(result).toMatchObject({
      profile: "ci", name: "nsg-web", id: networkNsg.id, location: "westus",
      totalRules: 3, subscription: SUB_A,
      subnets: ["vnet-demo/default"], nics: ["nic-demo"],
    });
    const rules = result.rules as Array<Record<string, unknown>>;
    expect(rules).toHaveLength(3);
    expect(rules[0]).toMatchObject({
      name: "allow-https", priority: "100", direction: "Inbound", access: "Allow",
      protocol: "Tcp", source: "Internet", destination: "*", ports: "443",
    });
    expect(rules[1]).toMatchObject({ name: "deny-ssh-any", ports: "22, 3389", source: "0.0.0.0/0" });
    expect(rules[2]).toMatchObject({ name: "allow-sql-app", source: "asg-app", destination: "10.0.1.0/24", ports: "1433" });
    expect(result).not.toHaveProperty("help");
    await expect(run(["nsg", "show", "--ids", networkNsg.id]))
      .resolves.toMatchObject({ name: "nsg-web", totalRules: 3 });
    const options = requestMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(options["method"]).toBe("GET");
    expect(options["apiVersion"]).toBe("2024-05-01");
    const full = await run(["nsg", "show", "--name", "nsg-web", "--resource-group", "rg-demo", "--full"]);
    expect(full).toMatchObject({ tags: { env: "test" }, provisioningState: "Succeeded" });
  });

  it("caps long rule lists at the display limit with a full hint", async () => {
    const many = { ...networkNsg, properties: { ...networkNsg.properties,
      securityRules: Array.from({ length: 60 }, (_, index) => ({
        name: `rule-${index}`, properties: { protocol: "*", access: "Allow", priority: 100 + index, direction: "Inbound" },
      })) } };
    requestMock.mockResolvedValueOnce(many as never);
    const result = await run(["nsg", "show", "--name", "nsg-web", "--resource-group", "rg-demo"]);
    expect(result).toMatchObject({ totalRules: 60 });
    expect((result.rules as unknown[])).toHaveLength(50);
    expect(result.help).toEqual([expect.stringContaining("--full")]);
  });
});

describe("network nic and vnet reads", () => {
  it("lists NICs with private IPs and VMs, and shows IP configurations", async () => {
    const list = await run(["nic", "list"]);
    expect(list).toMatchObject({
      total: 1, count: "1 network interfaces",
      rows: [{ name: "nic-demo", id: networkNic.id, location: "westus", privateIp: "10.0.1.4", vm: "vm1" }],
    });
    const show = await run(["nic", "show", "--ids", networkNic.id]);
    expect(show).toMatchObject({
      name: "nic-demo", mac: "00-11-22-33-44-55", nsg: "nsg-web", vm: "vm1",
      totalIpConfigs: 1, subscription: SUB_A,
    });
    expect(show.ipConfigs).toEqual([{
      name: "ipconfig1", privateIp: "10.0.1.4", allocation: "Dynamic",
      subnet: "vnet-demo/default", publicIp: "pip-demo",
    }]);
  });

  it("lists VNets with prefixes and subnet counts, and shows subnets plus peerings", async () => {
    const list = await run(["vnet", "list"]);
    expect(list).toMatchObject({
      total: 1, count: "1 virtual networks",
      rows: [{ name: "vnet-demo", location: "westus", prefixes: "10.0.0.0/16", subnets: 2 }],
    });
    const show = await run(["vnet", "show", "--name", "vnet-demo", "--resource-group", "rg-demo"]);
    expect(show).toMatchObject({
      name: "vnet-demo", addressSpace: ["10.0.0.0/16"], totalSubnets: 2, totalPeerings: 1,
    });
    expect(show.subnets).toEqual([
      { name: "default", prefix: "10.0.1.0/24", nsg: "nsg-web", routeTable: "" },
      { name: "data", prefix: "10.0.2.0/24", nsg: "", routeTable: "rt-demo" },
    ]);
    expect(show.peerings).toEqual([{ name: "hub-peer", state: "Connected", remote: "vnet-hub" }]);
  });
});

describe("network public-ip and private-endpoint reads", () => {
  it("lists public IPs with addresses and attachments, and shows allocation plus FQDN", async () => {
    const list = await run(["public-ip", "list"]);
    expect(list).toMatchObject({
      total: 2, count: "2 public IP addresses",
      rows: [
        { name: "pip-demo", address: "203.0.113.10", associated: "nic-demo/ipconfig1" },
        { name: "pip-free", address: "", associated: "" },
      ],
    });
    const show = await run(["public-ip", "show", "--ids", networkPublicIp.id]);
    expect(show).toMatchObject({
      name: "pip-demo", address: "203.0.113.10", allocation: "Static", version: "IPv4",
      associated: "nic-demo/ipconfig1", fqdn: "pip-demo.westus.cloudapp.azure.com", sku: "Standard",
    });
    expect(show.zones).toEqual(["1"]);
  });

  it("lists private endpoints with service and status, and shows DNS configs", async () => {
    const list = await run(["private-endpoint", "list"]);
    expect(list).toMatchObject({
      total: 1, count: "1 private endpoints",
      rows: [{ name: "pe-storage", service: "stexample", status: "Approved" }],
    });
    const show = await run(["private-endpoint", "show", "--name", "pe-storage", "--resource-group", "rg-demo"]);
    expect(show).toMatchObject({
      name: "pe-storage", service: "stexample", status: "Approved",
      statusDescription: "Auto-approved", subnet: "vnet-demo/data",
      nics: ["pe-storage.nic.demo"], subscription: SUB_A,
    });
    expect(show.dns).toEqual([{ fqdn: "stexample.blob.core.windows.net", ips: "10.0.2.4" }]);
  });
});

describe("network dns zone and record-set reads", () => {
  it("lists zones with record counts and shows name servers", async () => {
    const list = await run(["dns", "zone", "list"]);
    expect(list).toMatchObject({
      total: 1, count: "1 DNS zones",
      rows: [{ name: "example.com", id: networkDnsZone.id, records: "3", nameServers: 2 }],
    });
    const listOptions = listCalls().find((call) => String(call["path"] ?? "").endsWith("/dnszones"))!;
    expect(listOptions["apiVersion"]).toBe("2018-05-01");
    const show = await run(["dns", "zone", "show", "--ids", networkDnsZone.id]);
    expect(show).toMatchObject({
      name: "example.com", records: "3", maxRecords: "10000",
      nameServers: ["ns1.example.com.", "ns2.example.com."],
    });
  });

  it("lists record sets with routed targets and type aggregates", async () => {
    const selectors = ["--zone-name", "example.com", "--resource-group", "rg-demo"];
    const list = await run(["dns", "record-set", "list", ...selectors]);
    expect(list).toMatchObject({
      total: 3, count: "3 DNS record sets",
      byType: { A: 1, CNAME: 1, TXT: 1 },
      rows: [
        { name: "@", type: "TXT", ttl: "3600", target: "v=spf1 include:contoso.com ~all" },
        { name: "shop", type: "CNAME", ttl: "300", target: "shop.contoso.com." },
        { name: "www", type: "A", ttl: "3600", target: "203.0.113.10" },
      ],
    });
    const listOptions = listCalls().find((call) => /\/dnszones\/[^/]+\/recordsets$/i.test(String(call["path"] ?? "")))!;
    expect(listOptions["apiVersion"]).toBe("2018-05-01");
    const typed = await run(["dns", "record-set", "list", ...selectors, "--record-type", "a"]);
    expect(typed).toMatchObject({ total: 1, count: "1 DNS record sets" });
    const typedOptions = listCalls().find((call) => /\/dnszones\/[^/]+\/A$/i.test(String(call["path"] ?? "")))!;
    expect(typedOptions).toBeDefined();
  });

  it("shows one record set with every routed value by name and ARM ID", async () => {
    const selectors = ["--zone-name", "example.com", "--resource-group", "rg-demo", "--name", "www", "--record-type", "A"];
    const show = await run(["dns", "record-set", "show", ...selectors]);
    expect(show).toMatchObject({
      name: "www", type: "A", ttl: "3600", fqdn: "www.example.com.",
      records: ["203.0.113.10"], subscription: SUB_A,
    });
    await expect(run(["dns", "record-set", "show", "--ids", networkDnsRecordSetDetail.id]))
      .resolves.toMatchObject({ name: "www", type: "A" });
    const options = requestMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(options["apiVersion"]).toBe("2018-05-01");
    expect(String(options["path"] ?? "")).toBe(
      `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Network/dnszones/example.com/A/www`);
  });
});

describe("network reads stay read-only and validate before transport", () => {
  it("rejects unknown verbs and leaves without transport", async () => {
    await expect(run(["nsg", "update"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["dns", "zone", "delete"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["nsg"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["dns"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["waf", "list"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(allMock).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("rejects bad selectors, flags and identities before transport", async () => {
    const selectors = ["--resource-group", "rg-demo"];
    await expect(run(["nsg", "list", ...selectors, "--kind", "Basic"]))
      .rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
    await expect(run(["nsg", "show", "--name", "nsg-web"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("--resource-group") });
    await expect(run(["nsg", "show", "--name", "nsg-web", ...selectors, "--ids", networkNsg.id]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("not both") });
    await expect(run(["nsg", "show", "--ids", `${networkNic.id}`]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("--ids must be one") });
    await expect(run(["nsg", "show", "--ids", `${networkNsg.id}?api-version=2024-05-01`]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("unescaped") });
    await expect(run(["nsg", "show", "--name", "a/b", ...selectors]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("one resource path segment") });
    await expect(run(["nsg", "list", ...selectors, "--fields", "properties"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("--fields supports only") });
    await expect(run(["nsg", "list", ...selectors, "--limit", "0"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["nsg", "list", ...selectors, "--management-group", "contoso-root"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("management-group") });
    await expect(run(["dns", "record-set", "list", ...selectors]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("--zone-name") });
    await expect(run(["dns", "record-set", "list", "--zone-name", "example.com", ...selectors, "--record-type", "BOGUS"]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("--record-type must be") });
    await expect(run(["dns", "record-set", "show", "--ids", `${networkDnsZone.id}/A`]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("record-set ARM ID") });
    await expect(run(["nsg", "list", ...selectors, "--zone-name", "example.com"]))
      .rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
    for (const argv of [
      ["nsg", "show", "--name", "nsg-web"],
      ["dns", "record-set", "list", ...selectors],
    ]) {
      allMock.mockClear();
      requestMock.mockClear();
      await expect(run(argv)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(allMock).not.toHaveBeenCalled();
      expect(requestMock).not.toHaveBeenCalled();
    }
  });

  it("uses the ID subscription for show --ids and refuses scope conflicts", async () => {
    useProfile("ci", { auth: "token" });
    await expect(run(["nsg", "show", "--ids", networkNsg.id]))
      .resolves.toMatchObject({ name: "nsg-web", subscription: SUB_A });
    useProfile("ci", { auth: "token", subscriptions: [SUB_B] });
    await expect(run(["nsg", "show", "--ids", networkNsg.id]))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("conflicts with selected subscriptions") });
  });

  it("surfaces access-denied failures without masking them as empty", async () => {
    requestMock.mockRejectedValueOnce(new AxiError("access denied: Denied", "FORBIDDEN", []));
    await expect(run(["nsg", "show", "--name", "nsg-web", "--resource-group", "rg-demo"]))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
