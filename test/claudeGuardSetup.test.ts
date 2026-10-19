import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installClaudeGuard } from "../src/lib/claudeGuard.js";

let dir: string;
let entry: string;
let settingsPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-guard-setup-"));
  entry = join(dir, "package's $directory/scripts/claude-guard.mjs");
  mkdirSync(dirname(entry), { recursive: true });
  cpSync("scripts/claude-guard.mjs", entry);
  settingsPath = join(dir, ".claude/settings.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Claude approval hook setup", () => {
  it("repairs stale and duplicate guards while preserving other settings, hooks and group metadata", () => {
    const other = { type: "command", command: "echo az-axi-guard" };
    const settings = {
      permissions: { deny: ["Bash(example)"] },
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "other-context" }] }],
        PostToolUse: [{ matcher: "Read", hooks: [other] }],
        PreToolUse: [
          { matcher: "Bash", description: "retain", hooks: [
            other, { type: "command", command: 'node "/old installation/scripts/claude-guard.mjs"' },
          ] },
          { matcher: "Read", hooks: [{ type: "command", command: "az-axi-guard" }] },
          { matcher: "Bash", hooks: [{ type: "command", command: "other-guard" }] },
        ],
      },
    };
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings));
    installClaudeGuard(entry, dir);
    const updated = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(updated.permissions).toEqual(settings.permissions);
    expect(updated.hooks.SessionStart).toEqual(settings.hooks.SessionStart);
    expect(updated.hooks.PostToolUse).toEqual(settings.hooks.PostToolUse);
    expect(updated.hooks.PreToolUse.slice(0, -1)).toEqual([
      { matcher: "Bash", description: "retain", hooks: [other] }, settings.hooks.PreToolUse[2],
    ]);
    expect(updated.hooks.PreToolUse.at(-1)).toMatchObject({ matcher: "Bash", hooks: [{ type: "command", timeout: 10 }] });
    const first = readFileSync(settingsPath, "utf8");
    installClaudeGuard(entry, dir);
    expect(readFileSync(settingsPath, "utf8")).toBe(first);
    const relocated = join(dir, "new package/scripts/claude-guard.mjs");
    mkdirSync(dirname(relocated), { recursive: true });
    cpSync(entry, relocated);
    installClaudeGuard(relocated, dir);
    expect(JSON.parse(readFileSync(settingsPath, "utf8")).hooks.PreToolUse).toHaveLength(3);
  });

  it("runs the configured guard safely from a path with spaces, quotes and shell syntax", () => {
    installClaudeGuard(entry, dir);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const command = settings.hooks.PreToolUse[0].hooks[0].command;
    const requested = "az-axi api PATCH /example --execute";
    const result = spawnSync(command, { shell: true, encoding: "utf8", cwd: dir,
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: requested } }),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: "ask", permissionDecisionReason: requested });
    expect(existsSync(join(dir, "$directory"))).toBe(false);
  });

  it.each(["{", "null", "[]", '{"hooks":[]}', '{"hooks":{"PreToolUse":null}}', '{"hooks":{"PreToolUse":{}}}', '{"hooks":{"PreToolUse":[{"hooks":[null]}]}}'])(
    "refuses invalid settings without overwriting them: %s", (settings) => {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, settings);
      expect(() => installClaudeGuard(entry, dir)).toThrow("cannot install Claude approval hook");
      expect(readFileSync(settingsPath, "utf8")).toBe(settings);
    },
  );

  it("leaves settings untouched when the packaged guard is missing", () => {
    expect(() => installClaudeGuard(resolve(dir, "missing.mjs"), dir)).toThrow();
    expect(existsSync(settingsPath)).toBe(false);
  });

  it("ships a standalone guard executable that retains approval decisions after unpacking", () => {
    const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", dir], { encoding: "utf8" });
    expect(packed.status, packed.stderr).toBe(0);
    const archive = JSON.parse(packed.stdout)[0].filename;
    const extracted = spawnSync("tar", ["-xzf", join(dir, archive), "-C", dir], { encoding: "utf8" });
    expect(extracted.status, extracted.stderr).toBe(0);
    const installed = join(dir, "package");
    const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    const executable = join(dir, "az-axi-guard");
    symlinkSync(join(installed, manifest.bin["az-axi-guard"]), executable);
    installClaudeGuard(executable, dir);
    const command = JSON.parse(readFileSync(settingsPath, "utf8")).hooks.PreToolUse[0].hooks[0].command;
    for (const [input, decision] of [
      [{ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "az-axi api PATCH /example --execute" } }, "ask"],
      [{ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "az-axi sub list" } }, undefined],
      [{ hook_event_name: "Unknown", tool_name: "Bash", tool_input: { command: "az-axi --execute" } }, undefined],
    ] as const) {
      const result = spawnSync(command, { shell: true, cwd: dir, input: JSON.stringify(input), encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision : undefined).toBe(decision);
    }
    // Parsing failures must never turn into an explicit permission grant.
    const malformed = spawnSync(command, { shell: true, cwd: dir, input: "{", encoding: "utf8" });
    expect(malformed.status).not.toBe(0);
    expect(malformed.stdout).toBe("");
  }, 30_000);
});
