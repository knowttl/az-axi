import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { countTokens } from "./tokens.mjs";
import { COMMAND_HELP } from "../../dist/help.js";

if (process.argv.length !== 2) throw new Error("Usage: node scripts/benchmark/capture-surface.mjs");
const root = fileURLToPath(new URL("../../", import.meta.url));
const skill = readFileSync(new URL("../../skills/az-axi/SKILL.md", import.meta.url), "utf8");
const match = skill.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
if (!match) throw new Error("Skill frontmatter is missing");
const help = {};
for (const command of [null, ...Object.keys(COMMAND_HELP)]) {
  const child = spawnSync(process.execPath, ["dist/bin/az-axi.js", ...(command ? [command] : []), "--help"], {
    cwd: root, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "", AZ_AXI_READ_ONLY: "1" },
  });
  if (child.error || child.status !== 0) throw new Error("Help surface capture failed");
  help[command ?? "topLevel"] = countTokens(child.stdout);
}
const result = { tokenizer: "o200k_base", skill: {
  frontmatter: countTokens(match[0]), body: countTokens(skill.slice(match[0].length)), total: countTokens(skill),
}, help, helpTotal: Object.values(help).reduce((sum, tokens) => sum + tokens, 0) };
writeFileSync(new URL("../../benchmark/tool-surface.json", import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
