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

export interface GraphScope {
  subscriptions?: string[];
  managementGroups?: string[];
  label: string;
}

function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

function subscriptionLabel(count: number): string {
  return `for ${count} subscription${count === 1 ? "" : "s"}`;
}

function requireValue(args: ParsedArgs, name: string, example: string): void {
  if (!(name in args.flags)) return;
  const value = args.flags[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new AxiError(`flag --${name} needs a non-empty value`, "VALIDATION_ERROR", [`Example: ${example}`]);
  }
}

/**
 * Resource Graph scope.
 * `$AZ_AXI_SUBSCRIPTION` overrides a profile management group. `resolveProfile`
 * copies that env var onto `subscriptions` without clearing `managementGroup`,
 * so the env var has to be read here or the group wins and the override is ignored.
 */
export function graphScope(profile: ResolvedProfile, args: ParsedArgs): GraphScope {
  requireValue(args, "subscription", "--subscription <id>");
  requireValue(args, "management-group", "--management-group <name>");
  const flagMg = flagString(args, "management-group");
  const flagSubs = flagList(args, "subscription");
  const envSubs = uniqueIds(
    (process.env.AZ_AXI_SUBSCRIPTION ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  if (flagMg) return { managementGroups: [flagMg], label: `in management group ${flagMg}` };
  if (flagSubs?.length) {
    const ids = uniqueIds(flagSubs);
    return { subscriptions: ids, label: subscriptionLabel(ids.length) };
  }
  if (envSubs.length > 0) return { subscriptions: envSubs, label: subscriptionLabel(envSubs.length) };
  if (profile.managementGroup) {
    return { managementGroups: [profile.managementGroup], label: `in management group ${profile.managementGroup}` };
  }
  if (profile.subscriptions?.length) {
    const ids = uniqueIds(profile.subscriptions);
    return { subscriptions: ids, label: subscriptionLabel(ids.length) };
  }
  return { label: "across accessible subscriptions" };
}

/** Selector flags from this invocation, so a follow-up command keeps the same scope. */
export function scopeFlags(args: ParsedArgs): string {
  const mg = flagString(args, "management-group");
  const subs = flagString(args, "subscription");
  if (mg) return ` --management-group ${mg}`;
  if (subs) return ` --subscription ${subs}`;
  return "";
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
