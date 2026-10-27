import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ sendRequest: vi.fn() }));

import { sendRequest } from "../src/lib/client.js";
import { formatError } from "../src/lib/errors.js";
import { assertKqlSyntax } from "../src/lib/kusto.js";
import { runCommand } from "../src/lib/registry.js";
import { routeArgv } from "../src/lib/router.js";
import { registerSecret } from "../src/lib/redact.js";

let dir: string;
let config: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-kql-"));
  config = process.env.AZ_AXI_CONFIG;
  process.env.AZ_AXI_CONFIG = join(dir, "config.json");
  vi.mocked(sendRequest).mockReset();
});
afterEach(() => {
  if (config === undefined) delete process.env.AZ_AXI_CONFIG;
  else process.env.AZ_AXI_CONFIG = config;
  rmSync(dir, { recursive: true, force: true });
});

it.each([
  ["logs query", [], ["--workspace", "00000000-0000-0000-0000-000000000010"]],
  ["rg query", [], []],
  ["graph query", ["--graph-query"], []],
  ["monitor log-analytics query", ["--analytics-query"], ["--workspace", "00000000-0000-0000-0000-000000000010"]],
] as const)("%s rejects malformed KQL before any request and emits TOON diagnostics", async (command, inputFlags, flags) => {
  const { argv } = routeArgv([...command.split(" "), ...inputFlags, "SigninLogs | wher ResultType != 0 | take 5", ...flags]);
  const error = await runCommand(argv[0]!, argv.slice(1)).catch((error: unknown) => error);
  const formatted = formatError(error);
  expect(formatted.exitCode).toBe(2);
  expect(formatted.output).toContain("code: VALIDATION_ERROR");
  expect(formatted.output).toContain("diagnostics[2]{line,column,code,token,message}:");
  expect(formatted.output).toContain("1,14,KS176,wher,Query operator expected.");
  expect(formatted.output).toContain("1,19,KS005,ResultType");
  expect(formatted.output).toContain("The query was not sent.");
  expect(formatted.output).toContain("^^^^");
  expect(sendRequest).not.toHaveBeenCalled();
});

it.each([
  ["SigninLogs\n| wher ResultType != 0", 2, 3],
  ["SigninLogs\r\n| wher ResultType != 0", 2, 3],
  ["SigninLogs | where (ResultType == 0", 1, 36],
  ["SigninLogs | where ResultType == \"oops", 1, 39],
])("locates syntax errors in %s", async (query, line, column) => {
  await expect(assertKqlSyntax(query)).rejects.toMatchObject({
    code: "VALIDATION_ERROR", diagnostics: expect.arrayContaining([expect.objectContaining({ line, column })]),
  });
});

it.each([
  "let recent = SigninLogs | take 5; recent",
  'workspace("example").SigninLogs | take 5',
  "_Im_Authentication(starttime=ago(1d)) | take 5",
  "let cached = materialize(SigninLogs | take 5); cached",
  "UnknownTable | project UnknownColumn",
])("allows schema-dependent KQL without claiming validity: %s", async (query) => {
  await expect(assertKqlSyntax(query)).resolves.toBeUndefined();
});

it("caps diagnostics at five and reports the omitted count", async () => {
  const error = await assertKqlSyntax("T | wher a; T | wher b; T | wher c; T | wher d").catch((error: unknown) => error);
  expect(error).toMatchObject({ diagnostics: expect.any(Array), suggestions: expect.arrayContaining(["Showing 5 of 8 syntax diagnostics"]) });
  expect((error as { diagnostics: unknown[] }).diagnostics).toHaveLength(5);
});

it("redacts registered secrets in query tokens and excerpts", async () => {
  registerSecret("sensitiveQueryFragment");
  const error = await assertKqlSyntax("T | sensitiveQueryFragment").catch((error: unknown) => error);
  const formatted = formatError(error);
  expect(formatted.output).not.toContain("sensitiveQueryFragment");
  expect(formatted.output).toContain("***redacted***");
});
