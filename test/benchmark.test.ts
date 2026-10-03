import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/context.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/lib/context.js")>(),
  profileFromArgs: () => ({ name: "benchmark", auth: "token", writeSubscriptions: [] }),
}));
vi.mock("../src/lib/auth.js", () => ({ resolveCredential: async () => ({ header: "Bearer benchmark-dummy" }) }));

import { run as runRg } from "../src/commands/rg.js";
import { run as runSub } from "../src/commands/sub.js";
import { run as runGroup } from "../src/commands/group.js";
import { run as runLogs } from "../src/commands/logs.js";
import { run as runRbac } from "../src/commands/rbac.js";
import { run as runDefender } from "../src/commands/defender.js";
import { run as runActivity } from "../src/commands/activity.js";
import { run as runExposure } from "../src/commands/exposure.js";
import { run as runOp } from "../src/commands/op.js";
import { clearSubscriptionCache } from "../src/lib/scope.js";
import { PUBLIC_VOCABULARY, scrub } from "../scripts/benchmark/scrub.mjs";
import { countTokens } from "../scripts/benchmark/tokens.mjs";

const SUB = "00000000-0000-0000-0000-000000000001";
const PATH = `/subscriptions/${SUB}/resourceGroups/contoso-team/providers/Microsoft.Compute/virtualMachines/contoso-vm`;

describe("benchmark scrubber", () => {
  it("removes private keys and values at every depth without mutation", () => {
    const privateStrings = [
      "contoso-key", "contoso-nested", "contoso-value", SUB,
      "analyst", "example.com", "192.0.2.1", "contoso-vm",
    ];
    const input = {
      "contoso-key": [{ "contoso-nested": "contoso-value" }],
      id: SUB,
      UserPrincipalName: "analyst@example.com",
      IPAddress: "192.0.2.1",
      name: "contoso-vm",
    };
    const before = JSON.stringify(input);
    const result = JSON.stringify(scrub(input, { leakCheck: privateStrings }));
    for (const privateString of privateStrings) expect(result).not.toContain(privateString);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("tokenises private segments in paths, URLs, queries, free text and keys", () => {
    const privateStrings = ["contoso-team", "contoso-vm", "example.com", "contoso-query", "contoso-secret", "contoso-note", SUB];
    const input = {
      [PATH]: `https://example.com${PATH}?api-version=2022-12-01&contoso-query=contoso-secret`,
      name: "contoso-note says 'contoso-secret' | contoso-team\\contoso-vm",
    };
    const result = scrub(input, { leakCheck: privateStrings });
    const serialized = JSON.stringify(result);
    for (const privateString of privateStrings) expect(serialized).not.toContain(privateString);
    expect(Object.keys(result)[0]).toContain("/subscriptions/");
    expect(Object.values(result)[0]).toContain("?api-version=2022-12-01&");
    expect(Object.values(result)[0]).toContain(scrub("contoso-secret"));
  });

  it("keeps only the exact public vocabulary in keys, values and mixed strings", () => {
    for (const word of PUBLIC_VOCABULARY) {
      expect(scrub(word)).toBe(word);
      expect(scrub({ [word]: word })).toEqual({ [word]: word });
      expect(scrub(`/contoso-private/${word}?name=${word}`)).toContain(`/${word}?name=${word}`);
    }
    for (const word of ["Microsoft.Private", "2026-10-02", "HIGH", "High-private", "privateHigh", "TimeGenerated_private"]) {
      expect(scrub(word)).not.toBe(word);
    }
  });

  it("uses the same mapping in replay request keys, response IDs and nested keys", () => {
    const request = scrub({ [PATH]: { id: SUB, name: "contoso-vm" } });
    const response = scrub({ id: PATH, name: "contoso-vm", subscriptionId: SUB });
    expect(Object.keys(request)).toEqual([response.id]);
    expect(request[response.id].id).toBe(response.subscriptionId);
    expect(request[response.id].name).toBe(response.name);
    expect(response.id.split("/").at(-1)).toBe(response.name);
    expect(scrub({ "contoso-vm": "contoso-vm" })).toEqual({ [response.name]: response.name });
  });

  it("preserves timestamps and JSON scalars", () => {
    const timestamps = ["2026-10-02T12:34:56Z", "2026-10-02T12:34:56.1234567Z", "2026-10-02T12:34:56+01:00"];
    expect(scrub(timestamps)).toEqual(timestamps);
    for (const timestamp of timestamps) {
      expect(scrub({ [timestamp]: timestamp })).toEqual({ [timestamp]: timestamp });
      expect(scrub(`/contoso-private?start=${timestamp}`)).toContain(`?${scrub("start")}=${timestamp}`);
    }
    expect(scrub([0, -12, 1.5, true, false, null])).toEqual([0, -12, 1.5, true, false, null]);
    expect(scrub("2026-99-99T12:34:56Z")).not.toBe("2026-99-99T12:34:56Z");
    expect(scrub("1234")).not.toBe("1234");
  });

  it("is deterministic across calls and object traversal orders", () => {
    const first = scrub({ "contoso-one": "contoso-two", "contoso-two": "contoso-one" });
    expect(scrub({ "contoso-two": "contoso-one", "contoso-one": "contoso-two" })).toEqual(first);
    expect(scrub(PATH)).toBe(scrub(PATH));
    expect(scrub("contoso-one")).not.toBe(scrub("contoso-two"));
    expect(scrub("contoso-one")).toMatch(/^scrub_[0-9a-f]{64}$/);
    for (const text of ["", "///", "☃", "contoso%2Fsecret"]) expect(scrub(text)).not.toBe(text);
  });

  it("fails closed if a leakCheck string survives, without printing that string", () => {
    const cases = [
      ["High", "HIGH"],
      [{ High: 1 }, "HIGH"],
      ["2026-10-02T12:34:56Z", "2026-10-02T12:34:56Z"],
      ["/subscriptions/High", "HIGH"],
      ["High\nLow", "\n"],
      [1234, "1234"],
    ] as const;
    for (const [input, privateString] of cases) {
      expect(() => scrub(input, { leakCheck: [privateString] })).toThrow("Benchmark scrub failed: leakCheck string survived");
      try {
        scrub(input, { leakCheck: [privateString] });
      } catch (error) {
        expect(String(error)).not.toContain(privateString);
      }
    }
    expect(() => scrub("contoso-private", { leakCheck: ["contoso-private"] })).not.toThrow();
  });
});

describe("scrubbed response replay", () => {
  const fetchMock = vi.fn();
  const timestamp = "2026-10-02T12:34:56Z";

  beforeEach(() => {
    clearSubscriptionCache();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("preserves group provisioning state through scrubbed response replay", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ value: [{ subscriptionId: SUB }] }))
      .mockResolvedValueOnce(Response.json(scrub({ value: [{
        id: `/subscriptions/${SUB}/resourceGroups/private-group`, name: "private-group",
        properties: { provisioningState: "Succeeded" },
      }] })));
    const result = await runGroup(["list", "--subscription", SUB]);
    expect(result.rows).toEqual([{ name: scrub("private-group"), id: scrub(`/subscriptions/${SUB}/resourceGroups/private-group`), location: "", state: "Succeeded" }]);
  });

  it("keeps Resource Graph rows, totals, pagination and truncation warnings", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(scrub({
      totalRecords: 2, count: 1, data: [{ name: "private-vm" }], $skipToken: "private-page",
    })));
    const result = await runRg(["query", "Resources | take 1", "--full"]);
    expect(result.total).toBe(2);
    expect(result.rows).toEqual([{ name: scrub("private-vm") }]);
    expect(result.help).toEqual([expect.stringContaining(`--skip-token ${scrub("private-page")}`)]);

    fetchMock.mockResolvedValueOnce(Response.json(scrub({
      totalRecords: 1, data: [{ name: "private-vm" }], resultTruncated: "true",
    })));
    expect((await runRg(["query", "Resources | take 1"])).help)
      .toEqual([expect.stringContaining("truncated")]);
  });

  it("follows scrubbed ARM nextLink URLs and formats subscriptions", async () => {
    const nextLink = "https://management.azure.com/subscriptions?api-version=2022-12-01&$skiptoken=private-page";
    fetchMock.mockResolvedValueOnce(Response.json(scrub({
      value: [{ subscriptionId: SUB, displayName: "private-sub", state: "Enabled" }], nextLink,
    }))).mockResolvedValueOnce(Response.json(scrub({ value: [] })));
    const result = await runSub(["list"]);
    expect(result.subscriptions).toEqual([
      { id: scrub(SUB), name: scrub("private-sub"), state: "Enabled", inScope: "yes" },
    ]);
    expect(fetchMock.mock.calls[1][0]).toBe(scrub(nextLink));
  });

  it("converts Log Analytics columns and rows and retains partial errors", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(scrub({
      tables: [{ name: "PrimaryResult", columns: [{ name: "UserPrincipalName", type: "string" }], rows: [["private-user"]] }],
      error: { code: "private-code", details: [{ message: "private-detail" }], innererror: { message: "private-inner" } },
    })));
    const result = await runLogs(["query", "SigninLogs | take 1", "--workspace", SUB, "--full"]);
    expect(result.total).toBe(1);
    expect(result.rows).toEqual([{ UserPrincipalName: scrub("private-user") }]);
    expect(result.warning).toContain(scrub("private-detail"));
    expect(result.warning).toContain(scrub("private-inner"));
  });

  it("resolves scrubbed RBAC principals through Graph", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(scrub({ data: [{
      principalId: SUB, principalType: "User", roleName: "private-role", roleDefinitionId: "private-role-id",
      scope: PATH, createdOn: timestamp,
    }] }))).mockResolvedValueOnce(Response.json(scrub({ value: [{ id: SUB, displayName: "private-user" }] })));
    const result = await runRbac(["list", "--full"]);
    expect(result.rows).toEqual([expect.objectContaining({
      principal: scrub("private-user"), type: "User", role: scrub("private-role"), scope: scrub(PATH),
    })]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ ids: [scrub(SUB)] });
  });

  it("keeps Defender assessment classifications, secure scores and alert fields", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(scrub({ data: [{
      recommendation: "private-recommendation", severity: "High", status: "Unhealthy", resourceId: PATH,
    }] })));
    expect((await runDefender(["assessments", "--resource", scrub(PATH), "--full"])).rows)
      .toEqual([expect.objectContaining({ severity: "High", status: "Unhealthy", recommendation: scrub("private-recommendation") })]);
    fetchMock.mockResolvedValueOnce(Response.json(scrub({ data: [{ subscriptionId: SUB, current: 3, max: 4, percent: 75 }] })));
    expect((await runDefender(["score", "--full"])).rows)
      .toEqual([{ subscription: scrub(SUB), current: 3, max: 4, percent: 75 }]);
    fetchMock.mockResolvedValueOnce(Response.json(scrub({ value: [{ id: PATH, properties: {
      alertDisplayName: "private-alert", severity: "High", status: "Active", timeGeneratedUtc: timestamp,
      resourceIdentifiers: [{ azureResourceId: PATH }],
    } }] })));
    expect((await runDefender(["alerts", "--subscription", SUB, "--full"])).rows)
      .toEqual([expect.objectContaining({ alert: scrub("private-alert"), severity: "High", status: "Active" })]);
  });

  it("keeps activity status filters and exposure rows", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(scrub({ value: [{
      eventTimestamp: timestamp, caller: "private-user", operationName: { value: "private-operation" },
      status: { value: "Failed" }, resourceId: PATH,
    }] })));
    expect((await runActivity(["list", "--subscription", scrub(SUB), "--status", "Failed", "--full"])).rows)
      .toEqual([expect.objectContaining({ caller: scrub("private-user"), status: "Failed", operation: scrub("private-operation") })]);
    fetchMock.mockResolvedValueOnce(Response.json(scrub({ totalRecords: 1, data: [{ resource: "private-vm", detail: "private-detail" }] })));
    expect((await runExposure(["--check", "public-ips", "--full"])).rows)
      .toEqual([expect.objectContaining({ resource: scrub("private-vm"), detail: scrub("private-detail") })]);
  });

  it("keeps running, successful and failed operation states", async () => {
    const url = "https://management.azure.com/subscriptions/private-sub/providers/Microsoft.Compute/private-operation?api-version=2024-04-01";
    for (const status of ["InProgress", "Succeeded", "Failed", "Canceled"]) {
      fetchMock.mockResolvedValueOnce(Response.json(scrub({ status })));
      const result = await runOp(["status", scrub(url)]);
      expect(result.status).toBe(status);
      expect(Boolean(result.help)).toBe(status === "InProgress");
    }
  });
});

describe("benchmark token counter", () => {
  it("matches o200k_base encoding for JSON, TOON, Unicode and special-token spellings", () => {
    for (const text of ["", "hello world", '{"name":"example"}', "rows[1]{name}:\n  example", "你好 🌍", "<|endoftext|>"]) {
      expect(countTokens(text)).toBe(encode(text, { disallowedSpecial: new Set() }).length);
    }
    expect(countTokens("")).toBe(0);
    expect(countTokens("hello world")).toBe(2);
  });
});
