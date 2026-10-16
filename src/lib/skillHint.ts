import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * One-line skill-install hint for the no-argument home view.
 *
 * When az-axi runs with no arguments inside a supported agent host and its
 * skill is not installed for that host, home appends one `help[]` entry
 * naming the exact install command. No hint once installed, no hint outside
 * a detected host, and the check never throws or changes the exit code.
 *
 * Install locations were confirmed with the real `skills` CLI (v1.7.2):
 * user level (`-g`) keeps Claude Code skills under
 * `$CLAUDE_CONFIG_DIR/skills` (default `~/.claude/skills`) while Codex, Pi
 * and OpenCode share `~/.agents/skills`; project level keeps Claude Code
 * skills under `<project>/.claude/skills` (usually a symlink to the shared
 * store) and everything else under `<project>/.agents/skills`.
 * Host markers were verified against the real hosts, not from memory:
 * `CLAUDECODE` (Claude Code binary reads it for session state),
 * `CODEX_THREAD_ID`/`CODEX_SESSION_ID` (codex `shell_environment.rs`
 * publishes them to child processes), `PI_CODING_AGENT` (Pi documents it
 * for child-process detection and sets it), `OPENCODE` (the opencode
 * binary exports `OPENCODE=1` to its children).
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

/** User-level (`-g`) candidate SKILL.md paths for one host. */
export function userSkillPaths(host: SkillHost, homeDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (host === "claude-code") {
    const configured = env.CLAUDE_CONFIG_DIR?.trim();
    const primary = configured ? join(configured, "skills", SKILL_NAME, "SKILL.md") : join(homeDir, ".claude", "skills", SKILL_NAME, "SKILL.md");
    const fallback = join(homeDir, ".claude", "skills", SKILL_NAME, "SKILL.md");
    return primary === fallback ? [primary] : [primary, fallback];
  }
  return [join(homeDir, ".agents", "skills", SKILL_NAME, "SKILL.md")];
}

/**
 * Project-level candidate SKILL.md paths: current directory upward to the
 * repository root (the first ancestor holding `.git`), inclusive.
 */
export function projectSkillPaths(host: SkillHost, cwd: string): string[] {
  const paths: string[] = [];
  let dir = cwd;
  for (;;) {
    paths.push(join(dir, ".agents", "skills", SKILL_NAME, "SKILL.md"));
    if (host === "claude-code") paths.push(join(dir, ".claude", "skills", SKILL_NAME, "SKILL.md"));
    if (isRepoRoot(dir)) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return paths;
}

/** True when SKILL.md exists at user or project level for the host. Never throws. */
export function isSkillInstalled(host: SkillHost, probe: SkillInstallProbe = {}): boolean {
  try {
    const homeDir = probe.homeDir ?? homedir();
    const cwd = probe.cwd ?? process.cwd();
    return [...userSkillPaths(host, homeDir, probe.env ?? process.env), ...projectSkillPaths(host, cwd)].some(exists);
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
