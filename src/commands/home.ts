import { AxiError } from "axi-sdk-js";
import { SUBSCRIPTIONS_LIST } from "../lib/apiVersions.js";
import { assertKnownFlags, flagString, parseArgs } from "../lib/args.js";
import { identityOf } from "../lib/auth.js";
import { requestAll } from "../lib/client.js";
import { loadConfig, writeStatus } from "../lib/config.js";
import { profileFromArgs } from "../lib/context.js";
import { DESCRIPTION } from "../help.js";
import { collapseHomeDirectory, homeHeader } from "../lib/paths.js";
import type { CommandMeta } from "../lib/registry.js";

export const meta: CommandMeta = { name: "home", effect: "read" };

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  assertKnownFlags(args, [], "home");
  if (args.positionals.length > 0) {
    throw new AxiError(`unexpected argument \`${args.positionals[0]}\` for \`home\``, "VALIDATION_ERROR", [
      "Run `az-axi` with no arguments for the dashboard",
      "Run `az-axi home --help` for usage",
    ]);
  }

  let profile: ReturnType<typeof profileFromArgs>;
  try {
    profile = profileFromArgs(args);
  } catch (err) {
    const error = err as AxiError;
    const { path, config } = loadConfig(flagString(args, "config"));
    const names = Object.keys(config?.profiles ?? {});
    return {
      ...homeHeader(DESCRIPTION),
      config: collapseHomeDirectory(path),
      profiles: names.length > 0 ? names : "(none; using the implicit az profile)",
      error: error.message,
      help: [
        ...error.suggestions,
        "Run `az-axi doctor` to check each profile",
        "Run `az-axi config init --name <name> --auth az` to create a profile",
      ],
    };
  }

  const [identitySettled, subsSettled] = await Promise.allSettled([
    profile.auth === "token"
      ? Promise.resolve({ name: "(token)", type: "token" as const, tenantId: profile.tenant ?? "" })
      : identityOf(profile),
    requestAll<unknown>(profile, { path: "/subscriptions", apiVersion: SUBSCRIPTIONS_LIST }, 100),
  ]);

  const help: string[] = [];
  const identity = identitySettled.status === "fulfilled" ? identitySettled.value : undefined;
  if (identitySettled.status === "rejected") {
    const error = identitySettled.reason as AxiError;
    help.push(`[identity] ${error instanceof AxiError ? error.message : String(error)}`);
    help.push(...(error instanceof AxiError ? error.suggestions.map((s) => `[identity] ${s}`) : []));
  }
  const subs = subsSettled.status === "fulfilled" ? subsSettled.value : undefined;
  if (subsSettled.status === "rejected") {
    const error = subsSettled.reason as AxiError;
    help.push(`[subscriptions] ${error instanceof AxiError ? error.message : String(error)}`);
  }

  const subscriptions = subs
    ? subs.nextLink
      ? `${subs.items.length}+`
      : subs.items.length
    : "-";
  const row = {
    ...homeHeader(DESCRIPTION),
    profile: profile.name,
    identity: identity?.name ?? (profile.auth === "token" ? "(token)" : "-"),
    type: identity?.type ?? (profile.auth === "token" ? "token" : "-"),
    tenant: identity && "tenantId" in identity && identity.tenantId ? identity.tenantId : (profile.tenant ?? ""),
    subscriptions,
    writes: writeStatus(profile.allowWrites, profile.writeSubscriptions).label,
  };

  if (help.length === 0) {
    help.push(
      "Run `az-axi sub list` to see visible subscriptions",
      'Run `az-axi rg query "Resources | take 5"` for a first inventory',
      "Run `az-axi doctor` to re-check this profile",
    );
  } else {
    help.push("Run `az-axi doctor` to diagnose this profile");
  }

  return {
    ...row,
    note: "Defender, score and exposure sections arrive in Phase 4",
    help,
  };
}
