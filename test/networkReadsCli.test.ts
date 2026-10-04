import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leafHelp, COMMAND_LEAVES, type CommandLeaf } from "../src/lib/registry.js";
import {
  SUB_A, discoveryGroup,
  networkDnsRecordSets, networkDnsZone, networkDnsZones,
  networkNic, networkNics, networkNsg, networkNsgs,
  networkPrivateEndpoint, networkPrivateEndpoints, networkPublicIp, networkPublicIps,
  networkVnet, networkVnets, subscriptionList,
} from "./samples.js";

describe("built CLI network reads offline", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "az-axi-network-cli-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: {
      ci: { auth: "token", subscriptions: [SUB_A] },
    } }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  function run(argv: string[], mode = "normal") {
    const stub = `
      const data = ${JSON.stringify({
        discoveryGroup, networkNsgs, networkNics, networkVnets, networkPublicIps,
        networkPrivateEndpoints, networkDnsZones, networkDnsRecordSets, subscriptionList,
      })};
      const mode = ${JSON.stringify(mode)};
      const itemsFor = (path) => {
        if (path === '/subscriptions') return data.subscriptionList;
        if (path.endsWith('/networkSecurityGroups')) return mode === 'empty' ? [] : data.networkNsgs;
        if (path.endsWith('/networkInterfaces')) return mode === 'empty' ? [] : data.networkNics;
        if (path.endsWith('/virtualNetworks')) return mode === 'empty' ? [] : data.networkVnets;
        if (path.endsWith('/publicIPAddresses')) return mode === 'empty' ? [] : data.networkPublicIps;
        if (path.endsWith('/privateEndpoints')) return mode === 'empty' ? [] : data.networkPrivateEndpoints;
        if (path.endsWith('/dnszones')) return mode === 'empty' ? [] : data.networkDnsZones;
        const recordSets = path.match(/\\/dnszones\\/[^/]+\\/recordsets$/i);
        const byType = path.match(/\\/dnszones\\/[^/]+\\/([A-Za-z]+)$/i);
        if (recordSets) return mode === 'empty' ? [] : data.networkDnsRecordSets;
        if (byType) return (mode === 'empty' ? [] : data.networkDnsRecordSets)
          .filter((record) => record.id.toUpperCase().includes('/' + byType[1].toUpperCase() + '/'));
        return undefined;
      };
      globalThis.fetch = async (url, options) => {
        process.stderr.write(JSON.stringify({url, method: options.method}) + '\\n');
        if (options.method !== 'GET') throw new Error('non-GET request');
        const path = new URL(url).pathname;
        if (mode === 'denied' && path.includes('/providers/Microsoft.Network/')) {
          return Response.json({error:{code:'AuthorizationFailed',message:'Denied'}},{status:403});
        }
        const items = itemsFor(path);
        if (items) return Response.json({value: items});
        const all = [...data.networkNsgs, ...data.networkNics, ...data.networkVnets,
          ...data.networkPublicIps, ...data.networkPrivateEndpoints,
          ...data.networkDnsZones, ...data.networkDnsRecordSets];
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
  const selectors = ["--resource-group", "rg-demo"];

  it("lists every collection and shows one row of each by name and ARM ID", () => {
    const nsg = run(["network", "nsg", "list", ...selectors]);
    expect(nsg.status, nsg.stdout).toBe(0);
    expect(nsg.stdout).toContain("nsg-web");
    expect(nsg.stdout).toContain("total: 2");
    expect(nsg.stderr).toContain("Microsoft.Network/networkSecurityGroups?api-version=2024-05-01");
    const rule = run(["network", "nsg", "show", "--name", "nsg-web", ...selectors]);
    expect(rule.status, rule.stdout).toBe(0);
    expect(decode(rule.stdout)).toMatchObject({ totalRules: 3 });
    expect(run(["network", "nsg", "show", "--ids", networkNsg.id]).stdout).toContain("allow-https");

    const nic = run(["network", "nic", "list", ...selectors]);
    expect(nic.status, nic.stdout).toBe(0);
    expect(nic.stdout).toContain("10.0.1.4");
    expect(run(["network", "nic", "show", "--ids", networkNic.id]).stdout).toContain("ipconfig1");

    const vnet = run(["network", "vnet", "list", ...selectors]);
    expect(vnet.status, vnet.stdout).toBe(0);
    expect(vnet.stdout).toContain("10.0.0.0/16");
    expect(run(["network", "vnet", "show", "--ids", networkVnet.id]).stdout).toContain("hub-peer");

    const pip = run(["network", "public-ip", "list", ...selectors]);
    expect(pip.status, pip.stdout).toBe(0);
    expect(pip.stdout).toContain("203.0.113.10");
    expect(run(["network", "public-ip", "show", "--ids", networkPublicIp.id]).stdout).toContain("pip-demo.westus.cloudapp.azure.com");

    const pe = run(["network", "private-endpoint", "list", ...selectors]);
    expect(pe.status, pe.stdout).toBe(0);
    expect(pe.stdout).toContain("stexample");
    expect(run(["network", "private-endpoint", "show", "--ids", networkPrivateEndpoint.id]).stdout).toContain("10.0.2.4");

    const zone = run(["network", "dns", "zone", "list", ...selectors]);
    expect(zone.status, zone.stdout).toBe(0);
    expect(zone.stdout).toContain("example.com");
    expect(zone.stderr).toContain("Microsoft.Network/dnszones?api-version=2018-05-01");
    expect(run(["network", "dns", "zone", "show", "--ids", networkDnsZone.id]).stdout).toContain("ns1.example.com.");

    const records = run(["network", "dns", "record-set", "list", ...selectors, "--zone-name", "example.com"]);
    expect(records.status, records.stdout).toBe(0);
    expect(records.stdout).toContain("203.0.113.10");
    expect(records.stderr).toContain("dnszones/example.com/recordsets?api-version=2018-05-01");
    const record = run(["network", "dns", "record-set", "a", "show", ...selectors,
      "--zone-name", "example.com", "--name", "www"]);
    expect(record.status, record.stdout).toBe(0);
    expect(decode(record.stdout)).toMatchObject({ type: "A", ttl: "3600" });
  });

  it("accepts short flags and filters record sets by type", () => {
    const short = run(["network", "nsg", "list", "-g", "rg-demo", "-s", SUB_A]);
    expect(short.status, short.stdout).toBe(0);
    expect(short.stdout).toContain("total: 2");
    const typed = run(["network", "dns", "record-set", "cname", "list", ...selectors, "--zone-name", "example.com"]);
    expect(typed.status, typed.stdout).toBe(0);
    expect(typed.stdout).toContain("shop.contoso.com.");
    expect(typed.stdout).not.toContain("203.0.113.10");
  });

  it("reports empty and access-denied output", () => {
    expect(run(["network", "nsg", "list", ...selectors], "empty").stdout).toContain("0 network security groups found in subscription");
    expect(run(["network", "dns", "record-set", "list", ...selectors, "--zone-name", "example.com"], "empty").stdout)
      .toContain("0 DNS record sets found in subscription");
    const denied = run(["network", "nsg", "list", ...selectors], "denied");
    expect(denied.status).toBe(2);
    expect(denied.stdout).toContain("FORBIDDEN");
  });

  it.each([
    ["network", "nsg", "update", ...selectors],
    ["network", "nsg", "list", ...selectors, "--fields", "properties"],
    ["network", "nsg", "show", "--name", "nsg-web"],
    ["network", "nsg", "show", "--name", "nsg-web", ...selectors, "--ids", networkNsg.id],
    ["network", "nsg", "show", "--ids", `${networkNic.id}`],
    ["network", "dns", "zone", "delete", ...selectors],
    ["network", "dns", "record-set", "list", ...selectors],
    ["network", "dns", "record-set", "list", ...selectors, "--zone-name", "example.com", "--record-type", "BOGUS"],
    ["network", "dns", "record-set", "show", "--zone-name", "example.com", ...selectors, "--name", "www"],
    ["network", "dns", "record-set", "a", "show", "--ids", networkDnsRecordSets[1]!.id],
    ["network", "dns", "record-set", "a", "show", ...selectors, "--name", "www"],
    ["network", "nic", "show", "--name", networkNic.id],
  ])("refuses %j without network transport", (...argv) => {
    const result = run(argv);
    expect(result.status, result.stdout).toBe(2);
    expect(result.stderr).toBe("");
  });

  it("prints leaf help matching the registry without Azure access", () => {
    for (const path of COMMAND_LEAVES.filter((leaf: CommandLeaf) => leaf.path.startsWith("network ")).map((leaf) => leaf.path)) {
      const leaf = COMMAND_LEAVES.find((entry: CommandLeaf) => entry.path === path)!;
      const result = run([...path.split(" "), "--help"]);
      expect(result.status).toBe(0);
      expect(result.stdout.trimEnd()).toBe(leafHelp(leaf, path).trimEnd());
    }
  });

  it("emits a runnable detail hint for the first row", () => {
    const list = run(["network", "nsg", "list", ...selectors]);
    expect(list.status, list.stdout).toBe(0);
    const command = (decode(list.stdout) as { help: string[] }).help[0]!;
    const followed = run(command.split("`")[1]!.replace(/^az-axi /, "").split(" "));
    expect(followed.status, followed.stdout).toBe(0);
    expect(decode(followed.stdout)).toMatchObject({ name: "nsg-empty" });
  });
});
