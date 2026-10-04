import spawn from "cross-spawn";
import { AxiError } from "axi-sdk-js";
import { StringDecoder } from "node:string_decoder";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenEnvFor, type CredentialResource, type ResolvedProfile } from "./config.js";

export type { Resource } from "./config.js";

const MAX_AZ_OUTPUT_BYTES = 8 * 1024 * 1024;
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/** Token audience per resource; `graph` is requested through az's `--resource-type ms-graph`. */
const RESOURCE_URL: Record<CredentialResource, string> = {
  arm: "https://management.azure.com/",
  logs: "https://api.loganalytics.io",
  graph: "https://graph.microsoft.com",
  storage: "https://storage.azure.com/",
};

const AZ_RESOURCE_ARGS: Record<CredentialResource, string[]> = {
  arm: ["--resource", RESOURCE_URL.arm],
  logs: ["--resource", RESOURCE_URL.logs],
  graph: ["--resource-type", "ms-graph"],
  storage: ["--resource", RESOURCE_URL.storage],
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
  resource: CredentialResource,
  signal?: AbortSignal,
): Promise<Credential> {
  signal?.throwIfAborted();
  const key = `${profile.auth}:${resource}:${profile.tenant ?? ""}:${
    profile.auth === "token" ? tokenEnvFor(profile, resource) : ""
  }`;
  const hit = cache.get(key);
  if (hit && (hit.expiresAt === undefined || hit.expiresAt - Date.now() > EXPIRY_MARGIN_MS)) return hit;

  const credential =
    profile.auth === "token" ? tokenCredential(profile, resource) : await azCredential(profile, resource, signal);
  signal?.throwIfAborted();
  cache.set(key, credential);
  return credential;
}

function tokenCredential(profile: ResolvedProfile, resource: CredentialResource): Credential {
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

async function azCredential(profile: ResolvedProfile, resource: CredentialResource, signal?: AbortSignal): Promise<Credential> {
  let stdout: string;
  try {
    const azArgs = ["account", "get-access-token", ...AZ_RESOURCE_ARGS[resource], "--output", "json"];
    if (profile.tenant) azArgs.push("--tenant", profile.tenant);
    stdout = await runAz(azArgs, signal, resource === "storage");
  } catch (err) {
    signal?.throwIfAborted();
    if (resource === "storage") {
      throw new AxiError("could not acquire an Entra storage token", "AUTH_REQUIRED", [
        "Check the selected Azure CLI tenant and sign-in, or use a token profile with AZ_AXI_STORAGE_TOKEN",
        "Storage key and SAS fallback is disabled",
      ]);
    }
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

function azError(message: string, profile: ResolvedProfile, resource: CredentialResource): AxiError {
  const notInstalled = /az CLI is not installed/i.test(message);
  const conditionalAccess =
    !notInstalled && /AADSTS50076|AADSTS50079|AADSTS53003|claims/i.test(message);
  const notLoggedIn = !notInstalled && !conditionalAccess && /az login|not logged in/i.test(message);
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
 * The only place az-axi spawns `az`. Reviewed passthrough reads and storage
 * token acquisition additionally close stdin, strip ambient overrides, disable
 * extension install and enforce a 30-second deadline and a combined 1 MiB byte ceiling.
 * On Windows, cancellation requests tree termination with `taskkill` and
 * closes local pipes, rejecting with the signal reason without waiting for
 * termination. If `taskkill` cannot spawn, it falls back to killing the child.
 */
export function runAz(args: string[], signal?: AbortSignal, reviewedRead = false): Promise<string> {
  const bounds = new AbortController();
  let extensionDir: string | undefined;
  if (reviewedRead) {
    const deadline = AbortSignal.timeout(30_000);
    signal = AbortSignal.any([...(signal ? [signal] : []), deadline, bounds.signal]);
  }
  return new Promise<string>((resolve, reject) => {
    signal?.throwIfAborted();
    if (reviewedRead) extensionDir = mkdtempSync(join(tmpdir(), "az-axi-extensions-"));
    const windows = process.platform === "win32";
    const child = spawn("az", args, {
      windowsHide: true,
      shell: false,
      ...(reviewedRead ? { stdio: ["ignore", "pipe", "pipe"] as const } : {}),
      signal: windows ? undefined : signal,
      killSignal: "SIGKILL",
      env: {
        ...(reviewedRead ? Object.fromEntries(Object.entries(process.env).filter(([key]) =>
          /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|LANG|LC_ALL|AZURE_CONFIG_DIR|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|REQUESTS_CA_BUNDLE|SSL_CERT_FILE)$/i.test(key),
        )) : process.env),
        AZURE_CORE_COLLECT_TELEMETRY: "no",
        AZURE_CORE_ONLY_SHOW_ERRORS: "true",
        AZURE_CORE_DISABLE_CONFIRM_PROMPT: "1",
        ...(reviewedRead ? {
          // Azure CLI 2.77.0 reads these overrides before loading extensions;
          // empty dev_sources also overrides a persisted config value.
          AZURE_EXTENSION_DIR: extensionDir!,
          AZURE_EXTENSION_SYS_DIR: extensionDir!,
          AZURE_EXTENSION_DEV_SOURCES: "",
          AZURE_EXTENSION_USE_DYNAMIC_INSTALL: "no",
          AZURE_CORE_OUTPUT: "json",
          "AZURE_AUTO-UPGRADE_ENABLE": "no",
          AZURE_LOGGING_ENABLE_LOG_FILE: "no",
        } : {}),
      },
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const maxBytes = reviewedRead ? 1024 * 1024 : MAX_AZ_OUTPUT_BYTES;
    let outputBytes = 0;
    const decoder = new StringDecoder("utf8");

    const abort = () => {
      // Killing cmd.exe first can orphan az's Python process before taskkill finds it.
      if (child.pid !== undefined) {
        const killer = spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.once("error", () => child.kill("SIGKILL"));
        killer.unref();
      }
      // Inherited pipes must not keep the caller alive while tree termination finishes.
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      reject(signal!.reason);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (reviewedRead ? outputBytes <= maxBytes : stdout.length < maxBytes) stdout += decoder.write(chunk);
      else {
        truncated = true;
        if (reviewedRead) {
          bounds.abort(new Error("reviewed read output exceeded the maximum buffer size"));
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (reviewedRead ? outputBytes <= maxBytes : stderr.length < maxBytes) stderr += chunk.toString();
      else if (reviewedRead) {
        bounds.abort(new Error("reviewed read output exceeded the maximum buffer size"));
      }
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      signal?.removeEventListener("abort", abort);
      if (err.code === "ENOENT") {
        reject(new Error("az CLI is not installed or not on PATH"));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (code === 0 && !truncated) {
        resolve(stdout + decoder.end());
      } else if (truncated) {
        reject(new Error("az CLI output exceeded the maximum buffer size"));
      } else {
        reject(new Error(stderr.trim() || `az exited with code ${code}`));
      }
    });
    if (windows && signal) {
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    }
  }).finally(() => {
    if (extensionDir) rmSync(extensionDir, { recursive: true, force: true });
  });
}

export function clearCredentialCache(): void {
  cache.clear();
}
