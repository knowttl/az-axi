import { AxiError } from "axi-sdk-js";
import { resolveProfile, type ResolvedProfile } from "./config.js";
import { flagList, flagString, type ParsedArgs } from "./args.js";

export function profileFromArgs(args: ParsedArgs): ResolvedProfile {
  return resolveProfile({
    profile: flagString(args, "profile"),
    tenant: flagString(args, "tenant"),
    subscriptions: flagList(args, "subscription"),
    managementGroup: flagString(args, "management-group"),
    config: flagString(args, "config"),
  });
}

export function subcommandOf(
  args: ParsedArgs,
  known: readonly string[],
  command: string,
  fallback?: string,
): string {
  const sub = args.positionals[0] ?? fallback;
  if (!sub || !known.includes(sub)) {
    throw new AxiError(
      sub ? `unknown subcommand \`${sub}\` for \`${command}\`` : `missing subcommand for \`${command}\``,
      "VALIDATION_ERROR",
      [`Expected one of: ${known.join(" | ")}`, `Run \`az-axi ${command} --help\` for usage`],
    );
  }
  return sub;
}
