import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  CAPABILITIES, COMMAND_LEAVES, COMMANDS, COMMAND_HELP, TOP_LEVEL_HELP,
  assertEffectAllows, commandListMarkdown, commandMeta, leafHelp, runWithEffect, type CommandLeaf,
} from "../src/lib/registry.js";

/** Expand only documented command paths, stopping before arguments, flags or comments. */
function documentedLeaves(help: string): string[] {
  return [...new Set(help.split("\n").filter((line) => line.startsWith("az-axi")).flatMap((line) => {
    const words = line.trim().split(/\s+/).slice(1);
    let paths = [""];
    for (const word of words) {
      if (!/^[a-z][a-z-]*(\|[a-z][a-z-]*)*$/.test(word)) break;
      paths = paths.flatMap((path) => word.split("|").map((part) => `${path} ${part}`.trim()));
    }
    return paths.map((path) => path || "home");
  }))].sort();
}

describe("exact leaf contracts", () => {
  it("records canonical query leaves while retaining legacy aliases", () => {
    expect(COMMAND_LEAVES.map((leaf) => leaf.path)).toEqual([
      "home", "doctor", "config init", "config list", "config path", "sub list",
      "account list", "account show", "monitor log-analytics workspace list", "monitor log-analytics workspace show",
      "monitor metrics alert list", "monitor metrics alert show", "monitor action-group list", "monitor action-group show",
      "monitor diagnostic-settings list", "monitor diagnostic-settings show", "monitor metrics list",
      "group list", "group show", "resource list", "resource show", "tag update",
      "graph query", "rbac list", "activity list", "defender alerts", "defender alerts get",
      "security pricing list", "security pricing show",
      "security sub-assessment list", "security sub-assessment show",
      "security alert update", "defender assessments", "defender score", "sentinel incident list", "sentinel incident show",
      "sentinel incident list-alert", "sentinel incident list-entity", "sentinel incident update", "sentinel incident comment create",
      "sentinel alert-rule list", "sentinel alert-rule show", "sentinel data-connector list", "sentinel data-connector show", "exposure", "monitor log-analytics query", "api", "op status", "az group show",
      "storage container list", "storage container show", "storage blob list", "storage blob show",
      "keyvault secret list", "keyvault key list", "keyvault certificate list",
      "acr repository list", "acr repository show-tags", "acr manifest show-metadata",
      "network nsg list", "network nsg show", "network nsg rule create", "network nic list", "network nic show",
      "network vnet list", "network vnet show", "network public-ip list", "network public-ip show",
      "network private-endpoint list", "network private-endpoint show",
      "network dns zone list", "network dns zone show",
      "policy assignment list", "policy assignment show",
      "policy definition list", "policy definition show",
      "policy set-definition list", "policy set-definition show", "policy state list",
      "lock list", "lock show", "deny-assignment list", "deny-assignment show",
      "role definition list", "role definition show",
      "network dns record-set list",
      "network dns record-set a list", "network dns record-set a show",
      "network dns record-set aaaa list", "network dns record-set aaaa show",
      "network dns record-set caa list", "network dns record-set caa show",
      "network dns record-set cname list", "network dns record-set cname show",
      "network dns record-set mx list", "network dns record-set mx show",
      "network dns record-set ns list", "network dns record-set ns show",
      "network dns record-set ptr list", "network dns record-set ptr show",
      "network dns record-set soa list", "network dns record-set soa show",
      "network dns record-set srv list", "network dns record-set srv show",
      "network dns record-set txt list", "network dns record-set txt show",
      "vm list", "vm show", "vm get-instance-view",
      "vmss list", "vmss show", "disk list", "disk show",
    ]);
    expect(Object.keys(CAPABILITIES)).toEqual(["native", "passthrough", "api-only", "blocked", "unsupported"]);
    expect(new Set(COMMAND_LEAVES.map((leaf) => leaf.path)).size).toBe(COMMAND_LEAVES.length);
    for (const leaf of COMMAND_LEAVES) {
      expect(leaf.capability).toBe(leaf.path === "az group show" ? "passthrough" : "native");
      expect(leaf.effect).toBe(leaf.path === "api" ? "dynamic" : leaf.path === "network nsg rule create" ? "destructive" : ["security alert update", "sentinel incident update", "sentinel incident comment create", "tag update"].includes(leaf.path) ? "write" : "read");
    }
  });

  it("keeps dispatch, module effects and help in agreement with every leaf", async () => {
    const names = [...new Set(COMMAND_LEAVES.map((leaf: CommandLeaf) => (leaf.handlerPath ?? leaf.path).split(" ")[0]))];
    expect(Object.keys(COMMANDS)).toEqual(names);
    expect(Object.keys(COMMAND_HELP)).toEqual(names);
    expect(documentedLeaves(Object.values(COMMAND_HELP).join("\n")))
      .toEqual(COMMAND_LEAVES.map((leaf: CommandLeaf) => leaf.handlerPath ?? leaf.path).sort());
    expect([...new Set(documentedLeaves(TOP_LEVEL_HELP).map((path) => path.split(" ")[0]))].sort())
      .toEqual([...new Set([...names, "graph", "role", "monitor", "security"])].sort());
    for (const name of names) {
      expect(typeof COMMAND_HELP[name]).toBe("string");
      const module = await COMMANDS[name!]!();
      expect(module.meta).toEqual(commandMeta(name!));
      for (const leaf of COMMAND_LEAVES.filter((leaf: CommandLeaf) => (leaf.handlerPath ?? leaf.path).split(" ")[0] === name)) {
        // Sentinel and security are mixed-effect modules: reads stay read while
        // the write verbs elevate to the write effect for their own requests only.
        if (name === "sentinel" && leaf.effect === "write") {
          expect(["sentinel incident update", "sentinel incident comment create"]).toContain(leaf.path);
        } else if (name === "security" && leaf.effect === "write") {
          expect(["security alert update"]).toContain(leaf.path);
        } else if (name === "network" && leaf.effect === "destructive") {
          // Network stays a read-effect module; the deny-rule verb elevates to
          // the destructive effect for its own requests only, as Sentinel does.
          expect(["network nsg rule create"]).toContain(leaf.path);
        } else {
          expect(leaf.effect).toBe(module.meta.effect);
        }
      }
    }
  });

  it.each(["\n", "\r\n"])("checks the committed generated command table with %j line endings", (lineEnding) => {
    const skill = readFileSync(new URL("../skills/az-axi/SKILL.md", import.meta.url), "utf8")
      .replace(/\r?\n/g, lineEnding);
    const block = skill.replace(/\r\n/g, "\n").split("<!-- command-registry:start -->\n")[1]?.split("\n<!-- command-registry:end -->")[0];
    expect(block).toBe(commandListMarkdown());
  });

  it("preserves the exact pre-registry help text", () => {
    // SHA-256 values captured from origin/main before centralizing the help source.
    const expected = {
      home: "d3ca0c70af59860ef81995074ea50c4ad93da1d0f3eab53cf287316e00cb2c25",
      doctor: "17f287915d3cd4c621533eec03a8f3079f30223f7015165b5a7a2460feab9ea1",
      config: "9055852012e73c38dc9e8203c351d4d832aa0ff03f255d8fc79330d1a9327052",
      sub: "6f9a9637c3fcd37decc544aeaa111c07b5d3ae8ed5d007a8f668ad5e80ea13ef",
      rg: "7c5e020a5c4bd1817201f9680c88a0d74caccb85130a0e69dd64e4b1e73bdc19",
      rbac: "114552b9a5fbe8c7516f37171150027994051bb061996386969031c47b7aced6",
      activity: "65bfc1e42c8358f8f92b2e12f86e40bbbcade07230055db7d19dd8f09c7961b0",
      defender: "abf0481253893cc00df76b0b5cc375f98a76a4b91c109538f23de13dd19d0332",
      exposure: "3c34ade43fa8d6c15499e009490c9c2387d1db7b2d54840a831a960c21e682b1",
      logs: "92a81f09f11afb0f16e2949bb90af133634798cdfb3f777ce9ff4c553c2ffa06",
      api: "8a363b22d6122afb9b2ebdc58d3e20236cb3f4de14fe23700de8b6f1bd957547",
      op: "5d038ba3c945dab73d8b9a9b75deffcad095974054b8d1f6650c4e1041886629",
    };
    expect(Object.fromEntries(Object.entries(COMMAND_HELP)
      .filter(([name]) => !["az", "security", "group", "resource", "storage", "keyvault", "account", "monitor", "sentinel", "acr", "tag", "network", "policy", "lock", "deny-assignment", "role", "vm", "vmss", "disk"].includes(name))
      .map(([name, help]) => [name, createHash("sha256").update(help).digest("hex")]))).toEqual(expected);
  });

  it.each(COMMAND_LEAVES.flatMap((leaf: CommandLeaf) => [leaf.path, ...leaf.aliases ?? []].map((path) => ({ leaf, path }))))("prints built CLI help for $path without Azure access", ({ leaf, path }) => {
    const guard = "globalThis.fetch=()=>{throw new Error('unexpected network request')};";
    const result = spawnSync(process.execPath, [
      "--import", `data:text/javascript,${encodeURIComponent(guard)}`,
      "dist/bin/az-axi.js", ...path.split(" "), "--help",
    ], { encoding: "utf8", env: { ...process.env, AZ_AXI_READ_ONLY: "1" } });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(leafHelp(leaf, path).trimEnd());
  });

  it("enforces registered read effects on requests and resets after failure", async () => {
    await expect(runWithEffect(commandMeta("defender").effect, async () => assertEffectAllows("write")))
      .rejects.toMatchObject({ code: "READ_ONLY" });
    // Sentinel stays a read-effect module; its write verbs elevate per verb.
    await expect(runWithEffect(commandMeta("sentinel").effect, async () => assertEffectAllows("write")))
      .rejects.toMatchObject({ code: "READ_ONLY" });
    expect(() => assertEffectAllows("write")).not.toThrow();
    await expect(runWithEffect(commandMeta("api").effect, async () => assertEffectAllows("write")))
      .resolves.toBeUndefined();
  });
});
