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
      "group list", "group show", "resource list", "resource show",
      "graph query", "rbac list", "activity list", "defender alerts", "defender alerts get",
      "security alert update", "defender assessments", "defender score", "exposure", "monitor log-analytics query", "api", "op status", "az group show",
      "storage container list", "storage container show", "storage blob list", "storage blob show",
      "keyvault secret list", "keyvault secret show", "keyvault key list", "keyvault key show",
      "keyvault certificate list", "keyvault certificate show",
    ]);
    expect(Object.keys(CAPABILITIES)).toEqual(["native", "passthrough", "api-only", "blocked", "unsupported"]);
    expect(new Set(COMMAND_LEAVES.map((leaf) => leaf.path)).size).toBe(COMMAND_LEAVES.length);
    for (const leaf of COMMAND_LEAVES) {
      expect(leaf.capability).toBe(leaf.path === "az group show" ? "passthrough" : "native");
      expect(leaf.effect).toBe(leaf.path === "api" ? "dynamic" : leaf.path === "security alert update" ? "write" : "read");
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
        expect(leaf.effect).toBe(module.meta.effect);
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
      .filter(([name]) => !["az", "security", "group", "resource", "storage", "account", "monitor", "keyvault"].includes(name))
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
    expect(() => assertEffectAllows("write")).not.toThrow();
    await expect(runWithEffect(commandMeta("api").effect, async () => assertEffectAllows("write")))
      .resolves.toBeUndefined();
  });
});
