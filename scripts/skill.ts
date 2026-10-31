import { readFileSync, writeFileSync } from "node:fs";
import { skillMarkdown } from "../dist/lib/skill.js";
import { commandListMarkdown } from "../dist/lib/registry.js";

const HELP = {
  usage: "node scripts/skill.ts [--check | --help]",
  description: "Generate skills/az-axi/SKILL.md and the docs/commands.md table from the CLI's own description and leaf registry. No network, no Azure access.",
  flags: ["--check: refuse a stale skill without writing", "--help: print this reference"],
  examples: ["node scripts/skill.ts", "node scripts/skill.ts --check"],
};
const SKILL_FILE = new URL("../skills/az-axi/SKILL.md", import.meta.url);
const COMMANDS_FILE = new URL("../docs/commands.md", import.meta.url);

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
const commands = readFileSync(COMMANDS_FILE, "utf8");
const registryBlock = /<!-- command-registry:start -->[\s\S]*?<!-- command-registry:end -->/;
if (!registryBlock.test(commands)) throw new Error("docs/commands.md is missing command registry markers");
const expectedCommands = commands.replace(registryBlock,
  `<!-- command-registry:start -->\n${commandListMarkdown()}\n<!-- command-registry:end -->`);
if (args[0] === "--check") {
  const actual = readFileSync(SKILL_FILE, "utf8");
  if (actual !== expected || commands !== expectedCommands) {
    process.stderr.write("error: skill or command reference is stale; run `node scripts/skill.ts` to regenerate\n");
    process.exit(1);
  }
  process.stdout.write("SKILL.md and command reference are current\n");
} else {
  writeFileSync(SKILL_FILE, expected);
  writeFileSync(COMMANDS_FILE, expectedCommands);
  process.stdout.write("wrote skills/az-axi/SKILL.md and docs/commands.md registry table\n");
}
