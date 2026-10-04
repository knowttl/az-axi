import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { AxiError } from "axi-sdk-js";

export type AuthMode = "az" | "token";
export type Resource = "arm" | "logs" | "graph";
export type CredentialResource = Resource | "storage" | "vault" | "registry";

/** Env var read for a `token` mode profile when its `tokenEnv` does not name one for a resource. */
export const DEFAULT_TOKEN_ENV: Record<Resource, string> = {
  arm: "AZ_AXI_ARM_TOKEN",
  logs: "AZ_AXI_LOGS_TOKEN",
  graph: "AZ_AXI_GRAPH_TOKEN",
};

export interface Profile {
  auth: AuthMode;
  tenant?: string;
  managementGroup?: string;
  subscriptions?: string[];
  /** Alias -> Log Analytics workspace ID (the workspace GUID, not the ARM resource ID). */
  workspaces?: Record<string, string>;
  tokenEnv?: Partial<Record<CredentialResource, string>>;
  description?: string;
  /** Only ever set by hand-editing the config file; no az-axi command writes it. */
  allowWrites?: boolean;
}

export interface ConfigFile {
  defaultProfile?: string;
  profiles: Record<string, Profile>;
}

export interface ResolvedProfile extends Profile {
  name: string;
  source: "flag" | "env" | "config-default" | "implicit";
  configPath?: string;
  /**
   * The subscriptions writes may target: copied from the config file BEFORE any
   * --subscription / $AZ_AXI_SUBSCRIPTION override, so a flag can never widen them.
   */
  writeSubscriptions: string[];
}

export interface WriteStatus {
  enabled: boolean;
  label: string;
}

export function configPath(explicit?: string): string {
  if (explicit) return resolvePath(explicit);
  if (process.env.AZ_AXI_CONFIG) return resolvePath(process.env.AZ_AXI_CONFIG);
  const local = resolvePath(process.cwd(), "az-axi.config.json");
  if (existsSync(local)) return local;
  return join(homedir(), ".az-axi", "config.json");
}

export function loadConfig(explicit?: string): { path: string; config?: ConfigFile } {
  const path = configPath(explicit);
  if (!existsSync(path)) return { path };
  let parsed: ConfigFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as ConfigFile;
  } catch (err) {
    throw new AxiError(
      `config file at ${path} is not valid JSON: ${(err as Error).message}`,
      "VALIDATION_ERROR",
      ["Fix the JSON syntax", "Or run `az-axi config init --name <name> --auth az` to rewrite it"],
    );
  }
  if (!parsed || typeof parsed !== "object" || !parsed.profiles || typeof parsed.profiles !== "object") {
    throw new AxiError(`config file at ${path} is missing a 'profiles' object`, "VALIDATION_ERROR", [
      "Expected shape: { defaultProfile, profiles: { name: { auth, tenant, subscriptions } } }",
      "Run `az-axi config init --name <name> --auth az` to rewrite it",
    ]);
  }
  return { path, config: parsed };
}

export function saveConfig(config: ConfigFile, explicit?: string): string {
  const path = configPath(explicit);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return path;
}

export interface ProfileFlags {
  profile?: string;
  tenant?: string;
  subscriptions?: string[];
  managementGroup?: string;
  config?: string;
}

/**
 * Resolution order: --profile > $AZ_AXI_PROFILE > config defaultProfile > the only
 * profile in the config > an implicit `{ auth: "az" }` profile named `az` when there
 * is no config at all, so the tool works right after `az login`.
 * --tenant / --subscription / --management-group (then $AZ_AXI_TENANT and
 * $AZ_AXI_SUBSCRIPTION) override the chosen profile's read scope.
 */
export function resolveProfile(flags: ProfileFlags = {}): ResolvedProfile {
  const { path, config } = loadConfig(flags.config);
  const profiles = config?.profiles ?? {};
  const names = Object.keys(profiles);

  if (flags.profile) return fromEntry(profiles, flags.profile, "flag", path, flags);
  if (process.env.AZ_AXI_PROFILE) {
    return fromEntry(profiles, process.env.AZ_AXI_PROFILE, "env", path, flags);
  }
  if (config?.defaultProfile) {
    return fromEntry(profiles, config.defaultProfile, "config-default", path, flags, true);
  }
  if (names.length === 1) {
    return fromEntry(profiles, names[0] as string, "config-default", path, flags);
  }
  if (names.length > 1) {
    throw new AxiError("several profiles are configured and none is selected", "VALIDATION_ERROR", [
      `Known profiles: ${names.join(", ")}`,
      "Pass --profile <name> or set $AZ_AXI_PROFILE",
      "Or set 'defaultProfile' in the config file",
    ]);
  }
  return applyOverrides(
    { name: "az", source: "implicit", auth: "az", writeSubscriptions: [] },
    flags,
  );
}

function fromEntry(
  profiles: Record<string, Profile>,
  name: string,
  source: ResolvedProfile["source"],
  path: string,
  flags: ProfileFlags,
  isDefault = false,
): ResolvedProfile {
  const entry = profiles[name];
  if (!entry) {
    throw new AxiError(
      isDefault ? `defaultProfile '${name}' is not defined in profiles` : `profile '${name}' not found`,
      "VALIDATION_ERROR",
      [
        `Known profiles: ${Object.keys(profiles).join(", ") || "(none)"}`,
        isDefault
          ? "Fix 'defaultProfile' in the config file"
          : "Run `az-axi config list` to see configured profiles",
      ],
    );
  }
  validateProfile(name, entry);
  return applyOverrides(
    { ...entry, name, source, configPath: path, writeSubscriptions: [...(entry.subscriptions ?? [])] },
    flags,
  );
}

/** Throws VALIDATION_ERROR for a profile that cannot be used safely. */
export function validateProfile(name: string, profile: Profile): void {
  const fail = (message: string, hint: string): never => {
    throw new AxiError(`profile '${name}': ${message}`, "VALIDATION_ERROR", [hint]);
  };
  if (profile.auth !== "az" && profile.auth !== "token") {
    fail(`'auth' must be "az" or "token"`, 'Set "auth": "az" in the config file');
  }
  if (profile.subscriptions !== undefined && !isStringArray(profile.subscriptions)) {
    fail("'subscriptions' must be an array of subscription IDs", "Fix 'subscriptions' in the config file");
  }
  if (
    (profile.allowWrites !== undefined && typeof profile.allowWrites !== "boolean") ||
    (profile.allowWrites === true && !profile.subscriptions?.length)
  ) {
    fail("has an invalid write configuration", "see README.md#writes");
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function applyOverrides(profile: ResolvedProfile, flags: ProfileFlags): ResolvedProfile {
  const envSubscriptions = splitList(process.env.AZ_AXI_SUBSCRIPTION);
  const subscriptions = flags.subscriptions ?? (envSubscriptions.length > 0 ? envSubscriptions : undefined);
  return {
    ...profile,
    tenant: flags.tenant ?? process.env.AZ_AXI_TENANT ?? profile.tenant,
    managementGroup: flags.managementGroup ?? profile.managementGroup,
    subscriptions: subscriptions ?? profile.subscriptions,
  };
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True when `$AZ_AXI_READ_ONLY` forces the whole process read-only. */
export function readOnlyForced(): boolean {
  return /^(1|true)$/i.test(process.env.AZ_AXI_READ_ONLY ?? "");
}

/**
 * Effective write status. Pass the subscriptions from the config file itself
 * (`writeSubscriptions` on a resolved profile), never an overridden read scope.
 */
export function writeStatus(
  allowWrites: boolean | undefined,
  writeSubscriptions: readonly string[],
): WriteStatus {
  if (readOnlyForced()) return { enabled: false, label: "disabled (AZ_AXI_READ_ONLY)" };
  if (allowWrites !== true) return { enabled: false, label: "disabled (default)" };
  const count = writeSubscriptions.length;
  if (count === 0) return { enabled: false, label: "disabled (invalid configuration)" };
  return { enabled: true, label: `ENABLED for ${count} ${count === 1 ? "subscription" : "subscriptions"}` };
}

export function tokenEnvFor(profile: Profile, resource: CredentialResource): string {
  return profile.tokenEnv?.[resource] ??
    (resource === "storage" ? "AZ_AXI_STORAGE_TOKEN" : resource === "vault" ? "AZ_AXI_VAULT_TOKEN" : resource === "registry" ? "AZ_AXI_REGISTRY_TOKEN" : DEFAULT_TOKEN_ENV[resource]);
}
