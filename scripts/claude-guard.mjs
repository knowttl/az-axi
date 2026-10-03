import { readFileSync } from "node:fs";

// Verified 2026-10-02: https://code.claude.com/docs/en/hooks#pretooluse-decision-control
// Inspect shell text only. Never evaluate it or execute the requested command.
const invocation = /(?:^|[\s/=$;|&()<>])az-axi(?:\.(?:[cm]?[jt]s|cmd|exe))?(?:@[^\s;|&()<>]+)?(?=$|[\s;|&()<>])/;
const execute = /(?:^|[\s;|&()<>])--execute(?=$|[=\s;|&()<>])/;

function needsApproval(command) {
  const groups = [[]];
  let word = "";
  let quote = "";
  const finishWord = () => {
    if (word) groups.at(-1).push(word);
    word = "";
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "\\" && quote !== "'") {
      const next = command[++i];
      if (next !== "\n" && next !== undefined) word += next;
    } else if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "#" && !word) {
      while (i < command.length && command[i] !== "\n") i++;
      finishWord();
      groups.push([]);
    } else if ((/[&|]/.test(char) && /[<>]/.test(command[i - 1] ?? "")) ||
               (char === "&" && command[i + 1] === ">")) {
      word += char;
    } else if (/[;|&()\n]/.test(char)) {
      finishWord();
      groups.push([]);
    } else if (/\s/.test(char)) {
      finishWord();
    } else {
      word += char;
    }
  }
  finishWord();

  // Substitutions and incomplete quoting are ambiguous: scan the entire text,
  // including nested commands, rather than trusting the simple word grouping.
  if (quote || /\$|`|\\|=|[\[\]{}()]|<<|(?<!\|)\|(?!\|)/.test(command)) {
    const texts = [
      command,
      command.replace(/\\[^\s]?|["'`]/g, " "),
      command.replace(/\\\n/g, "").replace(/\$(["'])/g, "$1").replace(/["'`\\]/g, ""),
    ];
    return texts.some((text) => invocation.test(text)) && texts.some((text) => text.includes("--execute"));
  }
  return groups.some((words) => {
    const text = words.join(" ").replace(/["'\\]/g, "");
    return invocation.test(text) && execute.test(text);
  });
}

const input = JSON.parse(readFileSync(0, "utf8"));
const command = input?.tool_input?.command;
if (input?.hook_event_name === "PreToolUse" && input?.tool_name === "Bash" &&
    typeof command === "string" && needsApproval(command)) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: command,
    },
  })}\n`);
}
