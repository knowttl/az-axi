import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";

vi.mock("cross-spawn", () => ({ default: vi.fn() }));

import spawn from "cross-spawn";
import { clearCredentialCache, identityOf, resolveCredential } from "../src/lib/auth.js";
import { request } from "../src/lib/client.js";
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
});

describe("az mode", () => {
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
