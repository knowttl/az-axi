import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installHooks, run } from "../src/commands/setup.js";

let dir: string;
let savedPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-setup-"));
  savedPath = process.env.PATH;
});

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  rmSync(dir, { recursive: true, force: true });
});

function claudeHooks(home: string): unknown[] {
  const settings = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
  return settings.hooks.SessionStart.flatMap((group: { hooks: unknown[] }) => group.hooks);
}

describe("setup hooks", () => {
  it("rejects unknown actions and stray arguments before touching the home directory", async () => {
    await expect(run(["bogus"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["hooks", "extra"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(run(["hooks", "--org", "x"])).rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
    expect(existsSync(join(dir, "home"))).toBe(false);
  });

  it("reports a missing hook entry point instead of installing", async () => {
    // Under vitest no az-axi-hook binary sits next to the runner.
    await expect(run(["hooks"])).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("installs the hook entry point for every agent and is idempotent", async () => {
    const home = join(dir, "home");
    // A dist-shaped path, as installed: the SDK install policy only accepts
    // entries that look like a built binary, never a bare temp file.
    const entry = join(dir, "pkg/dist/bin/az-axi-hook.js");
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, "");
    const first = await installHooks({ homeDir: home, execPath: entry });
    expect(first).toMatchObject({
      hooks: { status: "installed", claude: true, codex: true, opencode: true },
      help: ["Restart your agent session to receive az-axi ambient context"],
    });
    // Absolute fallback: the entry is not on PATH in this test.
    expect(claudeHooks(home)).toContainEqual({ type: "command", command: entry, timeout: 10 });
    const snapshot = (path: string) => readFileSync(path, "utf8");
    const files = [
      join(home, ".claude/settings.json"),
      join(home, ".codex/hooks.json"),
      join(home, ".codex/config.toml"),
      join(home, ".config/opencode/plugins/axi-az-axi.js"),
    ];
    for (const file of files) expect(existsSync(file)).toBe(true);
    const before = files.map(snapshot);
    const second = await installHooks({ homeDir: home, execPath: entry });
    expect(second.hooks).toMatchObject({ status: "installed" });
    expect(files.map(snapshot)).toEqual(before);
  });

  it("prefers the portable binary name once the entry is on PATH", async () => {
    const home = join(dir, "home");
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const entry = join(dir, "pkg/dist/bin/az-axi-hook.js");
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, "");
    symlinkSync(entry, join(bin, "az-axi-hook"));
    process.env.PATH = `${bin}${process.env.PATH ? `:${process.env.PATH}` : ""}`;
    await installHooks({ homeDir: home, execPath: entry });
    expect(claudeHooks(home)).toContainEqual({ type: "command", command: "az-axi-hook", timeout: 10 });
  });
});
