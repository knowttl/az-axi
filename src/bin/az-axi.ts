#!/usr/bin/env node
import { encode } from "@toon-format/toon";
import { AxiError, runAxiCli } from "axi-sdk-js";
import { normalizeArgv } from "../lib/argv.js";
import { WriteExecutionError } from "../lib/execute.js";
import { redact } from "../lib/redact.js";
import { COMMANDS, runCommand } from "../lib/registry.js";
import { packageInfo } from "../lib/version.js";
import { COMMAND_HELP, DESCRIPTION, TOP_LEVEL_HELP } from "../help.js";

const USAGE_CODES = new Set([
  "VALIDATION_ERROR",
  "UNKNOWN_FLAG",
  "AUTH_REQUIRED",
  "NOT_FOUND",
  "FORBIDDEN",
  "READ_ONLY",
  "WRITES_DISABLED",
  "SUBSCRIPTION_NOT_WRITABLE",
  "CONFIRM_REQUIRED",
  "CONFIRM_MISMATCH",
]);

function formatError(error: unknown): { output: string; exitCode: number } {
  if (error instanceof AxiError) {
    const out: Record<string, unknown> = { error: error.message, code: error.code,
      ...(error instanceof WriteExecutionError ? error.output : {}) };
    if (error.suggestions.length > 0) out.help = error.suggestions;
    return { output: `${encode(redact(out))}\n`, exitCode: USAGE_CODES.has(error.code) ? 2 : 1 };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { output: `${encode({ error: message, code: "UNKNOWN" })}\n`, exitCode: 1 };
}

function leadingFlagError(flag: string): string {
  return `${encode({
    error: `\`${flag}\` must come after the command`,
    code: "VALIDATION_ERROR",
    help: [
      `Run \`az-axi <command> [args] ${flag} <value>\``,
      "Run `az-axi --help` for the full command surface",
    ],
  })}\n`;
}

function unknownCommand(command: string): string {
  return `${encode({
    error: `unknown command \`${command}\``,
    code: "VALIDATION_ERROR",
    help: [
      "Run `az-axi --help` for the full command surface",
      "Run `az-axi` with no arguments for the dashboard",
    ],
  })}\n`;
}

const homeHandler = (args: string[]) => runCommand("home", args);

const normalized = normalizeArgv(process.argv.slice(2));
const first = normalized[0];
if (
  first !== undefined &&
  first.startsWith("-") &&
  !/^(--help|-v|-V|--version)$/.test(first)
) {
  process.stdout.write(leadingFlagError(first));
  process.exit(2);
}

await runAxiCli({
  description: DESCRIPTION,
  version: packageInfo().version,
  argv: normalized,
  topLevelHelp: TOP_LEVEL_HELP,
  getCommandHelp: (command) =>
    Object.hasOwn(COMMAND_HELP, command) ? COMMAND_HELP[command] ?? null : null,
  renderUnknownCommand: unknownCommand,
  formatError,
  home: homeHandler,
  commands: Object.assign(
    Object.create(null),
    Object.fromEntries(Object.keys(COMMANDS).map((name) => [name, (args: string[]) => runCommand(name, args)])),
    {
      update: async () => {
        throw new AxiError("unknown command `update`", "VALIDATION_ERROR", [
          "Run `az-axi --help` for the full command surface",
          "Run `az-axi` with no arguments for the dashboard",
        ]);
      },
    },
  ),
});
