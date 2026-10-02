import { AxiError } from "axi-sdk-js";
import { assertKnownFlags, flagBool, flagList, flagString, parseArgs } from "../lib/args.js";
import {
  DEFAULT_TOKEN_ENV,
  configPath,
  loadConfig,
  saveConfig,
  writeStatus,
  type AuthMode,
  type ConfigFile,
  type Profile,
  type Resource,
} from "../lib/config.js";
import { subcommandOf } from "../lib/context.js";
import { countLine, emptyState } from "../lib/format.js";
import { collapseHomeDirectory } from "../lib/paths.js";
import type { CommandMeta } from "../lib/registry.js";
import { existsSync } from "node:fs";

/** `config init` writes a local file only; it never touches Azure. */
export const meta: CommandMeta = { name: "config", effect: "read" };

const SUBCOMMANDS = ["init", "list", "path"] as const;
const INIT_FLAGS = ["name", "auth", "workspace", "token-env", "default"];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENV_VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const sub = subcommandOf(args, SUBCOMMANDS, "config");
  assertKnownFlags(args, sub === "init" ? INIT_FLAGS : [], `config ${sub}`);
  if (args.positionals.length > 1) {
    throw new AxiError(`unexpected argument \`${args.positionals[1]}\` for \`config ${sub}\``, "VALIDATION_ERROR", [
      `Run \`az-axi config --help\` for usage`,
    ]);
  }
  const explicit = flagString(args, "config");
  if (sub === "path") {
    const path = configPath(explicit);
    return { path: collapseHomeDirectory(path), exists: existsSync(path) };
  }
  if (sub === "list") return listProfiles(explicit);
  return initProfile(args, explicit);
}

function listProfiles(explicit: string | undefined): Record<string, unknown> {
  const { path, config } = loadConfig(explicit);
  const entries = Object.entries(config?.profiles ?? {});
  if (entries.length === 0) {
    return {
      config: collapseHomeDirectory(path),
      profiles: emptyState("profiles", `in ${collapseHomeDirectory(path)} (the implicit \`az\` profile is used)`),
      help: ["Run `az-axi config init --name <name> --auth az --tenant <tenant-id>` to create a profile"],
    };
  }
  const rows = entries.map(([name, p]) => ({
    name,
    auth: p.auth,
    tenant: p.tenant ?? "",
    scope: p.managementGroup
      ? `mg:${p.managementGroup}`
      : p.subscriptions?.length
        ? `${p.subscriptions.length} subscriptions`
        : "all",
    writes: writeStatus(p.allowWrites, p.subscriptions ?? []).label,
    description: p.description ?? "",
  }));
  return {
    config: collapseHomeDirectory(path),
    ...(config?.defaultProfile ? { defaultProfile: config.defaultProfile } : {}),
    count: countLine(rows.length, rows.length, "profiles"),
    profiles: rows,
    help: ["Run `az-axi doctor` to check each profile"],
  };
}

function initProfile(args: ReturnType<typeof parseArgs>, explicit: string | undefined): Record<string, unknown> {
  const name = flagString(args, "name") ?? "default";
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new AxiError(`invalid profile name '${name}'`, "VALIDATION_ERROR", [
      "Use letters, digits, dot, dash and underscore",
    ]);
  }
  const auth = (flagString(args, "auth") ?? "az") as AuthMode;
  if (auth !== "az" && auth !== "token") {
    throw new AxiError(`--auth must be 'az' or 'token', got '${auth}'`, "VALIDATION_ERROR", [
      "Example: --auth az",
    ]);
  }

  const profile: Profile = { auth };
  const tenant = flagString(args, "tenant");
  const managementGroup = flagString(args, "management-group");
  const subscriptions = flagList(args, "subscription");
  if (tenant) profile.tenant = tenant;
  if (managementGroup) profile.managementGroup = managementGroup;
  if (subscriptions?.length) profile.subscriptions = subscriptions;

  const workspaces = parseWorkspaces(flagList(args, "workspace"));
  if (workspaces) profile.workspaces = workspaces;

  const tokenEnv = parseTokenEnv(flagList(args, "token-env"));
  if (auth === "token") profile.tokenEnv = { ...DEFAULT_TOKEN_ENV, ...tokenEnv };
  else if (tokenEnv) {
    throw new AxiError("--token-env only applies with --auth token", "VALIDATION_ERROR", [
      "Add --auth token, or drop --token-env",
    ]);
  }

  // The profile is replaced wholesale and never carries `allowWrites`: enabling
  // writes is a human edit of the config file, and no flag exists for it.
  const { config: existing } = loadConfig(explicit);
  const config: ConfigFile = existing ?? { profiles: {} };
  config.profiles[name] = profile;
  const makeDefault = flagBool(args, "default") || !config.defaultProfile;
  if (makeDefault) config.defaultProfile = name;
  const path = saveConfig(config, explicit);

  return {
    saved: collapseHomeDirectory(path),
    profile: name,
    auth,
    default: makeDefault,
    writes: writeStatus(undefined, []).label,
    help: ["Run `az-axi doctor` to verify the profile", "Run `az-axi sub list` to see visible subscriptions"],
  };
}

function parseWorkspaces(entries: string[] | undefined): Record<string, string> | undefined {
  if (!entries?.length) return undefined;
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    const alias = eq > 0 ? entry.slice(0, eq) : "";
    const id = eq > 0 ? entry.slice(eq + 1) : "";
    if (!alias || !GUID.test(id)) {
      throw new AxiError(`invalid --workspace '${entry}'`, "VALIDATION_ERROR", [
        "Use alias=<workspace-id>, where the id is the workspace GUID (customer ID), not the ARM resource ID",
        "Example: --workspace sentinel=00000000-0000-0000-0000-000000000010",
      ]);
    }
    out[alias] = id;
  }
  return out;
}

function parseTokenEnv(entries: string[] | undefined): Partial<Record<Resource, string>> | undefined {
  if (!entries?.length) return undefined;
  const out: Partial<Record<Resource, string>> = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    const resource = entry.slice(0, eq);
    const variable = entry.slice(eq + 1);
    if (eq < 0 || !(resource in DEFAULT_TOKEN_ENV) || !ENV_VAR.test(variable)) {
      throw new AxiError(`invalid --token-env '${entry}'`, "VALIDATION_ERROR", [
        "Use resource=VARIABLE with resource arm, logs or graph",
        "Example: --token-env arm=AZ_AXI_ARM_TOKEN,logs=AZ_AXI_LOGS_TOKEN",
      ]);
    }
    out[resource as Resource] = variable;
  }
  return out;
}
