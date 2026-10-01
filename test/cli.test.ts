import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules/tsx/dist/cli.mjs");

function run(args: string[]) {
  return spawnSync(process.execPath, [TSX, "src/bin/az-axi.ts", ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

const INHERITED = ["toString", "valueOf", "hasOwnProperty", "__proto__", "constructor", "toLocaleString", "isPrototypeOf"];

describe("command dispatch", () => {
  it("rejects inherited command names with the unknown-command exit", () => {
    for (const command of INHERITED) {
      for (const args of [[command], [command, "--help"]]) {
        const result = run(args);
        expect(result.status, args.join(" ")).toBe(2);
        expect(result.stderr, args.join(" ")).toBe("");
        expect(result.stdout, args.join(" ")).toContain(`unknown command \`${command}\``);
        expect(result.stdout, args.join(" ")).toContain("code: VALIDATION_ERROR");
      }
    }
  }, 60_000);

  it("keeps registered commands and hides the built-in update surface", () => {
    const help = run(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).not.toContain("update --check");

    const homeHelp = run(["home", "--help"]);
    expect(homeHelp.status).toBe(0);
    expect(homeHelp.stdout).toContain("placeholder dashboard");

    const home = run([]);
    expect(home.status).toBe(0);
    expect(home.stdout).toContain("bootstrap build: no commands are implemented yet");

    const update = run(["update"]);
    expect(update.status).toBe(2);
    expect(update.stdout).toContain("unknown command `update`");
    expect(update.stdout).toContain("code: VALIDATION_ERROR");
  }, 30_000);
});
