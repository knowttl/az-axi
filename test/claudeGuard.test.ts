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
    "az-axi security alert update -l westeurope -n example-alert --status dismiss --execute",
    "az-axi defender alerts update --location westeurope --name example-alert --status resolve --execute",
    "az-axi sentinel incident update --name 3177 --status closed --classification FalsePositive --execute",
    "az-axi sentinel incident comment create --incident-id 00000000-0000-0000-0000-000000000063 --message Triaged --execute",
    "az-axi api PATCH /target --execute",
    "az-axi api PATCH /target --body-file 'body file.json' --execute",
    "az-axi api PATCH /target --execute < body.json",
    "cat body.json | az-axi api PATCH /target --execute",
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
    "az-axi api PATCH /target 2>&1 --execute",
    "az-axi api PATCH /target 0<&3 --execute",
    "az-axi api PATCH /target 2>&- --execute",
    "az-axi api PATCH /target &> output.txt --execute",
    "az-axi api PATCH /target &>> output.txt --execute",
    "az-axi api PATCH /target >| output.txt --execute",
    "az-axi api PATCH /target > >(cat) --execute",
    "az-axi api PATCH /target --body <(printf '{}') --execute",
    "printf '%s\\n' 'az-axi api DELETE /target --confirm demo --execute' | bash",
    "echo 'az-axi api DELETE /target --confirm demo --execute' | sh",
    "echo 'az-axi api PATCH /target --execute'",
    "printf '%s' 'az-axi --execute'",
    "az-axi api PATCH /target $'--execute'",
    'az-axi api PATCH /target $"--execute"',
    "$'az-axi' api PATCH /target --execute",
    '$"az-axi" api PATCH /target --execute',
    "az-axi api PATCH /target --ex$'ecute'",
    "bash -c \"az-axi api PATCH /target $'--execute'\"",
    "printf '%s\\n' --execute | xargs az-axi api PATCH /target",
    "printf '%s\\n' --execute | cat | xargs az-axi api PATCH /target",
    "printf '%s\\n' --execute |& xargs az-axi api PATCH /target",
    "printf '%s\\n' $'--execute' | xargs $'az-axi' api PATCH /target",
    "printf -- '--execute\\n' | xargs az-axi api PATCH /target",
    "printf -- '\\t--execute\\n' | xargs az-axi api PATCH /target",
    "printf -- '--execute\\0' | xargs -0 az-axi api PATCH /target",
    "printf -- '--execute\\r\\n' | xargs az-axi api PATCH /target",
    "printf -- '--execute\\n' | xargs az\\-axi api PATCH /target",
    "printf -- 'az-axi api PATCH /target --execute\\n' | bash",
    "printf -- '\\naz-axi api PATCH /target --execute\\n' | bash",
    "printf -- '--execute\\x0a' | xargs az-axi api PATCH /target",
    "printf -- '--execute\\012' | xargs az-axi api PATCH /target",
    "printf '%s' $'--execute\\n' | xargs az-axi api PATCH /target",
    "xargs az-axi api PATCH /target <<'EOF'\n--execute\nEOF",
    "xargs az-axi api PATCH /target <<EOF\n--execute\nEOF",
    'xargs az-axi api PATCH /target <<"EOF"\n--execute\nEOF',
    "xargs az-axi api PATCH /target <<-'EOF'\n\t--execute\n\tEOF",
    "bash <<'EOF'\naz-axi api PATCH /target --execute\nEOF",
    "xargs az-axi api PATCH /target <<< $'--execute\\n'",
    "xargs az-axi api PATCH /target < <(printf -- '--execute\\n')",
    "bash -c 'az-axi api PATCH /target --execute\\n'",
    "flag=--execute; printf '%s\\n' \"$flag\" | xargs az-axi api PATCH /target",
    "flag=--execute; az-axi api PATCH /target $flag",
    "flag=--execute; az-axi api PATCH /target \"$flag\"",
    "flag='--execute'; az-axi api PATCH /target \"$flag\"",
    'flag="--execute"; az-axi api PATCH /target "$flag"',
    "export flag=--execute; az-axi api PATCH /target \"${flag}\"",
    "flags=(--execute); az-axi api PATCH /target \"${flags[@]}\"",
    "flags=([0]=--execute); az-axi api PATCH /target \"${flags[@]}\"",
    "flags=(--execute); az-axi api PATCH /target",
    "printf '%s' '[\"--execute\"]' | jq -r '.[]' | xargs az-axi api PATCH /target",
    "printf '%s' '{\"flag\":\"--execute\"}' | jq -r '.flag' | xargs az-axi api PATCH /target",
    "printf '%s' '[\"--execute\"]' | jq -r '.[]' | xargs az\\-axi api PATCH /target",
    "flag=prefix--executeSuffix; az-axi api PATCH /target \"$flag\"",
    "az-axi api PATCH /target $'--execute-later'",
    "printf -- '--execute-later\\n' | xargs az-axi api GET /target",
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
    "# az-axi --execute\naz-axi sub list",
    "az-axi sub list; other-tool --execute",
    "az-axi sub list && other-tool --execute",
    "az-axi sub list || other-tool --execute",
    "az-axi sub list | cat",
    "printf '%s\\n' --execute | xargs other-tool",
    "printf -- 'sub list\\n' | xargs az-axi",
    "xargs az-axi <<'EOF'\nsub list\nEOF",
    "xargs other-tool <<'EOF'\n--execute\nEOF",
    "az-axi sub list <<< $'input\\n'",
    "az-axi api PATCH /target --body '{\"tags\":{\"review\":\"pending\\n\"}}'",
    "flag=--help; az-axi \"$flag\"",
    "flags=(sub list); az-axi \"${flags[@]}\"",
    "printf '%s' '[\"sub\",\"list\"]' | jq -r '.[]' | xargs az-axi",
    "flag=--execute; other-tool \"$flag\"",
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
