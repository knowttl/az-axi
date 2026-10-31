#!/usr/bin/env node
import { tryFastPath } from "axi-sdk-js/fast-path";
import { packageInfo } from "../lib/version.js";
import type { CommandLeaf } from "../lib/registry.js";

const version = packageInfo().version;

// Fast path: answer a bare `-v`, `-V` or `--version` without importing the
// command catalogue or any heavy modules. No network, no config reads.
// Output matches runAxiCli's version handling (`<version>\n`, exit 0).
if (!tryFastPath(process.argv.slice(2), { version })) {
  const { encode } = await import("@toon-format/toon");
  const { AxiError, runAxiCli } = await import("axi-sdk-js");
  const { normalizeArgv } = await import("../lib/argv.js");
  const { routeArgv } = await import("../lib/router.js");
  const { formatError } = await import("../lib/errors.js");
  const { redactText } = await import("../lib/redact.js");
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = ((chunk: string | Uint8Array, ...args: unknown[]) =>
      Reflect.apply(write, stream, [redactText(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")), ...args])) as typeof stream.write;
  }
  const { COMMANDS, COMMAND_LEAVES, runCommand } = await import("../lib/registry.js");
  const { GLOBAL_FLAG_SCHEMA, SHORT_FLAGS } = await import("../lib/args.js");
  const { DESCRIPTION, TOP_LEVEL_HELP } = await import("../help.js");

  function leadingFlagError(flag: string): string {
    const raw = flag.replace(/^--?/, "").split("=")[0]!;
    const name = flag.startsWith("--") ? raw : Object.hasOwn(SHORT_FLAGS, raw) ? SHORT_FLAGS[raw]! : "";
    const supported = Object.hasOwn(GLOBAL_FLAG_SCHEMA, name) || COMMAND_LEAVES.some((leaf: CommandLeaf) =>
      [leaf.flags, leaf.canonicalFlags, leaf.canonicalFlagAliases, leaf.aliasFlags]
        .some((flags) => flags !== undefined && Object.hasOwn(flags, name)));
    return `${encode({
      error: supported ? `\`${flag}\` must come after the command` : `unknown flag \`${flag}\``,
      code: supported ? "VALIDATION_ERROR" : "UNKNOWN_FLAG",
      help: [
        supported
          ? "Place command flags after the complete command path; run `az-axi <command> --help` for usage"
          : `Valid global flags: ${Object.keys(GLOBAL_FLAG_SCHEMA).map((name) => `--${name}`).join(", ")}`,
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
      Object.fromEntries(Object.keys(COMMANDS).map((name) => [name, async (args: string[]) => {
        const output = await runCommand(name, args);
        if (name === "doctor" && output.status === "failed") process.exitCode = 1;
        return output;
      }])),
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
