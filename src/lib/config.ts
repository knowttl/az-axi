import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath, win32 } from "node:path";
import { AxiError } from "axi-sdk-js";
import { readPrivateFile, toolDirectory, writePrivateFile } from "./privateFile.js";
import { registerSecret } from "./redact.js";

export type AuthMode = "az" | "token";
export type Resource = "arm" | "logs" | "graph";
export type CredentialResource = Resource | "storage" | "vault" | "registry";
export type SecretRef = { env: string } | { file: string } | { stored: true };
export const CREDENTIAL_RESOURCES: CredentialResource[] = ["arm", "logs", "graph", "storage", "vault", "registry"];
export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
let tokenEnvWarningPrinted = false;

/** Default token references for the original three API audiences. */
export const DEFAULT_TOKEN_ENV: Record<Resource, string> = {
  arm: "AZ_AXI_ARM_TOKEN",
  logs: "AZ_AXI_LOGS_TOKEN",
  graph: "AZ_AXI_GRAPH_TOKEN",
};

export interface Profile {
  auth: AuthMode;
  tenantId?: string;
  armToken?: SecretRef;
  logsToken?: SecretRef;
  graphToken?: SecretRef;
  storageToken?: SecretRef;
  vaultToken?: SecretRef;
  registryToken?: SecretRef;
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
  version: 1;
  defaultProfile?: string;
  profiles: Record<string, Profile>;
}

export interface ResolvedProfile extends Profile {
  /** Internal Azure selector, derived from tenantId or --tenant. */
  tenant?: string;
  name: string;
  source: "flag" | "env" | "config-default" | "implicit";
  configPath?: string;
  /**
   * The subscriptions writes may target: copied from the config file BEFORE any
   * --subscription flag override, so a flag can never widen them.
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
  return join(toolDirectory("config"), "config.json");
}

export function loadConfig(explicit?: string, verifyAcl = false): { path: string; config?: ConfigFile } {
  const path = configPath(explicit);
  if (!existsSync(path)) {
    // Inspect only existence at legacy locations; never open their contents.
    if (!explicit && !process.env.AZ_AXI_CONFIG) {
      for (const legacy of [join(homedir(), ".az-axi", "config.json"), resolvePath("az-axi.config.json")]) {
        if (existsSync(legacy)) {
          const quote = (value: string) => `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
          const move = process.platform === "win32"
            ? `New-Item -ItemType Directory -Force ${quote(toolDirectory("config"))}; Move-Item -LiteralPath ${quote(legacy)} -Destination ${quote(path)}`
            : `mkdir -p ${quote(toolDirectory("config"))} && mv -- ${quote(legacy)} ${quote(path)} && chmod 600 ${quote(path)}`;
          throw new AxiError(`configuration moved from ${legacy} to ${path}`, "CONFIG_MOVED", [move, "Update the moved file to version 1 and the credential-standard profile format"]);
        }
      }
    }
    // A dangling symlink is not an absent configuration.
    try { if (lstatSync(path).isSymbolicLink()) readPrivateFile(path, false, verifyAcl); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return { path };
  }
  const content = readPrivateFile(path, false, verifyAcl);
  let parsed: ConfigFile;
  try {
    parsed = JSON.parse(content) as ConfigFile;
  } catch {
    throw new AxiError(
      `config file at ${path} is not valid JSON`,
      "CONFIG_INVALID",
      ["Fix the JSON syntax", "Or run `az-axi config init --name <name> --auth az` to rewrite it"],
    );
  }
  if (!parsed || Array.isArray(parsed) || parsed.version !== 1 || !parsed.profiles || typeof parsed.profiles !== "object" || Array.isArray(parsed.profiles) ||
      Object.keys(parsed).some((key) => !["version", "defaultProfile", "profiles"].includes(key)) ||
      (parsed.defaultProfile !== undefined && (typeof parsed.defaultProfile !== "string" || !PROFILE_NAME.test(parsed.defaultProfile)))) {
    throw new AxiError(`config file at ${path} must contain version 1 and a 'profiles' object`, "CONFIG_INVALID", [
      "Expected shape: { version: 1, defaultProfile, profiles: { name: { auth, tenantId, subscriptions } } }",
      "Run `az-axi config init --name <name> --auth az` to rewrite it",
    ]);
  }
  for (const [name, profile] of Object.entries(parsed.profiles)) validateProfile(name, profile);
  return { path, config: parsed };
}

export function saveConfig(config: ConfigFile, explicit?: string): string {
  const path = configPath(explicit);
  for (const [name, profile] of Object.entries(config.profiles)) validateProfile(name, profile);
  writePrivateFile(path, `${JSON.stringify(config, null, 2)}\n`);
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
 * Explicit profile selectors precede the env profile, default and sole profile.
 * No config permits ambient Azure CLI auth. Only non-secret flags override the
 * selected profile; environment fields never override a file-selected profile.
 */
export function resolveProfile(flags: ProfileFlags = {}): ResolvedProfile {
  readOnlyForced();
  const { path, config } = loadConfig(flags.config);
  const profiles = config?.profiles ?? {};
  const names = Object.keys(profiles);

  if (flags.profile) return fromEntry(profiles, flags.profile, "flag", path, flags);
  if (process.env.AZ_AXI_PROFILE) {
    return fromEntry(profiles, process.env.AZ_AXI_PROFILE, "env", path, flags);
  }
  const envTenant = tenantEnvironment();
  const envSubscriptions = process.env.AZ_AXI_SUBSCRIPTIONS ?? process.env.AZ_AXI_SUBSCRIPTION;
  if (process.env.AZ_AXI_SUBSCRIPTION !== undefined) process.stderr.write("az-axi: AZ_AXI_SUBSCRIPTION is deprecated for one minor release; use AZ_AXI_SUBSCRIPTIONS\n");
  const arm = process.env.AZ_AXI_ARM_TOKEN;
  const tokenVariables = CREDENTIAL_RESOURCES.filter((resource) => process.env[`AZ_AXI_${resource.toUpperCase()}_TOKEN`]);
  if ((envTenant && tokenVariables.length) || (!arm && tokenVariables.length)) {
    throw new AxiError("env profile has mixed or partial credential sources", "CONFIG_INVALID", ["Set AZ_AXI_TENANT_ID for ambient auth, or AZ_AXI_ARM_TOKEN for token auth"]);
  }
  if (envTenant || arm) {
    return applyOverrides({ name: "env", source: "env", auth: arm ? "token" : "az", tenantId: envTenant,
      subscriptions: splitList(envSubscriptions), managementGroup: process.env.AZ_AXI_MANAGEMENT_GROUP, writeSubscriptions: [] }, flags);
  }
  if (envSubscriptions || process.env.AZ_AXI_MANAGEMENT_GROUP) {
    throw new AxiError("env profile is missing its credential source", "CONFIG_INVALID", ["Set AZ_AXI_TENANT_ID or AZ_AXI_ARM_TOKEN, or select a file profile explicitly"]);
  }
  if (config?.defaultProfile) {
    return fromEntry(profiles, config.defaultProfile, "config-default", path, flags, true);
  }
  if (names.length === 1) {
    return fromEntry(profiles, names[0] as string, "config-default", path, flags);
  }
  if (names.length > 1) {
    throw new AxiError("several profiles are configured and none is selected", "PROFILE_AMBIGUOUS", [
      `Known profiles: ${names.join(", ")}`,
      "Pass --profile <name> or set $AZ_AXI_PROFILE",
      "Or set 'defaultProfile' in the config file",
    ]);
  }
  if (config) throw new AxiError("no profiles are configured", "PROFILE_REQUIRED", ["Run `az-axi config init --name work --auth az`"]);
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
  const entry = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
  if (!entry) {
    throw new AxiError(
      isDefault ? `defaultProfile '${name}' is not defined in profiles` : `profile '${name}' not found`,
      "PROFILE_NOT_FOUND",
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

/** Reject invalid fields before a reference can read a secret or acquire a token. */
export function validateProfile(name: string, profile: Profile): void {
  const fail = (message: string, hint: string): never => {
    throw new AxiError(`profile '${name}': ${message}`, "CONFIG_INVALID", [hint]);
  };
  if (!PROFILE_NAME.test(name)) fail("invalid profile name", "Use 1-64 letters, digits, dash or underscore, starting with a letter or digit");
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) fail("must be an object", "Use a credential-standard profile");
  const known = ["auth", "tenantId", "managementGroup", "subscriptions", "workspaces", "tokenEnv", "description", "allowWrites", ...CREDENTIAL_RESOURCES.map((resource) => `${resource}Token`)];
  for (const key of Object.keys(profile)) if (!known.includes(key)) fail(`unknown field '${key}'`, "Remove the field; secrets must use SecretRefs");
  for (const key of ["tenantId", "managementGroup", "description"] as const) {
    if (profile[key] !== undefined && typeof profile[key] !== "string") fail(`'${key}' must be a string`, "Fix the field type");
  }
  if (profile.workspaces !== undefined && (!profile.workspaces || typeof profile.workspaces !== "object" || Array.isArray(profile.workspaces) || Object.values(profile.workspaces).some((value) => typeof value !== "string"))) {
    fail("'workspaces' must map aliases to workspace IDs", "Fix the workspace mapping");
  }
  for (const resource of CREDENTIAL_RESOURCES) {
    const ref = profile[`${resource}Token`];
    if (ref !== undefined) validateSecretRef(ref, `${resource}Token`);
  }
  if (profile.tokenEnv !== undefined) {
    if (!profile.tokenEnv || typeof profile.tokenEnv !== "object" || Array.isArray(profile.tokenEnv)) fail("'tokenEnv' must be an object", "Use resource Token SecretRef fields instead");
    for (const [resource, variable] of Object.entries(profile.tokenEnv)) {
      if (!CREDENTIAL_RESOURCES.includes(resource as CredentialResource) || typeof variable !== "string" || !ENV_NAME.test(variable)) fail("invalid tokenEnv reference", "Use valid resource names and environment variable names");
      if (profile[`${resource as CredentialResource}Token`] !== undefined) fail("conflicting token references", "Remove tokenEnv when using the corresponding SecretRef");
    }
    if (!tokenEnvWarningPrinted) {
      process.stderr.write("az-axi: tokenEnv is deprecated for one minor release; use resource Token SecretRef fields\n");
      tokenEnvWarningPrinted = true;
    }
  }
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
  return {
    ...profile,
    tenant: flags.tenant ?? profile.tenantId,
    tenantId: flags.tenant ?? profile.tenantId,
    managementGroup: flags.managementGroup ?? profile.managementGroup,
    subscriptions: flags.subscriptions ?? profile.subscriptions,
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
  const value = process.env.AZ_AXI_READ_ONLY;
  if (value !== undefined && !/^(1|true|0|false)$/i.test(value)) throw new AxiError("AZ_AXI_READ_ONLY must be 1, true, 0 or false", "CONFIG_INVALID");
  return /^(1|true)$/i.test(value ?? "");
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

function tenantEnvironment(): string | undefined {
  if (process.env.AZ_AXI_TENANT !== undefined) process.stderr.write("az-axi: AZ_AXI_TENANT is deprecated for one minor release; use AZ_AXI_TENANT_ID\n");
  return process.env.AZ_AXI_TENANT_ID ?? process.env.AZ_AXI_TENANT;
}

export function validateSecretRef(ref: unknown, field: string, platform = process.platform): asserts ref is SecretRef {
  const fail = () => { throw new AxiError(`'${field}' must be a valid SecretRef`, "CONFIG_INVALID", ["Use {env: NAME}, {file: absolutePath}, or {stored: true}"]); };
  if (!ref || typeof ref !== "object" || Array.isArray(ref) || Object.keys(ref).length !== 1) return fail();
  if ("env" in ref && typeof ref.env === "string" && ENV_NAME.test(ref.env)) return;
  if ("file" in ref && typeof ref.file === "string" && (platform === "win32" ? /^[A-Za-z]:[\\/]/.test(ref.file) && win32.isAbsolute(ref.file) : isAbsolute(ref.file))) return;
  if ("stored" in ref && ref.stored === true) return;
  fail();
}

export function secretRefFor(profile: Profile, resource: CredentialResource): SecretRef {
  return profile[`${resource}Token`] ?? { env: tokenEnvFor(profile, resource) };
}

export function resolveSecret(ref: SecretRef, verifyAcl = false): string {
  validateSecretRef(ref, "token");
  const value = "env" in ref ? process.env[ref.env] : "file" in ref ? readPrivateFile(ref.file, true, verifyAcl).replace(/^\uFEFF/, "").trimEnd() : undefined;
  if (!value) throw new AxiError("access token is unavailable from its SecretRef", "AUTH_REQUIRED", ["Supply the referenced environment variable or private token file; az-axi does not store credentials"]);
  registerSecret(value);
  return value;
}
