import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/commands/config.js";

const SUB_A = "00000000-0000-0000-0000-000000000020";
const WS = "00000000-0000-0000-0000-000000000010";

let dir: string;
let path: string;
const ENV_KEYS = ["AZ_AXI_CONFIG", "AZ_AXI_READ_ONLY"];
let saved: Record<string, string | undefined>;

const read = () => JSON.parse(readFileSync(path, "utf8")) as { defaultProfile?: string; profiles: Record<string, Record<string, unknown>> };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-init-"));
  path = join(dir, "config.json");
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  delete process.env.AZ_AXI_READ_ONLY;
  process.env.AZ_AXI_CONFIG = path;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("config init", () => {
  it("creates the config with a read-only az profile and makes the first profile the default", async () => {
    const result = await run(["init", "--name", "work", "--auth", "az", "--tenant", "contoso.example.com"]);
    expect(read()).toEqual({
      defaultProfile: "work",
      profiles: { work: { auth: "az", tenant: "contoso.example.com" } },
    });
    expect(result).toMatchObject({ profile: "work", auth: "az", default: true, writes: "disabled (default)" });
  });

  it("stores scope, workspaces and token env names", async () => {
    await run([
      "init", "--name", "ci", "--auth", "token",
      "--management-group", "contoso-root", "--subscription", `${SUB_A},00000000-0000-0000-0000-000000000021`,
      "--workspace", `sentinel=${WS}`, "--token-env", "arm=CI_ARM,logs=CI_LOGS",
    ]);
    expect(read().profiles.ci).toEqual({
      auth: "token",
      managementGroup: "contoso-root",
      subscriptions: [SUB_A, "00000000-0000-0000-0000-000000000021"],
      workspaces: { sentinel: WS },
      tokenEnv: { arm: "CI_ARM", logs: "CI_LOGS", graph: "AZ_AXI_GRAPH_TOKEN" },
    });
  });

  it("keeps the default unless --default is passed", async () => {
    await run(["init", "--name", "one"]);
    await run(["init", "--name", "two"]);
    expect(read().defaultProfile).toBe("one");
    await run(["init", "--name", "two", "--default"]);
    expect(read().defaultProfile).toBe("two");
  });

  it("has no way to set allowWrites", async () => {
    await expect(run(["init", "--name", "x", "--allow-writes"])).rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
    await expect(run(["init", "--name", "x", "--allowWrites", "true"])).rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
    await run(["init", "--name", "x", "--subscription", SUB_A]);
    expect(read().profiles.x).not.toHaveProperty("allowWrites");
  });

  it("drops a hand-set allowWrites when it rewrites a profile, leaving it read-only", async () => {
    writeFileSync(path, JSON.stringify({ profiles: { work: { auth: "az", subscriptions: [SUB_A], allowWrites: true } } }));
    const result = await run(["init", "--name", "work", "--subscription", SUB_A]);
    expect(read().profiles.work).toEqual({ auth: "az", subscriptions: [SUB_A] });
    expect(result.writes).toBe("disabled (default)");
  });

  it("keeps other profiles untouched", async () => {
    writeFileSync(path, JSON.stringify({ defaultProfile: "a", profiles: { a: { auth: "az", subscriptions: [SUB_A], allowWrites: true } } }));
    await run(["init", "--name", "b"]);
    expect(read().profiles.a).toEqual({ auth: "az", subscriptions: [SUB_A], allowWrites: true });
  });

  it("writes to --config when given", async () => {
    const other = join(dir, "other.json");
    await run(["init", "--name", "x", "--config", other]);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it.each([
    [["init", "--name", "bad name"], /invalid profile name/],
    [["init", "--auth", "pat"], /--auth/],
    [["init", "--workspace", "sentinel=/subscriptions/x/resourceGroups/y"], /--workspace/],
    [["init", "--workspace", "noequals"], /--workspace/],
    [["init", "--auth", "token", "--token-env", "bogus=VAR"], /--token-env/],
    [["init", "--auth", "token", "--token-env", "arm=not valid"], /--token-env/],
    [["init", "--token-env", "arm=VAR"], /only applies/],
  ])("rejects %j", async (argv, message) => {
    await expect(run(argv)).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringMatching(message) });
    expect(existsSync(path)).toBe(false);
  });
});

describe("config list and path", () => {
  it("explains an empty config", async () => {
    const result = await run(["list"]);
    expect(result.profiles).toMatch(/^0 profiles found/);
    expect(result.help).toEqual([expect.stringContaining("config init")]);
  });

  it("lists each profile with scope and write status", async () => {
    writeFileSync(
      path,
      JSON.stringify({
        defaultProfile: "work",
        profiles: {
          work: { auth: "az", tenant: "contoso.example.com", managementGroup: "contoso-root" },
          sandbox: { auth: "az", subscriptions: [SUB_A], allowWrites: true },
          ci: { auth: "token", subscriptions: [SUB_A, "00000000-0000-0000-0000-000000000021"] },
        },
      }),
    );
    const result = await run(["list"]);
    expect(result.defaultProfile).toBe("work");
    expect(result.count).toBe("3 profiles");
    expect(result.profiles).toEqual([
      { name: "work", auth: "az", tenant: "contoso.example.com", scope: "mg:contoso-root", writes: "disabled (default)" },
      { name: "sandbox", auth: "az", tenant: "", scope: "1 subscriptions", writes: "ENABLED for 1 subscription" },
      { name: "ci", auth: "token", tenant: "", scope: "2 subscriptions", writes: "disabled (default)" },
    ]);

    process.env.AZ_AXI_READ_ONLY = "1";
    const forced = (await run(["list"])).profiles as Array<{ writes: string }>;
    expect(forced.map((row) => row.writes)).toEqual(Array(3).fill("disabled (AZ_AXI_READ_ONLY)"));
  });

  it("reports the config path and whether it exists", async () => {
    expect(await run(["path"])).toEqual({ path, exists: false });
    await run(["init"]);
    expect(await run(["path"])).toEqual({ path, exists: true });
  });

  it("rejects missing and unknown subcommands and stray arguments", async () => {
    await expect(run([])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["remove"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["list", "extra"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["list", "--name", "x"])).rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
  });
});
