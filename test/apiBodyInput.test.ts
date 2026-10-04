import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUB = "00000000-0000-0000-0000-000000000021";
const TARGET = `/subscriptions/${SUB}/resourceGroups/rg-demo`;
const BODY = '{\n  "tags": {"env": "prod", "note": "quotes \\\" and $() ` |"}\n}\n';
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-body-"));
  writeFileSync(join(dir, "body file.json"), BODY);
  writeFileSync(join(dir, "bad.json"), "{invalid");
  writeFileSync(join(dir, "empty.json"), "");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: {
    reader: { auth: "token" }, writer: { auth: "token", allowWrites: true, subscriptions: [SUB] },
  } }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function cli(flags: string[], input = "", path = TARGET, method = "PATCH", readOnly = "", profile = "writer") {
  return spawnSync(process.execPath, ["--import", pathToFileURL(join(ROOT, "test/apiWritesPreload.mjs")).href,
    join(ROOT, "dist/bin/az-axi.js"), "api", method, path, "--api-version", "1", "--profile", profile, ...flags], {
    cwd: ROOT, encoding: "utf8", input, env: { ...process.env, AZ_AXI_CONFIG: join(dir, "config.json"),
      AZ_AXI_ARM_TOKEN: "offline-body-test-token", AZ_AXI_PROFILE: "", AZ_AXI_TENANT: "", AZ_AXI_SUBSCRIPTION: "",
      AZ_AXI_READ_ONLY: readOnly, AZ_AXI_WRITE_LOG: join(dir, "writes.log"), AZ_AXI_TEST_OUTCOME: "sync",
      AZ_AXI_TEST_CAPTURE_BODY: "1", AZ_AXI_TEST_REQUESTS: join(dir, "requests.jsonl") },
  });
}
function requests(): Array<{ method: string; body?: unknown; ifMatch?: string }> {
  const path = join(dir, "requests.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}
function source(form: string): { flags: string[]; input: string } {
  return form === "file" ? { flags: ["--body-file", join(dir, "body file.json")], input: "" } : { flags: [], input: BODY };
}

describe("built API body inputs, offline only", () => {
  it.each(["inline", "file", "stdin"])("keeps secret parameter values out of %s deployment previews and hints", (form) => {
    const body = { properties: { mode: "Incremental", parameters: {
      password: { value: "disposable-password-value" }, location: { value: "westus" },
    } } };
    const input = JSON.stringify(body);
    writeFileSync(join(dir, "body file.json"), input);
    const flags = form === "inline" ? ["--body", input] : form === "file" ? ["--body-file", join(dir, "body file.json")] : [];
    const result = cli(flags, form === "stdin" ? input : "", `${TARGET}/providers/Microsoft.Resources/deployments/demo`, "PUT");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain("disposable-password-value");
    const output = decode(result.stdout) as { body: typeof body; help: string[] };
    expect(output.body.properties.parameters).toEqual({
      password: { value: "***redacted***" }, location: { value: "westus" },
    });
    expect(output.help.join("\n")).toContain("--body-file");
    expect(requests()).toEqual([{ method: "POST", body }]);
  });

  // Windows filenames cannot contain tab characters.
  it.each(process.platform === "win32" ? [" "] : [" ", "\t"])("preserves body-file paths ending in %j through preview and execution", (suffix) => {
    const file = join(dir, `body.json${suffix}`);
    writeFileSync(join(dir, "body.json"), '{"tags":{"env":"wrong"}}');
    writeFileSync(file, '{"tags":{"env":"selected"}}');
    const preview = cli(["--body-file", file]);
    expect(preview.status, preview.stdout + preview.stderr).toBe(0);
    const output = decode(preview.stdout) as { help: string[] };
    expect(output.help.join("\n")).toContain(`--body-file '${file}'`);
    const executed = cli(["--body-file", file, "--execute"]);
    expect(executed.status, executed.stdout + executed.stderr).toBe(0);
    expect(requests().at(-1)?.body).toEqual({ tags: { env: "selected" } });
  });

  it("rejects a whitespace-only body-file value before requests", () => {
    const result = cli(["--body-file", " \t "]);
    expect(result.status, result.stdout + result.stderr).toBe(2);
    expect(result.stdout).toContain("VALIDATION_ERROR");
    expect(requests()).toEqual([]);
  });

  it.each(["file", "stdin"])("preserves multiline %s bodies through query, preview and ETag execution", (form) => {
    const { flags, input } = source(form);
    const preview = cli(flags, input);
    expect(preview.status, preview.stdout + preview.stderr).toBe(0);
    expect(preview.stdout).toContain("dryRun: true");
    expect(preview.stdout).toContain("--body-file");
    expect(preview.stdout).toContain(form === "file" ? "body file.json" : "<body-file>");
    expect(preview.stdout).toContain("--if-match");
    expect(requests().map((call) => call.method)).toEqual(["GET"]);
    const executed = cli([...flags, "--execute", "--if-match", '"reviewed"'], input);
    expect(executed.status, executed.stdout + executed.stderr).toBe(0);
    expect(requests().at(-1)).toEqual({ method: "PATCH", body: JSON.parse(BODY), ifMatch: '"reviewed"' });
    const query = cli(flags, input, "/providers/Microsoft.ResourceGraph/resources", "POST");
    expect(query.status, query.stdout + query.stderr).toBe(0);
    expect(requests().at(-1)).toEqual({ method: "POST", body: JSON.parse(BODY) });
  });

  it.each(["file", "stdin"])("keeps read-only, credential, scope and confirmation gates for %s", (form) => {
    const { flags, input } = source(form);
    const cases = [
      cli([...flags, "--execute"], input, TARGET, "PATCH", "", "reader"),
      cli([...flags, "--execute"], input, TARGET, "PATCH", "1"),
      cli(flags, input, `${TARGET}/providers/Microsoft.Storage/storageAccounts/demo/listKeys`, "POST"),
      cli(flags, input, TARGET.replace(SUB, "00000000-0000-0000-0000-000000000022")),
      cli([...flags, "--execute"], input, TARGET, "DELETE"),
      cli([...flags, "--execute", "--confirm", "wrong"], input, TARGET, "DELETE"),
    ];
    cases.forEach((result, index) => {
      expect(result.status, result.stdout + result.stderr).toBe(2);
      expect(result.stdout).toContain(["WRITES_DISABLED", "WRITES_DISABLED", "READ_ONLY", "SUBSCRIPTION_NOT_WRITABLE", "CONFIRM_REQUIRED", "CONFIRM_MISMATCH"][index]);
    });
    expect(requests()).toEqual([]);
    expect(existsSync(join(dir, "writes.log"))).toBe(false);
  });

  it.each(["conflict", "inline-stdin", "file-stdin", "invalid-file", "invalid-stdin", "empty-file", "missing-file", "missing-value", "blank-value"])("refuses %s before requests", (kind) => {
    const file = join(dir, "body file.json");
    const flags = kind === "conflict" ? ["--body", "{}", "--body-file", file] :
      kind === "inline-stdin" ? ["--body", "{}"] : kind === "file-stdin" ? ["--body-file", file] :
      kind === "invalid-file" ? ["--body-file", join(dir, "bad.json")] :
      kind === "empty-file" ? ["--body-file", join(dir, "empty.json")] :
      kind === "missing-file" ? ["--body-file", join(dir, "missing.json")] :
      kind === "missing-value" ? ["--body-file"] : kind === "blank-value" ? ["--body-file="] : [];
    const result = cli(flags, kind.endsWith("stdin") ? "{invalid" : "");
    expect(result.status, result.stdout + result.stderr).toBe(2);
    expect(result.stdout).toContain("VALIDATION_ERROR");
    expect(requests()).toEqual([]);
  });

  it("treats empty stdin as absent and accepts all JSON values", () => {
    expect(cli([], "", "/subscriptions", "GET").status).toBe(0);
    for (const input of ["null", "false", "0", '"text"', "[]", "{}"]) {
      const result = cli([], input, "/providers/Microsoft.ResourceGraph/resources", "POST");
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(requests().at(-1)?.body).toEqual(JSON.parse(input));
    }
  });

  describe.each(["inline", "file", "stdin"])("%s JSON strings", (form) => {
    it.each(["text", "false", '{"tags":{"env":"prod"}}'])("preserves %j through queries, execution and deployment previews", (body) => {
      const input = JSON.stringify(body);
      writeFileSync(join(dir, "body file.json"), input);
      const flags = form === "inline" ? ["--body", input] : form === "file" ? ["--body-file", join(dir, "body file.json")] : [];
      const stdin = form === "stdin" ? input : "";
      const cases = [
        { path: "/providers/Microsoft.ResourceGraph/resources", method: "POST", flags },
        { path: TARGET, method: "PATCH", flags: [...flags, "--execute"] },
        { path: `${TARGET}/providers/Microsoft.Resources/deployments/demo`, method: "PUT", flags },
      ];
      for (const request of cases) {
        const result = cli(request.flags, stdin, request.path, request.method);
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(requests().at(-1)).toMatchObject({ method: request.method === "PUT" ? "POST" : request.method, body });
      }
    });
  });
});
