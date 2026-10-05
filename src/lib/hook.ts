import { AxiError } from "axi-sdk-js";
import { assertKnownFlags, flagString, parseArgs } from "./args.js";
import { loadConfig, writeStatus } from "./config.js";
import { graphScope, profileFromArgs, scopeFlags } from "./context.js";
import { packageInfo } from "./version.js";

/**
 * Local-only session-start summary. Reads the config file and process
 * environment only: no network, no Azure call, no `az` subprocess. Shares its
 * profile resolution, scope labels and write-status wording with the home
 * dashboard, so the hook text cannot drift from the home view. Config and
 * profile problems return a short record instead of throwing, so the hook
 * entry point always exits 0; only unrecognized flags throw usage errors.
 */
export function sessionSummary(argv: string[]): Record<string, unknown> {
  const args = parseArgs(argv);
  assertKnownFlags(args, [], "hook");
  const version = packageInfo().version;
  try {
    const explicit = flagString(args, "config");
    const { config } = loadConfig(explicit);
    if (!config || Object.keys(config.profiles).length === 0) {
      return {
        profile: "not configured",
        version,
        help: ["Run `az-axi config init --name <name> --auth az` to create a profile"],
      };
    }
    const profile = profileFromArgs(args);
    const scope = graphScope(profile, args);
    const suffix = scopeFlags(args);
    return {
      profile: profile.name,
      scope: scope.label,
      writes: writeStatus(profile.allowWrites, profile.writeSubscriptions).label,
      version,
      help: [`Run \`az-axi${suffix}\` for the live dashboard`],
    };
  } catch (err) {
    const error = err as AxiError;
    const message = error instanceof AxiError ? error.message : String(error);
    const help = error instanceof AxiError && error.suggestions.length > 0
      ? error.suggestions
      : ["Run `az-axi doctor` to diagnose this profile"];
    return { error: message, help };
  }
}
