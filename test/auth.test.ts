import { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { spawn as spawnChild } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";

vi.mock("cross-spawn", () => ({ default: vi.fn() }));

import spawn from "cross-spawn";
import { clearCredentialCache, identityOf, resolveCredential, runAz } from "../src/lib/auth.js";
import { request } from "../src/lib/client.js";
import { pollOperation } from "../src/lib/lro.js";
import type { ResolvedProfile } from "../src/lib/config.js";
import { redact } from "../src/lib/redact.js";

const TOKEN = "az-tok-5b2e8a-distinctive-secret";
const spawnMock = vi.mocked(spawn) as unknown as ReturnType<typeof vi.fn>;

type Outcome = { code?: number; stdout?: string; stderr?: string; error?: NodeJS.ErrnoException };

function fakeAz(outcome: Outcome | ((args: string[]) => Outcome)) {
  spawnMock.mockImplementation((_cmd: string, args: string[]) => {
    const result = typeof outcome === "function" ? outcome(args) : outcome;
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    setTimeout(() => {
      if (result.error) return child.emit("error", result.error);
      if (result.stdout) child.stdout.emit("data", Buffer.from(result.stdout));
      if (result.stderr) child.stderr.emit("data", Buffer.from(result.stderr));
      child.emit("close", result.code ?? 0);
    }, 0);
    return child;
  });
}

const tokenJson = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ accessToken: TOKEN, expires_on: Math.floor(Date.now() / 1000) + 3600, ...extra });

function profile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return { name: "work", source: "implicit", auth: "az", writeSubscriptions: [], ...overrides };
}

async function failure(promise: Promise<unknown>): Promise<AxiError> {
  try {
    await promise;
  } catch (err) {
    return err as AxiError;
  }
  throw new Error("expected failure");
}

const render = (error: AxiError) =>
  encode(redact({ error: error.message, code: error.code, help: error.suggestions }));

beforeEach(() => {
  clearCredentialCache();
  spawnMock.mockReset();
});

afterEach(() => {
  delete process.env.AZ_AXI_ARM_TOKEN;
  delete process.env.MY_LOGS_TOKEN;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("az mode", () => {
  it("storage requests only the Entra audience and strips hostile storage and extension environment", async () => {
    vi.stubEnv("AZURE_STORAGE_KEY", "hostile-key");
    vi.stubEnv("AZURE_STORAGE_SAS_TOKEN", "sig=hostile");
    vi.stubEnv("AZURE_STORAGE_CONNECTION_STRING", "AccountKey=hostile");
    vi.stubEnv("AZURE_STORAGE_AUTH_MODE", "key");
    vi.stubEnv("AZURE_EXTENSION_DEV_SOURCES", "/hostile");
    fakeAz({ stdout: tokenJson() });
    const result = await resolveCredential(profile({ tenant: "tenant-example" }), "storage");
    expect(result.header).toBe(`Bearer ${TOKEN}`);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![1]).toEqual(["account", "get-access-token", "--resource", "https://storage.azure.com/", "--output", "json", "--tenant", "tenant-example"]);
    const options = spawnMock.mock.calls[0]![2];
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(options.env.AZURE_STORAGE_KEY).toBeUndefined();
    expect(options.env.AZURE_STORAGE_SAS_TOKEN).toBeUndefined();
    expect(options.env.AZURE_STORAGE_CONNECTION_STRING).toBeUndefined();
    expect(options.env.AZURE_STORAGE_AUTH_MODE).toBeUndefined();
    expect(options.env.AZURE_EXTENSION_DEV_SOURCES).toBe("");
    expect(options.env.AZURE_EXTENSION_USE_DYNAMIC_INSTALL).toBe("no");
  });

  it("storage authentication failure does not expose child diagnostics or try keys", async () => {
    fakeAz({ code: 1, stderr: `credential-value ${TOKEN}` });
    const error = await failure(resolveCredential(profile(), "storage"));
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(render(error)).not.toContain(TOKEN);
    expect(render(error)).not.toContain("credential-value");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("vault requests only the Entra audience with isolated extensions", async () => {
    vi.stubEnv("AZURE_EXTENSION_DEV_SOURCES", "/hostile");
    fakeAz({ stdout: tokenJson() });
    const result = await resolveCredential(profile({ tenant: "tenant-example" }), "vault");
    expect(result.header).toBe(`Bearer ${TOKEN}`);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![1]).toEqual(["account", "get-access-token", "--resource", "https://vault.azure.net/", "--output", "json", "--tenant", "tenant-example"]);
    const options = spawnMock.mock.calls[0]![2];
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(options.env.AZURE_EXTENSION_DEV_SOURCES).toBe("");
    expect(options.env.AZURE_EXTENSION_USE_DYNAMIC_INSTALL).toBe("no");
  });

  it("vault authentication failure names the vault token and never a key fallback", async () => {
    fakeAz({ code: 1, stderr: `credential-value ${TOKEN}` });
    const error = await failure(resolveCredential(profile(), "vault"));
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(render(error)).toContain("AZ_AXI_VAULT_TOKEN");
    expect(render(error)).not.toContain(TOKEN);
    expect(render(error)).not.toContain("credential-value");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
  it.each(["arm", "logs", "graph"] as const)("cancels pending %s credentials and closes the child pipes", async (resource) => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const controller = new AbortController();
    const reason = new Error("poll deadline");
    let child: ReturnType<typeof spawnChild> | undefined;
    let closed: Promise<unknown> | undefined;
    spawnMock.mockImplementation((_cmd, _args, options) => {
      child = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
      closed = new Promise((resolve) => child!.once("close", (code, signal) => resolve({ code, signal })));
      return child;
    });
    const pending = resolveCredential(profile(), resource, controller.signal);
    const assertion = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await assertion;
    expect(await closed).toEqual({ code: null, signal: "SIGKILL" });
    expect(child?.stdout?.destroyed).toBe(true);
    expect(child?.stderr?.destroyed).toBe(true);
    fakeAz({ stdout: tokenJson() });
    expect((await resolveCredential(profile(), resource)).header).toBe(`Bearer ${TOKEN}`);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("does not spawn for an already cancelled credential request", async () => {
    const reason = new Error("poll deadline");
    await expect(resolveCredential(profile(), "arm", AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each(["asyncOperationUrl", "locationUrl"])("kills uncached authentication at the %s polling deadline", async (key) => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    let closed: Promise<unknown> | undefined;
    spawnMock.mockImplementation((_cmd, _args, options) => {
      const child = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
      closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
      return child;
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(pollOperation(profile(), {
      [key]: "https://management.azure.com/operations/1?api-version=1",
    }, { timeoutMs: 50 })).rejects.toMatchObject({ code: "OPERATION_TIMEOUT" });
    expect(await closed).toEqual({ code: null, signal: "SIGKILL" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks az for the right audience per resource and hardens the spawn", async () => {
    fakeAz({ stdout: tokenJson() });
    const p = profile({ tenant: "00000000-0000-0000-0000-000000000001" });
    await resolveCredential(p, "arm");
    await resolveCredential(p, "logs");
    await resolveCredential(p, "graph");

    const calls = spawnMock.mock.calls.map(([, args]) => args as string[]);
    expect(calls[0]).toEqual([
      "account", "get-access-token", "--resource", "https://management.azure.com/",
      "--output", "json", "--tenant", "00000000-0000-0000-0000-000000000001",
    ]);
    expect(calls[1]).toContain("https://api.loganalytics.io");
    expect(calls[2]).toEqual(expect.arrayContaining(["--resource-type", "ms-graph"]));
    expect(calls[2]).not.toContain("--resource");

    const options = spawnMock.mock.calls[0]?.[2] as { env: Record<string, string>; windowsHide: boolean };
    expect(options.windowsHide).toBe(true);
    expect(options.env).toMatchObject({
      AZURE_CORE_COLLECT_TELEMETRY: "no",
      AZURE_CORE_ONLY_SHOW_ERRORS: "true",
      AZURE_CORE_DISABLE_CONFIRM_PROMPT: "1",
    });
  });

  it("caches per resource and tenant", async () => {
    fakeAz({ stdout: tokenJson() });
    const p = profile();
    expect((await resolveCredential(p, "arm")).header).toBe(`Bearer ${TOKEN}`);
    await resolveCredential(p, "arm");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await resolveCredential(p, "logs");
    await resolveCredential(profile({ tenant: "other" }), "arm");
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });

  it("treats a token expiring within 5 minutes as missing", async () => {
    fakeAz({ stdout: tokenJson({ expires_on: Math.floor(Date.now() / 1000) + 200 }) });
    await resolveCredential(profile(), "arm");
    await resolveCredential(profile(), "arm");
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("reads the naive local expiresOn timestamp", async () => {
    const soon = new Date(Date.now() + 60_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const expiresOn = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())} ${pad(soon.getHours())}:${pad(soon.getMinutes())}:${pad(soon.getSeconds())}.000000`;
    fakeAz({ stdout: JSON.stringify({ accessToken: TOKEN, expiresOn }) });
    await resolveCredential(profile(), "arm");
    await resolveCredential(profile(), "arm");
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("maps a missing az binary", async () => {
    fakeAz({ error: Object.assign(new Error("spawn az ENOENT"), { code: "ENOENT" }) });
    const error = await failure(resolveCredential(profile(), "arm"));
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(error.message).toContain("not installed");
    expect(error.suggestions.join("\n")).toContain("install-azure-cli");
  });

  it("maps a signed-out az and suggests the tenant-specific login", async () => {
    fakeAz({ code: 1, stderr: "ERROR: Please run 'az login' to setup account." });
    const error = await failure(resolveCredential(profile({ tenant: "contoso.example.com" }), "arm"));
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(error.message).toContain("not signed in");
    expect(error.suggestions).toContain("Run `az login --tenant contoso.example.com`");
  });

  it.each(["AADSTS50076", "AADSTS50079", "AADSTS53003", "Interactive authentication is needed, claims challenge"])(
    "maps Conditional Access error %s",
    async (stderr) => {
      fakeAz({ code: 1, stderr });
      const error = await failure(resolveCredential(profile({ tenant: "contoso.example.com" }), "arm"));
      expect(error.suggestions).toContain(
        "Run `az logout` then `az login --tenant contoso.example.com` to satisfy Conditional Access",
      );
    },
  );

  it("maps other az failures, malformed output and missing tokens", async () => {
    fakeAz({ code: 1, stderr: "ERROR: something odd" });
    const generic = await failure(resolveCredential(profile(), "arm"));
    expect(generic.code).toBe("AUTH_REQUIRED");
    expect(generic.suggestions.join("\n")).toContain("something odd");

    for (const stderr of [
      "AADSTS700016 application was not found",
      "AADSTS7000215 invalid client secret",
      "Please run 'az account set'",
    ]) {
      clearCredentialCache();
      fakeAz({ code: 1, stderr });
      const error = await failure(resolveCredential(profile(), "arm"));
      expect(error.message).not.toContain("not signed in");
      expect(error.suggestions.join("\n")).toContain(`az said: ${stderr}`);
      clearCredentialCache();
      fakeAz({ code: 1, stderr });
      const identity = await failure(identityOf(profile()));
      expect(identity.message).not.toContain("not signed in");
      expect(identity.suggestions.join("\n")).toContain(`az said: ${stderr}`);
    }

    clearCredentialCache();
    fakeAz({ stdout: "not json" });
    expect((await failure(resolveCredential(profile(), "arm"))).code).toBe("AUTH_REQUIRED");
    fakeAz({ stdout: JSON.stringify({ tenant: "x" }) });
    expect((await failure(resolveCredential(profile(), "arm"))).code).toBe("AUTH_REQUIRED");
  });

  it("rejects az output over the size cap", async () => {
    // The cap only trips after a chunk lands past it, so send two chunks.
    spawnMock.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      setTimeout(() => {
        child.stdout.emit("data", Buffer.alloc(9 * 1024 * 1024));
        child.stdout.emit("data", Buffer.alloc(10));
        child.emit("close", 0);
      }, 0);
      return child;
    });
    expect((await failure(resolveCredential(profile(), "arm"))).code).toBe("AUTH_REQUIRED");
  });
});

describe("runAz cancellation", () => {
  function childProcess(pid = 1234) {
    return Object.assign(new EventEmitter(), {
      pid,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      unref: vi.fn(),
    });
  }

  it("hardens reviewed reads and never inherits token, logging or extension overrides", async () => {
    vi.stubEnv("AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "yes_without_prompt");
    vi.stubEnv("AZURE_CORE_LOG_LEVEL", "debug");
    vi.stubEnv("AZURE_EXTENSION_DIR", "untrusted");
    vi.stubEnv("AZ_AXI_ARM_TOKEN", TOKEN);
    fakeAz({ stdout: "{}" });
    await runAz(["version", "--output", "json"], undefined, true);
    const options = spawnMock.mock.calls[0]![2];
    expect(options).toMatchObject({ shell: false, stdio: ["ignore", "pipe", "pipe"], env: {
      AZURE_EXTENSION_USE_DYNAMIC_INSTALL: "no", AZURE_CORE_OUTPUT: "json", AZURE_CORE_DISABLE_CONFIRM_PROMPT: "1",
    } });
    expect(options.env.AZURE_CORE_LOG_LEVEL).toBeUndefined();
    expect(options.env.AZURE_EXTENSION_SYS_DIR).toBe(options.env.AZURE_EXTENSION_DIR);
    expect(options.env.AZURE_EXTENSION_DEV_SOURCES).toBe("");
    expect(existsSync(options.env.AZURE_EXTENSION_DIR)).toBe(false);
    expect(options.env.AZ_AXI_ARM_TOKEN).toBeUndefined();
    expect(options.env).toEqual({
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|LANG|LC_ALL|AZURE_CONFIG_DIR|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|REQUESTS_CA_BUNDLE|SSL_CERT_FILE)$/i.test(key),
      )),
      AZURE_CORE_COLLECT_TELEMETRY: "no", AZURE_CORE_ONLY_SHOW_ERRORS: "true", AZURE_CORE_DISABLE_CONFIRM_PROMPT: "1",
      AZURE_EXTENSION_DIR: options.env.AZURE_EXTENSION_DIR, AZURE_EXTENSION_SYS_DIR: options.env.AZURE_EXTENSION_DIR,
      AZURE_EXTENSION_DEV_SOURCES: "", AZURE_EXTENSION_USE_DYNAMIC_INSTALL: "no", AZURE_CORE_OUTPUT: "json",
      "AZURE_AUTO-UPGRADE_ENABLE": "no", AZURE_LOGGING_ENABLE_LOG_FILE: "no",
    });
    vi.unstubAllEnvs();
  });

  it("applies a 30-second deadline before launching a reviewed read", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    spawnMock.mockReturnValueOnce(childProcess()).mockReturnValueOnce(childProcess(5678));
    const pending = runAz(["version", "--output", "json"], undefined, true);
    const extensionDir = spawnMock.mock.calls[0]![2].env.AZURE_EXTENSION_DIR;
    expect(readdirSync(extensionDir)).toEqual([]);
    const assertion = expect(pending).rejects.toThrow("deadline");
    deadline.abort(new Error("deadline"));
    await assertion;
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(spawnMock.mock.calls.map(([command]) => command)).toEqual(["az", "taskkill"]);
    expect(existsSync(extensionDir)).toBe(false);
    timeout.mockRestore();
  });

  it("rejects a reviewed read before spawning when already cancelled", async () => {
    await expect(runAz(["version"], AbortSignal.abort(new Error("cancelled")), true)).rejects.toThrow("cancelled");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each(["stdout", "stderr"] as const)("kills the Windows process tree when reviewed %s exceeds its byte limit", async (stream) => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const child = childProcess();
    spawnMock.mockReturnValueOnce(child).mockReturnValueOnce(childProcess(5678));
    const pending = runAz(["version"], undefined, true);
    const assertion = expect(pending).rejects.toThrow("maximum buffer size");
    child[stream].write(Buffer.alloc(1024 * 1024 + 1));
    await assertion;
    expect(spawnMock.mock.calls[1]?.[0]).toBe("taskkill");
    expect(child.stdout.destroyed).toBe(true);
  });

  it("preserves UTF-8 characters split across child output chunks", async () => {
    const child = childProcess();
    spawnMock.mockReturnValueOnce(child);
    const pending = runAz(["version"], undefined, true);
    const bytes = Buffer.from('"é"');
    child.stdout.write(bytes.subarray(0, 2));
    child.stdout.write(bytes.subarray(2));
    child.emit("close", 0);
    expect(await pending).toBe('"é"');
  });

  it("kills the Windows tree and settles without waiting for inherited pipes or taskkill", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const child = childProcess();
    const killer = childProcess(5678);
    spawnMock.mockReturnValueOnce(child).mockReturnValueOnce(killer);
    const controller = new AbortController();
    const reason = new Error("credential deadline");
    const pending = runAz(["group", "show"], controller.signal, true);
    let rejected: unknown;
    const settled = pending.catch((error) => { rejected = error; });
    controller.abort(reason);

    expect(spawnMock.mock.calls.map(([command]) => command)).toEqual(["az", "taskkill"]);
    expect(spawnMock.mock.calls[1]?.slice(1)).toEqual([["/T", "/F", "/PID", "1234"], {
      windowsHide: true,
      stdio: "ignore",
    }]);
    expect(spawnMock.mock.calls[0]?.[2].signal).toBeUndefined();
    await settled;
    expect(rejected).toBe(reason);
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.stdin.destroyed).toBe(true);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.unref).toHaveBeenCalledOnce();
    expect(killer.unref).toHaveBeenCalledOnce();
  });

  it("settles the Windows polling deadline without a child close event or a network call", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const child = childProcess();
    const killer = childProcess(5678);
    spawnMock.mockReturnValueOnce(child).mockReturnValueOnce(killer);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(pollOperation(profile(), {
      asyncOperationUrl: "https://management.azure.com/operations/1?api-version=1",
    }, { timeoutMs: 25 })).rejects.toMatchObject({ code: "OPERATION_TIMEOUT" });
    expect(spawnMock.mock.calls.map(([command]) => command)).toEqual(["az", "taskkill"]);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles a taskkill spawn failure without delaying cancellation", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const child = childProcess();
    const killer = childProcess(5678);
    spawnMock.mockReturnValueOnce(child).mockReturnValueOnce(killer);
    const controller = new AbortController();
    const pending = runAz([], controller.signal, true);
    const reason = new Error("credential deadline");
    const assertion = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    killer.emit("error", Object.assign(new Error("missing taskkill"), { code: "ENOENT" }));
    await assertion;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it.each(["linux", "darwin"])("preserves native SIGKILL cancellation on %s", async (platform) => {
    vi.stubGlobal("process", { ...process, platform });
    const child = childProcess();
    spawnMock.mockImplementation((_cmd, _args, options) => {
      options.signal.addEventListener("abort", () => {
        child.kill(options.killSignal);
        child.emit("error", new Error("native abort"));
      }, { once: true });
      return child;
    });
    const controller = new AbortController();
    const pending = runAz([], controller.signal);
    const assertion = expect(pending).rejects.toThrow("native abort");
    controller.abort();
    await assertion;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(child.unref).not.toHaveBeenCalled();
    expect(child.stdout.destroyed).toBe(false);
  });

  it.each(["close", "error"])("removes the Windows abort listener after %s", async (event) => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    const controller = new AbortController();
    const pending = runAz([], controller.signal);
    if (event === "close") {
      child.stdout.write("success");
      child.emit("close", 0);
      expect(await pending).toBe("success");
    } else {
      const assertion = expect(pending).rejects.toThrow("not installed");
      child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }));
      await assertion;
    }
    controller.abort();
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(child.stdout.destroyed).toBe(false);
  });
});

describe("identityOf", () => {
  const show = (user: Record<string, string>) =>
    JSON.stringify({ user, tenantId: "00000000-0000-0000-0000-000000000001" });

  it.each([
    [{ name: "ada@contoso.com", type: "user" }, "user", "ada@contoso.com"],
    [{ name: "00000000-0000-0000-0000-000000000002", type: "servicePrincipal" }, "servicePrincipal", "00000000-0000-0000-0000-000000000002"],
    [{ name: "systemAssignedIdentity", type: "servicePrincipal" }, "managedIdentity", "systemAssignedIdentity"],
    [{ name: "userAssignedIdentity", type: "servicePrincipal" }, "managedIdentity", "userAssignedIdentity"],
  ])("reports %j as %s", async (user, type, name) => {
    fakeAz({ stdout: show(user) });
    expect(await identityOf(profile())).toEqual({ name, type, tenantId: "00000000-0000-0000-0000-000000000001" });
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(["account", "show", "--output", "json"]);
  });

  it("maps a signed-out az", async () => {
    fakeAz({ code: 1, stderr: "Please run 'az login'" });
    expect((await failure(identityOf(profile()))).code).toBe("AUTH_REQUIRED");
  });
});

describe("token mode", () => {
  it("storage uses its own token without an ARM token or ambient key fallback", async () => {
    vi.stubEnv("AZ_AXI_STORAGE_TOKEN", "storage-token");
    vi.stubEnv("AZ_AXI_ARM_TOKEN", "arm-token");
    vi.stubEnv("AZURE_STORAGE_KEY", "key-value");
    expect((await resolveCredential(profile({ auth: "token" }), "storage")).header).toBe("Bearer storage-token");
    clearCredentialCache();
    vi.stubEnv("CUSTOM_STORAGE_TOKEN", "custom-storage-token");
    expect((await resolveCredential(profile({ auth: "token", tokenEnv: { storage: "CUSTOM_STORAGE_TOKEN" } }), "storage")).header).toBe("Bearer custom-storage-token");
    clearCredentialCache();
    vi.stubEnv("AZ_AXI_STORAGE_TOKEN", "");
    await expect(resolveCredential(profile({ auth: "token" }), "storage")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(spawnMock).not.toHaveBeenCalled();
  });
  it("vault uses its own token without an ARM token fallback", async () => {
    vi.stubEnv("AZ_AXI_VAULT_TOKEN", "vault-token");
    vi.stubEnv("AZ_AXI_ARM_TOKEN", "arm-token");
    expect((await resolveCredential(profile({ auth: "token" }), "vault")).header).toBe("Bearer vault-token");
    clearCredentialCache();
    vi.stubEnv("CUSTOM_VAULT_TOKEN", "custom-vault-token");
    expect((await resolveCredential(profile({ auth: "token", tokenEnv: { vault: "CUSTOM_VAULT_TOKEN" } }), "vault")).header).toBe("Bearer custom-vault-token");
    clearCredentialCache();
    vi.stubEnv("AZ_AXI_VAULT_TOKEN", "");
    await expect(resolveCredential(profile({ auth: "token" }), "vault")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(spawnMock).not.toHaveBeenCalled();
  });
  it("reads the env var named for the resource", async () => {
    process.env.AZ_AXI_ARM_TOKEN = TOKEN;
    process.env.MY_LOGS_TOKEN = "logs-token";
    const p = profile({ auth: "token", tokenEnv: { logs: "MY_LOGS_TOKEN" } });
    expect(await resolveCredential(p, "arm")).toMatchObject({ header: `Bearer ${TOKEN}`, mode: "token" });
    expect((await resolveCredential(p, "logs")).header).toBe("Bearer logs-token");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("explains how to mint a token when the variable is missing", async () => {
    const error = await failure(resolveCredential(profile({ auth: "token" }), "arm"));
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(error.suggestions).toEqual([
      "Set $AZ_AXI_ARM_TOKEN to an access token for https://management.azure.com/",
      "Mint one with: az account get-access-token --resource https://management.azure.com/ --query accessToken --output tsv",
      'Or switch the profile to "auth": "az"',
    ]);
    const graph = await failure(resolveCredential(profile({ auth: "token" }), "graph"));
    expect(graph.suggestions[1]).toContain("--resource-type ms-graph");
  });
});

describe("the token never reaches rendered output", () => {
  it("stays out of az failures that echo it", async () => {
    for (const outcome of [
      { stdout: JSON.stringify({ accessToken: "", note: TOKEN }) },
      { code: 1, stderr: "AADSTS50076 claims" },
      { code: 1, stderr: "Please run 'az login'" },
      { stdout: `not json ${TOKEN}` },
    ]) {
      clearCredentialCache();
      fakeAz(outcome);
      expect(render(await failure(resolveCredential(profile(), "arm")))).not.toContain(TOKEN);
    }
  });

  it("stays out of a 401 on an az profile, which also names the Conditional Access fix on a claims challenge", async () => {
    fakeAz({ stdout: tokenJson() });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: "InvalidAuthenticationToken", message: `bad ${TOKEN}` } }), {
          status: 401,
          headers: { "www-authenticate": 'Bearer error="insufficient_claims", claims="abc"' },
        }),
      ),
    );
    const error = await failure(request(profile({ tenant: "contoso.example.com" }), { path: "/x", apiVersion: "1" }));
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(error.suggestions.join("\n")).toContain("az logout");
    expect(render(error)).not.toContain(TOKEN);
  });
});
