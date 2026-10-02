import spawn from "cross-spawn";
import { AxiError } from "axi-sdk-js";
import { tokenEnvFor, type Resource, type ResolvedProfile } from "./config.js";

export type { Resource } from "./config.js";

const MAX_AZ_OUTPUT_BYTES = 8 * 1024 * 1024;
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/** Token audience per resource; `graph` is requested through az's `--resource-type ms-graph`. */
const RESOURCE_URL: Record<Resource, string> = {
  arm: "https://management.azure.com/",
  logs: "https://api.loganalytics.io",
  graph: "https://graph.microsoft.com",
};

const AZ_RESOURCE_ARGS: Record<Resource, string[]> = {
  arm: ["--resource", RESOURCE_URL.arm],
  logs: ["--resource", RESOURCE_URL.logs],
  graph: ["--resource-type", "ms-graph"],
};

export interface Credential {
  header: string;
  mode: "token" | "az";
  /** Epoch milliseconds; absent when the source does not report an expiry. */
  expiresAt?: number;
}

export interface Identity {
  name: string;
  type: "user" | "servicePrincipal" | "managedIdentity";
  tenantId: string;
}

const cache = new Map<string, Credential>();

export async function resolveCredential(
  profile: ResolvedProfile,
  resource: Resource,
): Promise<Credential> {
  const key = `${profile.auth}:${resource}:${profile.tenant ?? ""}:${
    profile.auth === "token" ? tokenEnvFor(profile, resource) : ""
  }`;
  const hit = cache.get(key);
  if (hit && (hit.expiresAt === undefined || hit.expiresAt - Date.now() > EXPIRY_MARGIN_MS)) return hit;

  const credential =
    profile.auth === "token" ? tokenCredential(profile, resource) : await azCredential(profile, resource);
  cache.set(key, credential);
  return credential;
}

function tokenCredential(profile: ResolvedProfile, resource: Resource): Credential {
  const varName = tokenEnvFor(profile, resource);
  const token = process.env[varName];
  if (!token) {
    throw new AxiError(
      `access token env var $${varName} is not set (profile '${profile.name}', ${resource})`,
      "AUTH_REQUIRED",
      [
        `Set $${varName} to an access token for ${RESOURCE_URL[resource]}`,
        `Mint one with: az account get-access-token ${AZ_RESOURCE_ARGS[resource].join(" ")} --query accessToken --output tsv`,
        'Or switch the profile to "auth": "az"',
      ],
    );
  }
  return { header: `Bearer ${token}`, mode: "token" };
}

async function azCredential(profile: ResolvedProfile, resource: Resource): Promise<Credential> {
  let stdout: string;
  try {
    const azArgs = ["account", "get-access-token", ...AZ_RESOURCE_ARGS[resource], "--output", "json"];
    if (profile.tenant) azArgs.push("--tenant", profile.tenant);
    stdout = await runAz(azArgs);
  } catch (err) {
    throw azError(err instanceof Error ? err.message : String(err), profile, resource);
  }
  let parsed: { accessToken?: string; expiresOn?: string; expires_on?: number | string };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    throw azError("az returned output that is not JSON", profile, resource);
  }
  if (!parsed.accessToken) throw azError("no accessToken in az response", profile, resource);
  return {
    header: `Bearer ${parsed.accessToken}`,
    mode: "az",
    expiresAt: parseExpiry(parsed),
  };
}

/** az reports `expires_on` as epoch seconds and `expiresOn` as a naive local timestamp. */
function parseExpiry(parsed: { expiresOn?: string; expires_on?: number | string }): number | undefined {
  if (parsed.expires_on !== undefined) {
    const seconds = Number(parsed.expires_on);
    if (Number.isFinite(seconds)) return seconds * 1000;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(parsed.expiresOn ?? "");
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number, number, number, number, number, number,
  ];
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

function azError(message: string, profile: ResolvedProfile, resource: Resource): AxiError {
  const notInstalled = /az CLI is not installed/i.test(message);
  const conditionalAccess =
    !notInstalled && /AADSTS50076|AADSTS50079|AADSTS53003|claims/i.test(message);
  const notLoggedIn = !notInstalled && !conditionalAccess && /az login|not logged in|AADSTS|Please run/i.test(message);
  const tenantArg = profile.tenant ? ` --tenant ${profile.tenant}` : "";
  return new AxiError(
    notInstalled
      ? "Azure CLI ('az') is not installed or not on PATH"
      : conditionalAccess
        ? `Conditional Access requires additional sign-in (profile '${profile.name}')`
        : notLoggedIn
          ? `not signed in to Azure CLI (profile '${profile.name}')`
          : `could not acquire an Azure access token for ${resource} (profile '${profile.name}')`,
    "AUTH_REQUIRED",
    [
      ...(notInstalled
        ? ["Install the Azure CLI: https://learn.microsoft.com/cli/azure/install-azure-cli"]
        : conditionalAccess
          ? [`Run \`az logout\` then \`az login${tenantArg}\` to satisfy Conditional Access`]
          : [`Run \`az login${tenantArg}\``]),
      ...(notInstalled || conditionalAccess || notLoggedIn ? [] : [`az said: ${message.slice(0, 300)}`]),
      'Or switch the profile to "auth": "token" and supply a pre-acquired token',
      "Run `az-axi doctor` to re-check authentication",
    ],
  );
}

/** Who `az` is signed in as. Only meaningful for `az` mode profiles. */
export async function identityOf(profile: ResolvedProfile): Promise<Identity> {
  let stdout: string;
  try {
    stdout = await runAz(["account", "show", "--output", "json"]);
  } catch (err) {
    throw azError(err instanceof Error ? err.message : String(err), profile, "arm");
  }
  let parsed: { user?: { name?: string; type?: string }; tenantId?: string };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    throw azError("az returned output that is not JSON", profile, "arm");
  }
  const name = parsed.user?.name ?? "";
  const managed = name === "systemAssignedIdentity" || name === "userAssignedIdentity";
  return {
    name,
    type: managed ? "managedIdentity" : parsed.user?.type === "servicePrincipal" ? "servicePrincipal" : "user",
    tenantId: parsed.tenantId ?? "",
  };
}

/**
 * Spawns the Azure CLI and resolves with its stdout. Uses `cross-spawn` instead
 * of a raw `child_process.execFile`/`spawn` call because on Windows `az` is a
 * `.cmd` shim: Node's default (shell-less) spawn cannot execute it and fails
 * with ENOENT, wrongly implying the CLI is missing. `cross-spawn` resolves
 * `.cmd`/`.bat` shims correctly on Windows while still passing arguments
 * through as an argv array (not a shell command string), so there's no
 * shell-injection risk from argument values (e.g. `--tenant`).
 * The only place az-axi spawns `az`.
 */
export function runAz(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("az", args, {
      windowsHide: true,
      env: {
        ...process.env,
        AZURE_CORE_COLLECT_TELEMETRY: "no",
        AZURE_CORE_ONLY_SHOW_ERRORS: "true",
        AZURE_CORE_DISABLE_CONFIRM_PROMPT: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_AZ_OUTPUT_BYTES) stdout += chunk.toString();
      else truncated = true;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_AZ_OUTPUT_BYTES) stderr += chunk.toString();
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new Error("az CLI is not installed or not on PATH"));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (code === 0 && !truncated) {
        resolve(stdout);
      } else if (truncated) {
        reject(new Error("az CLI output exceeded the maximum buffer size"));
      } else {
        reject(new Error(stderr.trim() || `az exited with code ${code}`));
      }
    });
  });
}

export function clearCredentialCache(): void {
  cache.clear();
}
