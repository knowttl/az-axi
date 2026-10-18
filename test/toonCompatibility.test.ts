import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode, encode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { redact } from "../src/lib/redact.js";
import { packageInfo } from "../src/lib/version.js";

// Synthetic wire corpus: snapshots include the final newline consumed by agents.
const corpus = [
  ["table", { resources: [{ name: "vm-demo", state: "running", count: 1 }, { name: "vm-other", state: "stopped", count: 0 }] }],
  ["nested records", { resource: { name: "vm-demo", properties: { enabled: true, tags: { env: "test" } } }, rows: [{ name: "a", nested: { count: 2 } }, { name: "b", nested: { count: 0 } }] }],
  ["empty arrays", { resources: [], nested: { values: [] }, mixed: [[], {}] }],
  ["escaping", { values: ["a,b", 'say "hello"', "C:\\demo", "a:b", "[item]", "true", "001", "", " leading", "trailing ", "# comment", "---", "\uFEFFstart"], "key:colon": "value", "key.dot": "literal" }],
  ["multiline", { message: "line one\nline two\r\nlast\tcolumn", rows: [{ name: "first", body: "a\nb" }, { name: "second", body: "c\td" }] }],
  ["error envelope", { error: 'request failed: "retry"\nnext line', code: "VALIDATION_ERROR", help: ["Run `az-axi sub list`", "first\nsecond"] }],
  ["redaction", { password: "synthetic-password", nested: { connectionString: "AccountKey=synthetic-key", url: "https://example.com/?sig=synthetic-signature" }, keys: [{ keyName: "primary", value: "synthetic-value" }], name: "visible" }],
] as const;

describe("TOON output compatibility", () => {
  it.each(corpus)("renders %s", (_name, value) => {
    expect(`${encode(redact(value))}\n`).toMatchSnapshot();
  });

  it.each(corpus)("preserves the redacted data in %s", (_name, value) => {
    expect(decode(encode(redact(value)))).toEqual(redact(value));
  });

  it.each([
    ["CLI table", "az-axi", ["sub", "list"], 200, { value: [{ subscriptionId: "00000000-0000-0000-0000-000000000001", displayName: "Sandbox, demo", state: "Enabled" }] }, 0],
    ["CLI nested redaction", "az-axi", ["api", "GET", "/subscriptions", "--api-version", "2022-12-01"], 200, { properties: { message: "first\nsecond", password: "synthetic-password" }, values: [] }, 0],
    ["CLI empty list", "az-axi", ["sub", "list"], 200, { value: [] }, 0],
    ["CLI service error", "az-axi", ["sub", "list"], 401, { error: { code: "InvalidAuthenticationToken", message: "rejected synthetic-corpus-token" } }, 2],
    ["CLI usage error", "az-axi", ["no-such-command"], 200, {}, 2],
    ["hook summary", "az-axi-hook", [], 200, {}, 0],
    ["hook usage error", "az-axi-hook", ["--no-such-flag"], 200, {}, 2],
  ] as const)("renders %s", (_name, bin, args, status, body, exitCode) => {
    const dir = mkdtempSync(join(tmpdir(), "az-axi-toon-"));
    try {
      const config = join(dir, "config.json");
      writeFileSync(config, JSON.stringify({ version: 1, profiles: { demo: {
        auth: "token", subscriptions: ["00000000-0000-0000-0000-000000000001"],
      } } }));
      const stub = `globalThis.fetch=async()=>new Response(${JSON.stringify(JSON.stringify(body))},{status:${status},headers:{'content-type':'application/json','x-ms-request-id':'synthetic-request'}})`;
      const result = spawnSync(process.execPath, [
        "--import", `data:text/javascript,${encodeURIComponent(stub)}`, `dist/bin/${bin}.js`, ...args,
      ], {
        encoding: "utf8",
        env: {
          ...process.env,
          AZ_AXI_CONFIG: config,
          AZ_AXI_PROFILE: "demo",
          AZ_AXI_TENANT: "",
          AZ_AXI_SUBSCRIPTION: "",
          AZ_AXI_READ_ONLY: "1",
          AZ_AXI_ARM_TOKEN: "synthetic-corpus-token",
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(exitCode);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain("synthetic-corpus-token");
      expect(result.stdout).not.toContain("synthetic-password");
      expect(result.stdout.replace(`version: ${packageInfo().version}\n`, "version: <version>\n")).toMatchSnapshot();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
