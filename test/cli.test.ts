import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules/tsx/dist/cli.mjs");

function run(args: string[]) {
  return spawnSync(process.execPath, [TSX, "src/bin/az-axi.ts", ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

const INHERITED = ["toString", "valueOf", "hasOwnProperty", "__proto__", "constructor", "toLocaleString", "isPrototypeOf"];

describe("command dispatch", () => {
  it("rejects inherited command names with the unknown-command exit", () => {
    for (const command of INHERITED) {
      for (const args of [[command], [command, "--help"]]) {
        const result = run(args);
        expect(result.status, args.join(" ")).toBe(2);
        expect(result.stderr, args.join(" ")).toBe("");
        expect(result.stdout, args.join(" ")).toContain(`unknown command \`${command}\``);
        expect(result.stdout, args.join(" ")).toContain("code: VALIDATION_ERROR");
      }
    }
  }, 60_000);

  it("keeps registered commands and hides the built-in update surface", () => {
    const help = run(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).not.toContain("update --check");

    const homeHelp = run(["home", "--help"]);
    expect(homeHelp.status).toBe(0);
    expect(homeHelp.stdout).toContain("placeholder dashboard");

    const home = run([]);
    expect(home.status).toBe(0);
    expect(home.stdout).toContain("bootstrap build: no commands are implemented yet");

    const update = run(["update"]);
    expect(update.status).toBe(2);
    expect(update.stdout).toContain("unknown command `update`");
    expect(update.stdout).toContain("code: VALIDATION_ERROR");
  }, 30_000);
});

describe("end to end with a stubbed network", () => {
  const TOKEN = "e2e-tok-7c41-distinctive-secret";
  const SUB = "00000000-0000-0000-0000-000000000020";
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "az-axi-e2e-"));
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ profiles: { ci: { auth: "token", subscriptions: [SUB] } } }),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Runs the CLI with `fetch` replaced by a canned response, via a --import preload. */
  function runStubbed(args: string[], status: number, body: unknown, env: Record<string, string> = {}) {
    const stub = `globalThis.fetch=async()=>new Response(${JSON.stringify(JSON.stringify(body))},{status:${status},headers:{'content-type':'application/json','x-ms-request-id':'req-e2e'}})`;
    return spawnSync(process.execPath, [TSX, "src/bin/az-axi.ts", ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: `--import data:text/javascript,${encodeURIComponent(stub)}`,
        AZ_AXI_CONFIG: join(dir, "config.json"),
        AZ_AXI_ARM_TOKEN: TOKEN,
        AZ_AXI_LOGS_TOKEN: TOKEN,
        AZ_AXI_GRAPH_TOKEN: TOKEN,
        ...env,
      },
    });
  }

  it("lists subscriptions without ever printing the token", () => {
    const result = runStubbed(["sub", "list"], 200, {
      value: [{ subscriptionId: SUB, displayName: "Sandbox", state: "Enabled" }],
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1 subscriptions");
    expect(result.stdout).toContain("Sandbox");
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
  }, 30_000);

  it("renders a rejected token as a structured error with the request id, exit 2", () => {
    const result = runStubbed(["sub", "list"], 401, { error: { code: "InvalidAuthenticationToken", message: `rejected ${TOKEN}` } });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("code: AUTH_REQUIRED");
    expect(result.stdout).toContain("requestId: req-e2e");
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
  }, 30_000);

  it("runs doctor over a token profile and reports write status", () => {
    const result = runStubbed(["doctor"], 200, { value: [{ subscriptionId: SUB }] });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ci,token,(token),token,1,disabled (default),ok");
    expect(result.stdout).not.toContain(TOKEN);

    const forced = runStubbed(["doctor"], 200, { value: [] }, { AZ_AXI_READ_ONLY: "1" });
    expect(forced.stdout).toContain("disabled (AZ_AXI_READ_ONLY)");
  }, 30_000);

  it("exits 2 for an unknown flag, with a rename hint", () => {
    const result = runStubbed(["sub", "list", "--top", "5"], 200, {});
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("code: UNKNOWN_FLAG");
    expect(result.stdout).toContain("use --limit instead");
  }, 30_000);

  it("moves a leading --profile behind the command", () => {
    const result = runStubbed(["--profile", "ci", "config", "list"], 200, {});
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1 profiles");
  }, 30_000);

  it("accepts leading --limit, --fields and --full before the command", () => {
    const result = runStubbed(["--limit", "5", "--fields", "name", "--full", "sub", "list"], 200, {
      value: [{ subscriptionId: SUB, displayName: "Sandbox", state: "Enabled" }],
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Sandbox");
    expect(result.stdout).not.toContain("must come after the command");
  }, 30_000);
});
