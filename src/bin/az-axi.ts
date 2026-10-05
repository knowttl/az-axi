#!/usr/bin/env node
import { tryFastPath } from "axi-sdk-js/fast-path";
import { packageInfo } from "../lib/version.js";

const version = packageInfo().version;

// Fast path: answer a bare `-v`, `-V` or `--version` without importing the
// command catalogue or any heavy modules. No network, no config reads.
// Output matches runAxiCli's version handling (`<version>\n`, exit 0).
if (!tryFastPath(process.argv.slice(2), { version })) {
  const { encode } = await import("@toon-format/toon");
  const { AxiError, runAxiCli } = await import("axi-sdk-js");
  const { normalizeArgv } = await import("../lib/argv.js");
  const { routeArgv } = await import("../lib/router.js");
  const { WriteExecutionError } = await import("../lib/execute.js");
  const { redact } = await import("../lib/redact.js");
  const { COMMANDS, runCommand } = await import("../lib/registry.js");
  const { DESCRIPTION, TOP_LEVEL_HELP } = await import("../help.js");

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

  let normalized: string[];
  try {
    const route = routeArgv(normalizeArgv(process.argv.slice(2)));
    if (route.help !== undefined) {
      process.stdout.write(`${route.help}\n`);
      process.exit(0);
    }
    normalized = route.argv;
  } catch (error) {
    const formatted = formatError(error);
    process.stdout.write(formatted.output);
    process.exit(formatted.exitCode);
  }
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
    version,
    argv: normalized,
    topLevelHelp: TOP_LEVEL_HELP,
    // The router owns leaf help and respects literal --help after `--`.
    getCommandHelp: () => null,
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
}
