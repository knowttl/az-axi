import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/claude-guard.mjs", import.meta.url));

function hook(input: unknown) {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input), encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout;
}

function bash(command: string) {
  return { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } };
}

describe("Claude Code Bash write guard", () => {
  it.each([
    "az-axi api PATCH /target --execute",
    "'az-axi' api DELETE /target '--execute' --confirm demo",
    'az-"axi" api PATCH /target --ex"ecute"',
    "az\\-axi api PATCH /target --exec\\ute",
    "az-axi api PATCH /target \\\n--execute",
    "AZ_AXI_PROFILE=demo env OTHER=value /opt/bin/az-axi api PATCH /target --execute",
    "env -i npx --no-install @knowttl/az-axi@0.0.0 api PATCH /target --execute=true",
    "node './dist/bin/az-axi.js' api PATCH /target --execute",
    "tsx src/bin/az-axi.ts api PATCH /target --execute",
    "az-axi api PATCH /target > output.txt --execute",
    "az-axi api PATCH /target --execute 2>&1",
    "bash -c 'az-\"axi\" api PATCH /target --ex\"ecute\"'",
    '"/path with spaces/az-axi" api PATCH /target --execute',
    "true && az-axi api PATCH /target --execute; echo done",
    "false || az-axi api PATCH /target --execute | cat",
    "(az-axi api PATCH /target --execute) &",
    "bash -c 'az-axi api PATCH /target --execute'",
    "echo $(az-axi api PATCH /target --execute)",
    "echo `az-axi api PATCH /target --execute`",
    "tool=az-axi; $tool api PATCH /target --execute",
    "az-axi api PATCH /target --execute=false",
    "az-axi api PATCH /target '--execute",
  ])("asks with the complete original command: %s", (command) => {
    expect(JSON.parse(hook(bash(command)))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: command,
      },
    });
  });

  it.each([
    "az-axi sub list",
    "az-axi api PATCH /target",
    "other-tool --execute",
    "not-az-axi --execute",
    "az-axi-helper --execute",
    "az-axi api GET /target --execute-later",
    "echo 'az-axi api PATCH /target --execute'",
    "printf '%s' 'az-axi --execute'",
    "# az-axi --execute\naz-axi sub list",
    "az-axi sub list; other-tool --execute",
    "",
  ])("stays silent: %s", (command) => {
    expect(hook(bash(command))).toBe("");
  });

  it.each([
    {}, null,
    { ...bash("az-axi --execute"), hook_event_name: "PostToolUse" },
    { ...bash("az-axi --execute"), tool_name: "Read" },
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} },
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: 1 } },
  ])("ignores input outside the Bash PreToolUse contract", (input) => {
    expect(hook(input)).toBe("");
  });
});
