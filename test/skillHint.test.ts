import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SKILL_INSTALL_COMMAND, skillHintLine } from "../src/lib/skillHint.js";

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

function installSkill(path: string) {
  mkdirSync(join(path, ".agents", "skills", "az-axi"), { recursive: true });
  writeFileSync(join(path, ".agents", "skills", "az-axi", "SKILL.md"), "# az-axi\n");
}

describe("skillHintLine", () => {
  it("shows the hint only for a detected host missing the skill", () => {
    const cases: { name: string; env: NodeJS.ProcessEnv; setup?: (homeDir: string, cwd: string) => void; hint: boolean }[] = [
      ...HOST_ENVS.map(({ name, env }) => ({ name: `${name} without skill`, env: { ...env }, hint: true })),
      { name: "pi with user-level skill", env: { PI_CODING_AGENT: "true" }, setup: (homeDir) => installSkill(homeDir), hint: false },
      {
        name: "codex with project-level skill",
        env: { CODEX_THREAD_ID: "thread-1" },
        setup: (_homeDir, cwd) => installSkill(cwd),
        hint: false,
      },
      {
        name: "claude-code with project-level skill",
        env: { CLAUDECODE: "1" },
        setup: (_homeDir, cwd) => {
          mkdirSync(join(cwd, ".claude", "skills", "az-axi"), { recursive: true });
          writeFileSync(join(cwd, ".claude", "skills", "az-axi", "SKILL.md"), "# az-axi\n");
        },
        hint: false,
      },
      { name: "no host detected", env: {}, hint: false },
    ];
    for (const { name, env, setup, hint } of cases) {
      const { homeDir, cwd } = freshDirs();
      setup?.(homeDir, cwd);
      const line = skillHintLine({ env, homeDir, cwd });
      if (hint) expect(line, name).toBe(`Run \`${SKILL_INSTALL_COMMAND}\` to install the az-axi skill`);
      else expect(line, name).toBeNull();
    }
  });
});
