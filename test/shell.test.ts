import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/lib/client.js")>(),
  sendRequest: vi.fn(),
}));

import { run } from "../src/commands/api.js";
import { sendRequest } from "../src/lib/client.js";
import { buildExecuteCommand } from "../src/lib/dryRun.js";
import { enforceGates } from "../src/lib/gates.js";
import { formatFlagValue, quoteFlagValue } from "../src/lib/shell.js";
import { parseArgs } from "../src/lib/args.js";

function argumentsOf(shell: string, command: string): string[] {
  return execFileSync(shell, ["-s"], { encoding: "utf8", input: `capture() { printf '%s\\0' "$@"; }; ${command.replace(/^az-axi /, "capture ")}` }).split("\0").slice(0, -1);
}

describe.each(["sh", "bash"])("command hints in %s", (shell) => {
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

  it.each([[undefined, "a&b'c*"], ["wrong", "a&b'c*"], [undefined, "--prod"], ["wrong", "--prod"]] as const)(
    "preserves confirm=%s for target=%s", (confirm, target) => {
      try {
        enforceGates({ name: "writer", source: "implicit", auth: "token", allowWrites: true, writeSubscriptions: ["id"] }, { method: "DELETE", resource: "arm", path: `/subscriptions/id/resourceGroups/${encodeURIComponent(target)}` }, "destructive", { execute: true, confirm });
        throw new Error("expected confirmation error");
      } catch (err) {
        expect(err).toMatchObject({ code: confirm ? "CONFIRM_MISMATCH" : "CONFIRM_REQUIRED" });
        const hint = (err as { suggestions: string[] }).suggestions[0]!;
        expect(parseArgs(argumentsOf(shell, `az-axi ${hint.replace("Re-run with ", "")}`))).toEqual({ flags: { confirm: target }, positionals: [] });
      }
    },
  );

  it.each(["profile", "tenant", "subscription", "management-group", "config"])(
    "preserves a leading-dash %s selector", (name) => {
      const value = "--name & 'quoted'";
      const command = buildExecuteCommand({ method: "PATCH", path: "/things", resource: "arm", selectors: formatFlagValue(name, value) });
      expect(parseArgs(argumentsOf(shell, command.slice(1, -1))).flags).toEqual({ [name]: value, execute: true });
    },
  );

  it("preserves leading-dash execute values through CLI parsing", () => {
    const command = buildExecuteCommand({ method: "DELETE", path: "/subscriptions/id/resourceGroups/--prod", resource: "arm", apiVersion: "--version", queryRaw: "--key=value&x=1", etag: "--etag", confirmName: "--prod" });
    expect(parseArgs(argumentsOf(shell, command.slice(1, -1)))).toEqual({
      positionals: ["api", "DELETE", "/subscriptions/id/resourceGroups/--prod"],
      flags: { "api-version": "--version", query: "--key=value&x=1", "if-match": "--etag", execute: true, confirm: "--prod" },
    });
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

  it("preserves leading-dash paging values through CLI parsing", async () => {
    vi.mocked(sendRequest).mockResolvedValue({ status: 200, headers: {}, body: { value: [], nextLink: "https://management.azure.com/next?api-version=1" }, clientRequestId: "test" });
    const result = await run(["/things", "--api-version=--version", "--query=--key=value&x=1"]);
    const hint = (result.help as string[])[0]!;
    const argv = argumentsOf(shell, hint.slice(hint.indexOf("`") + 1, -1));
    expect(parseArgs(argv)).toEqual({ positionals: ["api", "/things"], flags: { "api-version": "--version", query: "--key=value&x=1", all: true } });
    vi.mocked(sendRequest).mockClear();
    await run(argv.slice(1));
    expect(vi.mocked(sendRequest).mock.calls[0]?.[1]).toMatchObject({ apiVersion: "--version", query: { "--key": "value", x: "1" } });
  });
});
