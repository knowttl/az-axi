import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SKILL_INSTALL_COMMAND, skillHintLine, systemSkillPaths } from "../src/lib/skillHint.js";

const HINT = `Run \`${SKILL_INSTALL_COMMAND}\` to install the az-axi skill`;

const HOST_ENVS = [
  { name: "claude-code", env: { CLAUDECODE: "1" } },
  { name: "codex", env: { CODEX_THREAD_ID: "thread-1" } },
  { name: "pi", env: { PI_CODING_AGENT: "true" } },
  { name: "opencode", env: { OPENCODE: "1" } },
] as const;

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function freshDirs() {
  const homeDir = mkdtempSync(join(tmpdir(), "az-axi-skill-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "az-axi-skill-cwd-"));
  dirs.push(homeDir, cwd);
  return { homeDir, cwd };
}

function putSkill(...segments: string[]) {
  const file = join(...segments, "SKILL.md");
  mkdirSync(join(...segments), { recursive: true });
  writeFileSync(file, "# az-axi\n");
}

describe("skillHintLine", () => {
  it("shows the hint only when the detected host's own folders lack the skill", () => {
    const cases: { name: string; env: NodeJS.ProcessEnv; setup?: (homeDir: string, cwd: string) => void; hint: boolean }[] = [
      ...HOST_ENVS.map(({ name, env }) => ({ name: `${name} without skill`, env: { ...env }, hint: true })),
      { name: "no host detected", env: {}, hint: false },
      // User level, one row per host.
      {
        name: "claude-code with user-level skill",
        env: { CLAUDECODE: "1" },
        setup: (homeDir) => putSkill(homeDir, ".claude", "skills", "az-axi"),
        hint: false,
      },
      {
        name: "codex with user-level skill",
        env: { CODEX_THREAD_ID: "thread-1" },
        setup: (homeDir) => putSkill(homeDir, ".agents", "skills", "az-axi"),
        hint: false,
      },
      {
        name: "pi with user-level skill",
        env: { PI_CODING_AGENT: "true" },
        setup: (homeDir) => putSkill(homeDir, ".pi", "agent", "skills", "az-axi"),
        hint: false,
      },
      {
        name: "opencode with user-level skill",
        env: { OPENCODE: "1" },
        setup: (homeDir) => putSkill(homeDir, ".config", "opencode", "skills", "az-axi"),
        hint: false,
      },
      // Project level, one row per host.
      {
        name: "claude-code with project-level skill",
        env: { CLAUDECODE: "1" },
        setup: (_homeDir, cwd) => putSkill(cwd, ".claude", "skills", "az-axi"),
        hint: false,
      },
      {
        name: "codex with project-level skill",
        env: { CODEX_THREAD_ID: "thread-1" },
        setup: (_homeDir, cwd) => putSkill(cwd, ".agents", "skills", "az-axi"),
        hint: false,
      },
      {
        name: "pi with project-level skill",
        env: { PI_CODING_AGENT: "true" },
        setup: (_homeDir, cwd) => putSkill(cwd, ".pi", "skills", "az-axi"),
        hint: false,
      },
      {
        name: "opencode with project-level skill",
        env: { OPENCODE: "1" },
        setup: (_homeDir, cwd) => putSkill(cwd, ".opencode", "skills", "az-axi"),
        hint: false,
      },
      // Config-directory overrides.
      {
        name: "claude-code with CLAUDE_CONFIG_DIR skill",
        env: { CLAUDECODE: "1", CLAUDE_CONFIG_DIR: "" },
        setup: (homeDir) => putSkill(homeDir, "custom-claude", "skills", "az-axi"),
        hint: false,
      },
      {
        name: "pi with PI_CODING_AGENT_DIR skill",
        env: { PI_CODING_AGENT: "true", PI_CODING_AGENT_DIR: "" },
        setup: (homeDir) => putSkill(homeDir, "custom-agent", "skills", "az-axi"),
        hint: false,
      },
      {
        name: "opencode with XDG_CONFIG_HOME skill",
        env: { OPENCODE: "1", XDG_CONFIG_HOME: "" },
        setup: (homeDir) => putSkill(homeDir, "custom-config", "opencode", "skills", "az-axi"),
        hint: false,
      },
      // Cross-host isolation: another host's copy never hides the hint.
      {
        name: "claude-code ignores an agents-only copy",
        env: { CLAUDECODE: "1" },
        setup: (homeDir) => putSkill(homeDir, ".agents", "skills", "az-axi"),
        hint: true,
      },
      {
        name: "pi ignores a claude-only copy",
        env: { PI_CODING_AGENT: "true" },
        setup: (homeDir) => putSkill(homeDir, ".claude", "skills", "az-axi"),
        hint: true,
      },
      {
        name: "codex ignores an opencode-only copy",
        env: { CODEX_THREAD_ID: "thread-1" },
        setup: (homeDir) => putSkill(homeDir, ".config", "opencode", "skills", "az-axi"),
        hint: true,
      },
    ];
    for (const { name, env, setup, hint } of cases) {
      const { homeDir, cwd } = freshDirs();
      if (env.CLAUDE_CONFIG_DIR === "") env.CLAUDE_CONFIG_DIR = join(homeDir, "custom-claude");
      if (env.PI_CODING_AGENT_DIR === "") env.PI_CODING_AGENT_DIR = join(homeDir, "custom-agent");
      if (env.XDG_CONFIG_HOME === "") env.XDG_CONFIG_HOME = join(homeDir, "custom-config");
      setup?.(homeDir, cwd);
      const line = skillHintLine({ env, homeDir, cwd });
      if (hint) expect(line, name).toBe(HINT);
      else expect(line, name).toBeNull();
    }
  });

  it("lists the documented enterprise path only for claude-code", () => {
    for (const host of ["codex", "pi", "opencode"] as const) expect(systemSkillPaths(host), host).toEqual([]);
    const linux = systemSkillPaths("claude-code", "linux");
    expect(linux).toHaveLength(1);
    expect(linux[0].endsWith(join(".claude", "skills", "az-axi", "SKILL.md"))).toBe(true);
    expect(linux[0].startsWith("/etc/claude-code")).toBe(true);
  });
});
