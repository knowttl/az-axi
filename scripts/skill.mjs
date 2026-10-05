import { readFileSync, writeFileSync } from "node:fs";
import { skillMarkdown } from "../dist/lib/skill.js";

const HELP = {
  usage: "node scripts/skill.mjs [--check | --help]",
  description: "Generate skills/az-axi/SKILL.md from the CLI's own description and leaf registry (src/lib/skill.ts). No network, no Azure access.",
  flags: ["--check: refuse a stale skill without writing", "--help: print this reference"],
  examples: ["node scripts/skill.mjs", "node scripts/skill.mjs --check"],
};
const SKILL_FILE = new URL("../skills/az-axi/SKILL.md", import.meta.url);

function help() {
  return [
    `usage: ${HELP.usage}`,
    "",
    HELP.description,
    "",
    ...HELP.flags.map((flag) => `  ${flag}`),
    "",
    ...HELP.examples.map((example) => `  ${example}`),
    "",
  ].join("\n");
}

const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write(help());
  process.exit(0);
}
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  process.stderr.write(`${help()}error: ${HELP.usage}\n`);
  process.exit(2);
}
const expected = skillMarkdown();
if (args[0] === "--check") {
  const actual = readFileSync(SKILL_FILE, "utf8");
  if (actual !== expected) {
    process.stderr.write("error: skills/az-axi/SKILL.md is stale; run `node scripts/skill.mjs` to regenerate\n");
    process.exit(1);
  }
  process.stdout.write("SKILL.md is current\n");
} else {
  writeFileSync(SKILL_FILE, expected);
  process.stdout.write("wrote skills/az-axi/SKILL.md\n");
}
