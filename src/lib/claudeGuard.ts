import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { quoteFlagValue } from "./shell.js";

interface Hook {
  type?: string;
  command?: string;
  [key: string]: unknown;
}
interface Group {
  matcher?: string;
  hooks: Hook[];
  [key: string]: unknown;
}

// Recognize only standalone guard invocations, including the documented legacy
// source-checkout command. A command mentioning the guard is not ours to remove.
const token = `(?:"[^"\\n]*"|'[^'\\n]*'|\\\\.|[^\\s"'\\\\;|&<>\x60$])+`;
const invocation = new RegExp(`^(?:(${token})\\s+)?(${token})$`);
function managed(hook: Hook): boolean {
  if (hook.type !== "command" || typeof hook.command !== "string") return false;
  const match = invocation.exec(hook.command);
  if (!match) return false;
  const unquote = (value: string) => value.replace(/"([^"\n]*)"|'([^'\n]*)'|\\(.)/g,
    (_match, double: string | undefined, single: string | undefined, escaped: string | undefined) => double ?? single ?? escaped ?? "").replaceAll("\\", "/");
  if (match[1] && !/(?:^|\/)node(?:\.exe)?$/.test(unquote(match[1]))) return false;
  const target = unquote(match[2]!);
  return target === "az-axi-guard" || target.endsWith("/az-axi-guard") || target.endsWith("/scripts/claude-guard.mjs");
}

/** Install Claude's native Bash approval hook without modifying other hooks. */
export function installClaudeGuard(entry: string, homeDir = homedir()): void {
  // Pin both runtime and script, so a different binary on PATH cannot take over
  // approval decisions. This also handles installs in paths with shell syntax.
  const command = `${quoteFlagValue(realpathSync(process.execPath))} ${quoteFlagValue(realpathSync(entry))}`;
  const path = join(homeDir, ".claude/settings.json");
  try {
    const settings = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    if (!settings || typeof settings !== "object" || Array.isArray(settings) ||
        (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)))) {
      throw new Error("expected a settings object with an optional hooks object");
    }
    const groups = settings.hooks?.PreToolUse === undefined ? [] : settings.hooks.PreToolUse;
    if (!Array.isArray(groups) || groups.some((group: Group) => !group || !Array.isArray(group.hooks) ||
        group.hooks.some((hook) => !hook || typeof hook !== "object" || Array.isArray(hook)))) {
      throw new Error("expected PreToolUse hook groups");
    }
    const updated: Group[] = [];
    for (const group of groups as Group[]) {
      const hooks = group.hooks.filter((hook) => !managed(hook));
      if (hooks.length === group.hooks.length) updated.push(group);
      else if (hooks.length) updated.push({ ...group, hooks });
    }
    updated.push({ matcher: "Bash", hooks: [{ type: "command", command, timeout: 10 }] });
    if (JSON.stringify(groups) === JSON.stringify(updated)) return;
    settings.hooks = { ...settings.hooks, PreToolUse: updated };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  } catch (error) {
    throw new AxiError(`cannot install Claude approval hook: ${error instanceof Error ? error.message : String(error)}`, "CONFIG_ERROR", [
      "Repair ~/.claude/settings.json, then retry `az-axi setup hooks`",
    ]);
  }
}
