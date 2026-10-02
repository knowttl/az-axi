import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SUB = "00000000-0000-0000-0000-000000000021";
const SUB_PATH = `/subscriptions/${SUB}`;
const OPERATION_URL = `https://management.azure.com${SUB_PATH}/operations/op1?api-version=1&label=a'b`;
const RESULT = { status: "Succeeded", properties: { changes: [{ changeType: "Create" }] } };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(process.cwd(), ".op-status-test-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    profiles: { writer: { auth: "token", allowWrites: true, subscriptions: [SUB] } },
  }));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function cli(args: string[], shell = false, readOnly = false) {
  const stub = `let calls=0; globalThis.fetch=async(url,init)=>{
    if(++calls!==1) throw new Error('Unexpected polling');
    if(init.method==='POST' && new URL(url).pathname.endsWith('/whatIf'))
      return new Response('{}',{status:202,headers:{location:${JSON.stringify(OPERATION_URL)}}});
    if(url!==${JSON.stringify(new URL(OPERATION_URL).toString())} || init.method!=='GET' || init.body!==undefined)
      throw new Error('Unexpected operation request');
    return new Response(${JSON.stringify(JSON.stringify(RESULT))},{status:200});
  }`;
  return spawnSync(shell ? "zsh" : process.execPath, shell ? ["-c", args[0]!] : ["--import", "tsx", "src/bin/az-axi.ts", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: `--import data:text/javascript,${encodeURIComponent(stub)}`,
      AZ_AXI_CONFIG: join(dir, "config.json"),
      AZ_AXI_ARM_TOKEN: "op-status-test-token",
      AZ_AXI_PROFILE: "missing-test-profile",
      AZ_AXI_READ_ONLY: readOnly ? "1" : "0",
      AZ_AXI_SUBSCRIPTION: SUB,
    },
  });
}

describe("pending operation status", () => {
  it.each([SUB_PATH, `${SUB_PATH}/resourceGroups/rg-demo`])("copies the pending deployment status command under %s", (scope) => {
    const preview = cli(["api", "PUT", `${scope}/providers/Microsoft.Resources/deployments/dep1`, "--api-version", "1", "--profile", "writer", "--body", '{"properties":{"template":{}}}']);
    expect(preview.status, preview.stdout).toBe(0);
    const output = decode(preview.stdout) as { pending: boolean; help: string[] };
    expect(output.pending).toBe(true);
    expect(output.help).toHaveLength(1);
    const command = output.help[0]!.slice(1, -1);
    const status = cli([`az-axi() { node --import tsx src/bin/az-axi.ts "$@"; }\n${command}`], true);
    expect(status.status, status.stdout).toBe(0);
    expect(decode(status.stdout)).toEqual(RESULT);
    expect(status.stderr).toBe("");
  });

  it("reads operation status with writes disabled", () => {
    const result = cli(["op", "status", OPERATION_URL, "--profile", "writer"], false, true);
    expect(result.status, result.stdout).toBe(0);
    expect(decode(result.stdout)).toEqual(RESULT);
  });

  it.each([
    ["op", "status"],
    ["op", "status", OPERATION_URL, "extra"],
    ["op", "status", OPERATION_URL, "--execute"],
    ["op", "status", "/subscriptions/test/operations/op1?api-version=1"],
    ["op", "status", "https://example.com/operation?api-version=1"],
    ["op", "status", "http://management.azure.com/operation?api-version=1"],
    ["op", "status", "https://management.azure.com.evil.test/operation?api-version=1"],
  ])("rejects invalid status invocation %j", (...args) => {
    const result = cli(args);
    expect(result.status, result.stdout).toBe(2);
    expect((decode(result.stdout) as { code: string }).code).toMatch(/^(VALIDATION_ERROR|UNKNOWN_FLAG)$/);
    expect(result.stderr).toBe("");
  });
});
