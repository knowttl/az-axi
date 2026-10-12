import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertDurableHookTarget } from "../src/lib/hookTarget.js";

const virtual = vi.hoisted(() => ({ targets: new Map<string, string>(), worktrees: new Set<string>() }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    realpathSync: (path: string) => virtual.targets.get(path) ?? fs.realpathSync(path),
    existsSync: (path: string) => virtual.worktrees.has(path) || fs.existsSync(path),
    statSync: (path: string) => virtual.worktrees.has(path) ? { isFile: () => true } : fs.statSync(path),
  };
});

const directories: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "az-axi-target-"));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  virtual.targets.clear();
  virtual.worktrees.clear();
});

describe("hook target policy", () => {
  it("rejects an existing temporary build", () => {
    const entry = join(fixture(), "dist/bin/az-axi-hook.js");
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, "");
    expect(() => assertDurableHookTarget(entry)).toThrow("temporary directory, worktree or pipeline build");
  });

  it.each([".treehouse/slot", ".worktrees/feature", "worktrees/feature", ".no-mistakes/runs/build", "pipeline-builds/run"])(
    "rejects disposable targets under %s outside the temporary root", (directory) => {
      const entry = resolve("/opt", directory, "dist/bin/az-axi-hook.js");
      virtual.targets.set(entry, entry);
      expect(() => assertDurableHookTarget(entry)).toThrow("temporary directory, worktree or pipeline build");
    },
  );

  it("rejects a git worktree with an arbitrary directory name", () => {
    const root = resolve("/opt/feature-checkout");
    const entry = join(root, "dist/bin/az-axi-hook.js");
    virtual.targets.set(entry, entry);
    virtual.worktrees.add(join(root, ".git"));
    expect(() => assertDurableHookTarget(entry)).toThrow("temporary directory, worktree or pipeline build");
  });

  it("rejects a persistent-looking symlink to a temporary target", () => {
    const entry = resolve("/opt/bin/az-axi-hook");
    virtual.targets.set(entry, join(fixture(), "dist/bin/az-axi-hook.js"));
    expect(() => assertDurableHookTarget(entry)).toThrow("temporary directory, worktree or pipeline build");
  });

  it("accepts a durable global installation", () => {
    const entry = resolve("/opt/node/lib/node_modules/@knowttl/az-axi/dist/bin/az-axi-hook.js");
    virtual.targets.set(entry, entry);
    expect(() => assertDurableHookTarget(entry)).not.toThrow();
  });
});

describe("validation isolation", () => {
  it("keeps config writes out of the launching home and XDG directories", () => {
    const owner = fixture();
    const writer = `
      const fs = require('node:fs');
      const path = require('node:path');
      const home = require('node:os').homedir();
      for (const dir of [path.join(home, '.claude'), path.join(home, '.codex'),
        process.env.XDG_CONFIG_HOME, process.env.XDG_CACHE_HOME, process.env.XDG_DATA_HOME,
        process.env.XDG_STATE_HOME, process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR]) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'sentinel'), 'test write');
      }
    `;
    const result = spawnSync(process.execPath, ["scripts/isolated-run.mjs", process.execPath, "-e", writer], {
      encoding: "utf8",
      env: { ...process.env, HOME: owner, USERPROFILE: owner, XDG_CONFIG_HOME: join(owner, "config"),
        XDG_CACHE_HOME: join(owner, "cache"), XDG_DATA_HOME: join(owner, "data"),
        XDG_STATE_HOME: join(owner, "state"), CODEX_HOME: join(owner, "codex"), CLAUDE_CONFIG_DIR: join(owner, "claude") },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(owner)).toEqual([]);
  });

  it("refuses CLI setup from a temporary build without changing agent configs", () => {
    const build = fixture();
    cpSync("dist", join(build, "dist"), { recursive: true });
    symlinkSync(resolve("node_modules"), join(build, "node_modules"), "junction");
    const home = fixture();
    const settings = join(home, ".claude/settings.json");
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, '{"existing":true}\n');
    const result = spawnSync(process.execPath, [join(build, "dist/bin/az-axi.js"), "setup", "hooks"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"),
        CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude") },
    });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toContain("temporary directory, worktree or pipeline build");
    expect(readFileSync(settings, "utf8")).toBe('{"existing":true}\n');
    expect(existsSync(join(home, ".codex"))).toBe(false);
    expect(existsSync(join(home, ".config"))).toBe(false);
  });
});
