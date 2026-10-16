import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/**
 * One-line skill-install hint for the no-argument home view.
 *
 * When az-axi runs with no arguments inside a supported agent host and its
 * skill is not installed for that host, home appends one `help[]` entry
 * naming the exact install command. No hint once installed, no hint outside
 * a detected host, and the check never throws or changes the exit code.
 *
 * The installed check looks only at the detected host's own row: one host's
 * copy never hides another host's hint. Every folder below was confirmed
 * against the real host, not from memory:
 *
 * | host        | user level                                                       | project level (walk-up to repo root)                | overrides |
 * |-------------|------------------------------------------------------------------|-----------------------------------------------------|-----------|
 * | claude-code | `~/.claude/skills`                                               | `.claude/skills` + main-checkout worktree fallback  | `CLAUDE_CONFIG_DIR/skills` replaces the default |
 * | codex       | `~/.agents/skills`                                               | `.agents/skills`                                    | none |
 * | pi          | `~/.pi/agent/skills` + `~/.agents/skills`                        | `.pi/skills` + `.agents/skills`                     | `PI_CODING_AGENT_DIR/skills` replaces the pi default |
 * | opencode    | `<cfg>/opencode/skills` + `~/.claude/skills` + `~/.agents/skills` | `.opencode/skills` + `.claude/skills` + `.agents/skills` | `XDG_CONFIG_HOME` selects `<cfg>` |
 *
 * Scope bound: default roots, skills-CLI destinations, documented root
 * overrides, the Claude worktree fallback, and only a direct-child
 * `<tool>/SKILL.md` in each folder. Folders listed in host settings files
 * (for example Pi `settings.json`) and recursive nested layouts are an
 * approved documented limitation and are intentionally not checked.
 *
 * Sources: skills CLI v1.7.2 runs into temp HOME/project dirs; Claude Code
 * skills + managed-settings docs; Pi binary resource-loader.js + skills.md;
 * OpenCode skills doc + binary XDG handling; Codex binary (no own/system
 * skills folder found, so Codex reads the shared Agent Skills store only).
 */

export const SKILL_NAME = "az-axi";

export const SKILL_INSTALL_COMMAND = `npx skills add knowttl/${SKILL_NAME} --skill ${SKILL_NAME}`;

export type SkillHost = "claude-code" | "codex" | "pi" | "opencode";

/** Agent host of the current process, from the markers hosts set for children. Null when undetected. */
export function detectSkillHost(env: NodeJS.ProcessEnv = process.env): SkillHost | null {
  if (env.CLAUDECODE) return "claude-code";
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) return "codex";
  if (env.PI_CODING_AGENT) return "pi";
  if (env.OPENCODE) return "opencode";
  return null;
}

export interface SkillInstallProbe {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cwd?: string;
}

function exists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function isRepoRoot(dir: string): boolean {
  try {
    statSync(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** User-level candidate SKILL.md paths: only folders the host loads. */
export function userSkillPaths(host: SkillHost, homeDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  switch (host) {
    case "claude-code": {
      const configured = env.CLAUDE_CONFIG_DIR?.trim();
      return [configured ? join(configured, "skills", SKILL_NAME, "SKILL.md") : join(homeDir, ".claude", "skills", SKILL_NAME, "SKILL.md")];
    }
    case "pi": {
      const agentDir = env.PI_CODING_AGENT_DIR?.trim();
      const own = agentDir
        ? join(agentDir, "skills", SKILL_NAME, "SKILL.md")
        : join(homeDir, ".pi", "agent", "skills", SKILL_NAME, "SKILL.md");
      return [own, join(homeDir, ".agents", "skills", SKILL_NAME, "SKILL.md")];
    }
    case "opencode": {
      const base = env.XDG_CONFIG_HOME?.trim() || join(homeDir, ".config");
      return [
        join(base, "opencode", "skills", SKILL_NAME, "SKILL.md"),
        join(homeDir, ".claude", "skills", SKILL_NAME, "SKILL.md"),
        join(homeDir, ".agents", "skills", SKILL_NAME, "SKILL.md"),
      ];
    }
    case "codex":
      return [join(homeDir, ".agents", "skills", SKILL_NAME, "SKILL.md")];
  }
}

/** Project-level relative SKILL.md paths: only folders the host loads. */
export function projectSkillRelPaths(host: SkillHost): string[] {
  const agents = join(".agents", "skills", SKILL_NAME, "SKILL.md");
  const claude = join(".claude", "skills", SKILL_NAME, "SKILL.md");
  switch (host) {
    case "claude-code":
      return [claude];
    case "codex":
      return [agents];
    case "pi":
      return [join(".pi", "skills", SKILL_NAME, "SKILL.md"), agents];
    case "opencode":
      return [join(".opencode", "skills", SKILL_NAME, "SKILL.md"), claude, agents];
  }
}

/** Repository root: first ancestor holding `.git` (file or dir). Null outside a repo. */
export function repoRoot(cwd: string): string | null {
  let dir = cwd;
  for (;;) {
    if (isRepoRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Main-checkout `.claude/skills` fallback for linked worktrees: Claude Code
 * loads the main checkout's project skills when the worktree root has none.
 * File-only resolution, no subprocess. Null unless the root's `.git` is a
 * `gitdir:` pointer into `<main>/.git/worktrees/<name>`.
 */
export function claudeWorktreeFallback(root: string): string | null {
  try {
    const dotGit = join(root, ".git");
    if (statSync(dotGit).isDirectory()) return null;
    const match = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+?)\s*$/m);
    const gitdirTarget = match?.[1];
    if (!gitdirTarget) return null;
    const gitdir = resolve(root, gitdirTarget);
    if (basename(dirname(gitdir)) !== "worktrees") return null;
    return join(dirname(dirname(dirname(gitdir))), ".claude", "skills", SKILL_NAME, "SKILL.md");
  } catch {
    return null;
  }
}

/**
 * Project-level candidate SKILL.md paths: current directory upward to the
 * repository root (the first ancestor holding `.git`), inclusive.
 */
export function projectSkillPaths(host: SkillHost, cwd: string): string[] {
  const rels = projectSkillRelPaths(host);
  const paths: string[] = [];
  const root = repoRoot(cwd);
  let dir = cwd;
  for (;;) {
    for (const rel of rels) paths.push(join(dir, rel));
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (host === "claude-code" && root !== null) {
    const fallback = claudeWorktreeFallback(root);
    if (fallback !== null) paths.push(fallback);
  }
  return paths;
}

/** True when SKILL.md exists in the host's own row. Never throws. */
export function isSkillInstalled(host: SkillHost, probe: SkillInstallProbe = {}): boolean {
  try {
    const env = probe.env ?? process.env;
    const homeDir = probe.homeDir ?? homedir();
    const cwd = probe.cwd ?? process.cwd();
    return [...userSkillPaths(host, homeDir, env), ...projectSkillPaths(host, cwd)].some(exists);
  } catch {
    return true;
  }
}

/**
 * The `help[]` hint line, or null when no host is detected, the skill is
 * installed, or the check itself fails. Never throws.
 */
export function skillHintLine(probe: SkillInstallProbe = {}): string | null {
  try {
    const host = detectSkillHost(probe.env ?? process.env);
    if (host === null) return null;
    if (isSkillInstalled(host, probe)) return null;
    return `Run \`${SKILL_INSTALL_COMMAND}\` to install the ${SKILL_NAME} skill`;
  } catch {
    return null;
  }
}
