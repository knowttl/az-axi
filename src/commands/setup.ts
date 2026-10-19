import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AxiError, installSessionStartHooks, sessionStartHookStatus } from "axi-sdk-js";
import { assertKnownFlags, parseArgs } from "../lib/args.js";
import { subcommandOf } from "../lib/context.js";
import { commandFlags, commandMeta } from "../lib/registry.js";
import { assertDurableHookTarget } from "../lib/hookTarget.js";
import { installClaudeGuard } from "../lib/claudeGuard.js";

/** `setup hooks` writes agent-hook configuration only; it never touches Azure. */
export const meta = commandMeta("setup");

const SUBCOMMANDS = ["hooks"] as const;

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const sub = subcommandOf(args, SUBCOMMANDS, "setup");
  assertKnownFlags(args, commandFlags("setup hooks"), `setup ${sub}`);
  if (args.positionals.length > 1) {
    throw new AxiError(`unexpected argument \`${args.positionals[1]}\` for \`setup ${sub}\``, "VALIDATION_ERROR", [
      "Run `az-axi setup --help` for usage",
    ]);
  }
  return installHooks();
}

export interface InstallHooksOptions {
  /** Test seam: hook entry point to register. Defaults to the sibling binary. */
  execPath?: string;
  /** Test seam: agent home directory. Defaults to the real home. */
  homeDir?: string;
}

/**
 * Register the local-only hook entry point (`az-axi-hook`, not the
 * network-bound dashboard) as the SessionStart hook for Claude Code and Codex
 * plus the OpenCode ambient plugin, then report the actual per-agent state.
 */
export async function installHooks(options: InstallHooksOptions = {}): Promise<Record<string, unknown>> {
  const entry = options.execPath ?? hookEntrypoint();
  assertDurableHookTarget(entry);
  const guard = resolve(dirname(realpathSync(entry)), "../../scripts/claude-guard.mjs");
  if (!existsSync(guard)) {
    throw new AxiError("packaged approval guard not found", "NOT_FOUND", [
      "Reinstall @knowttl/az-axi, then retry `az-axi setup hooks`",
    ]);
  }
  assertDurableHookTarget(guard);
  // Validate and install approval protection before registering ambient context.
  installClaudeGuard(guard, options.homeDir);
  installSessionStartHooks({
    marker: "az-axi",
    execPath: entry,
    binaryNames: ["az-axi-hook"],
    distEntrypoints: ["dist/bin/az-axi-hook.js"],
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
  });
  const status = sessionStartHookStatus({ marker: "az-axi", ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }) });
  const agents = { claude: status.claude.installed, codex: status.codex.installed, opencode: status.opencode.installed };
  return {
    hooks: { status: Object.values(agents).every(Boolean) ? "installed" : "partial", ...agents, claudeGuard: true },
    help: ["Restart your agent session to receive az-axi ambient context"],
  };
}

/** The built hook binary next to the running CLI; missing before `pnpm build`. */
function hookEntrypoint(): string {
  const dir = fileURLToPath(new URL("../bin/", import.meta.url));
  const entry = ["az-axi-hook.js", "az-axi-hook"].map((name) => join(dir, name)).find((path) => existsSync(path));
  if (!entry) {
    throw new AxiError(`hook entry point not found next to ${join(dir, "az-axi")}`, "NOT_FOUND", [
      "Run `pnpm build` in the az-axi checkout, then retry `az-axi setup hooks`",
    ]);
  }
  return entry;
}
