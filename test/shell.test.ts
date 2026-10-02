import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ sendRequest: vi.fn() }));

import { run } from "../src/commands/api.js";
import { sendRequest } from "../src/lib/client.js";
import { buildExecuteCommand } from "../src/lib/dryRun.js";
import { enforceGates } from "../src/lib/gates.js";
import { quoteFlagValue } from "../src/lib/shell.js";

function argumentsOf(shell: string, command: string): string[] {
  return execFileSync(shell, ["-c", `az-axi() { printf '%s\\0' "$@"; }; ${command}`], { encoding: "utf8" }).split("\0").slice(0, -1);
}

describe.each(["sh", "zsh"])("command hints in %s", (shell) => {
  it("preserves every execute argument", () => {
    const path = "/subscriptions/id/resourceGroups/rg?api-version=1&x=2";
    const query = "a=1&b=2;*<>|()!#~";
    const body = JSON.stringify({ text: "it's $HOME `whoami` \\ a\nb" });
    const version = "1&2";
    const etag = 'W/"a\'b"';
    const confirm = "name;*";
    const profile = "name & 'quoted'";
    const command = buildExecuteCommand({ method: "PATCH", path, resource: "arm", apiVersion: version, queryRaw: query, bodyRaw: body, etag, confirmName: confirm, selectors: `--profile ${quoteFlagValue(profile)}` });
    expect(argumentsOf(shell, command.slice(1, -1))).toEqual(["api", "PATCH", path, "--profile", profile, "--api-version", version, "--query", query, "--body", body, "--if-match", etag, "--execute", "--confirm", confirm]);
    expect(argumentsOf(shell, `az-axi ${quoteFlagValue("")}`)).toEqual([""]);
  });

  it.each([undefined, "wrong"])("preserves the confirmation target with confirm=%s", (confirm) => {
    const target = "a&b'c*";
    try {
      enforceGates({ name: "writer", source: "implicit", auth: "token", allowWrites: true, writeSubscriptions: ["id"] }, { method: "DELETE", resource: "arm", path: `/subscriptions/id/resourceGroups/${encodeURIComponent(target)}` }, "destructive", { execute: true, confirm });
      throw new Error("expected confirmation error");
    } catch (err) {
      expect(err).toMatchObject({ code: confirm ? "CONFIRM_MISMATCH" : "CONFIRM_REQUIRED" });
      const hint = (err as { suggestions: string[] }).suggestions[0]!;
      expect(argumentsOf(shell, `az-axi ${hint.replace("Re-run with ", "")}`)).toEqual(["--confirm", target]);
    }
  });

  it("preserves paging path, version, query and body", async () => {
    vi.mocked(sendRequest).mockResolvedValue({ status: 200, headers: {}, body: { value: [], nextLink: "https://management.azure.com/next?api-version=1" }, clientRequestId: "test" });
    const path = "/things?api-version=1&x=2";
    const version = "1&2";
    const query = "a=1&b=2";
    const body = '{"text":"a\'b"}';
    const result = await run([path, "--api-version", version, "--query", query, "--body", body]);
    const hint = (result.help as string[])[0]!;
    const command = hint.slice(hint.indexOf("`") + 1, -1);
    expect(argumentsOf(shell, command)).toEqual(["api", path, "--api-version", version, "--query", query, "--body", body, "--all"]);
  });
});
