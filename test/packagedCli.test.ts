import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUB = "00000000-0000-0000-0000-000000000020";
const TOKEN = "packaged-synthetic-token";

describe("clean-installed package regression for #122", () => {
  let dir: string;
  let bin: string;
  let config: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "az-axi-package-"));
    config = join(dir, "config.json");
    mkdirSync(join(dir, "empty-path"));
    mkdirSync(join(dir, "install"));
    writeFileSync(join(dir, ".npmrc"), "registry=https://registry.npmjs.org/\n");
    writeFileSync(join(dir, "global.npmrc"), "");
    writeFileSync(config, JSON.stringify({ version: 1, defaultProfile: "ci", profiles: {
      ci: { auth: "token", subscriptions: [SUB], armToken: { env: "PACKAGED_ARM_TOKEN" } },
    } }));
    const pack = spawnSync("npm", ["pack", "--offline", "--pack-destination", dir], { cwd: ROOT, encoding: "utf8" });
    expect(pack.status, pack.stdout + pack.stderr).toBe(0);
    const tarball = readdirSync(dir).find((name) => name.endsWith(".tgz"))!;
    const { storeDir } = parse(readFileSync(join(ROOT, "node_modules/.modules.yaml"), "utf8")) as { storeDir: string };
    const install = spawnSync(process.env.AZ_AXI_TEST_PNPM ?? "pnpm", ["install", "--prefer-offline", "--store-dir", process.env.AZ_AXI_TEST_PNPM_STORE ?? storeDir, "--cache-dir", process.env.AZ_AXI_TEST_PNPM_CACHE!, "--ignore-scripts", "--dir", join(dir, "install"), join(dir, tarball)], {
      cwd: join(dir, "install"), encoding: "utf8",
      env: {
        ...process.env, COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        npm_config_userconfig: join(dir, ".npmrc"), NPM_CONFIG_USERCONFIG: join(dir, ".npmrc"),
        npm_config_globalconfig: join(dir, "global.npmrc"), NPM_CONFIG_GLOBALCONFIG: join(dir, "global.npmrc"),
      },
    });
    expect(install.status, install.stdout + install.stderr).toBe(0);
    bin = join(dir, "install/node_modules/@knowttl/az-axi/dist/bin/az-axi.js");
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(args: string[], mode: "ok" | "missing" | "rejected" = "ok") {
    const preload = `globalThis.fetch = async (url) => {
      process.stderr.write('FAKE_AZURE_REQUEST\\n');
      const body = ${JSON.stringify(mode === "rejected"
        ? { error: { code: "InvalidAuthenticationToken", message: `rejected ${TOKEN}` } }
        : { value: [{ subscriptionId: SUB, displayName: "Sandbox", state: "Enabled" }] })};
      return new Response(JSON.stringify(${JSON.stringify(mode)} === 'ok' && String(url).includes('Microsoft.ResourceGraph')
        ? { totalRecords: 0, count: 0, data: [] } : body),
        { status: ${mode === "rejected" ? 401 : 200}, headers: { 'content-type': 'application/json' } });
    };`;
    return spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, bin, ...args], {
      cwd: dir, encoding: "utf8", input: "",
      env: {
        HOME: dir, USERPROFILE: dir, PATH: join(dir, "empty-path"),
        XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, APPDATA: dir, LOCALAPPDATA: dir,
        AZURE_CONFIG_DIR: join(dir, ".azure"), AZ_AXI_CONFIG: config, AZ_AXI_PROFILE: "ci",
        AZ_AXI_READ_ONLY: "1", PACKAGED_ARM_TOKEN: mode === "missing" ? "" : TOKEN,
      },
    });
  }

  it.each([
    ["--axi-review-unknown"],
    ["--axi-review-unknown", "value"],
    ["--axi-review-unknown=value"],
    ["--axi-review-unknown", "sub", "list"],
    ["--profile", "ci", "--axi-review-unknown", "value"],
    ["home", "--axi-review-unknown", "value"],
    ["sub", "list", "--axi-review-unknown", "value"],
    ["security", "alert", "list", "--axi-review-unknown", "value"],
    ["graph", "query", "-q", "Resources", "--axi-review-unknown", "value"],
    ["rg", "query", "Resources", "--axi-review-unknown", "value"],
    ["api", "GET", "/subscriptions", "--axi-review-unknown", "value"],
  ])("rejects unsupported flags before credentials or Azure: %j", (...args) => {
    const result = run(args, "missing");
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("code: UNKNOWN_FLAG");
    expect(result.stdout).toContain("unknown flag");
    expect(result.stdout).toContain("--axi-review-unknown");
    expect(result.stdout).toContain("Valid");
    expect(result.stdout).toContain("--profile");
    expect(result.stdout).not.toContain("must come after");
    expect(result.stdout.slice(result.stdout.indexOf("help"))).not.toContain("--axi-review-unknown");
    expect(result.stderr).toBe("");
  });

  it.each(["--severity", "--execute", "-w"])("keeps positional advice for supported %s", (flag) => {
    const result = run([flag], "missing");
    expect(result.status).toBe(2);
    expect(result.stdout).toContain(`\`${flag}\` must come after the command`);
    expect(result.stdout).toContain("after the complete command path");
    expect(result.stderr).toBe("");
  });

  it.each([
    ["--profile", "ci", "--limit", "1", "--fields", "name", "--full", "sub", "list"],
    ["sub", "list", "--profile", "ci", "--limit", "1", "--fields", "name", "--full"],
  ])("accepts documented global flag positions: %j", (...args) => {
    const result = run(args);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Sandbox");
    expect(result.stderr).toBe("FAKE_AZURE_REQUEST\n");
  });

  it("accepts command flags after the complete command path", () => {
    const result = run(["config", "init", "--name", "added", "--auth", "token"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("added");
    expect(result.stderr).toBe("");
  });

  it("shows the configured home with controlled Azure responses", () => {
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("profile: ci");
    expect(result.stdout).toContain("subscriptions: 1");
    expect(result.stdout).toContain("disabled");
    expect(result.stderr).toMatch(/^(FAKE_AZURE_REQUEST\n)+$/);
  });

  it.each(["missing", "rejected"] as const)("reports %s authentication safely", (mode) => {
    const result = run(["sub", "list"], mode);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("code: AUTH_REQUIRED");
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
    expect(result.stderr).toBe(mode === "missing" ? "" : "FAKE_AZURE_REQUEST\n");
  });

  it.each([
    ["sub", "list"], ["graph", "query"], ["security", "alert", "list"],
    ["storage", "blob", "list"], ["keyvault", "secret", "list"],
    ["acr", "repository", "list"], ["api"],
  ])("provides installed leaf help without authentication: %j", (...args) => {
    const result = run([...args, "--help"], "missing");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`az-axi ${args.join(" ")}`);
    expect(result.stdout).toContain("--");
    expect(result.stderr).toBe("");
  });
});
