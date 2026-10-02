import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { describe, expect, it } from "vitest";
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

describe("benchmark token counter", () => {
  it("matches o200k_base encoding for JSON, TOON, Unicode and special-token spellings", () => {
    for (const text of ["", "hello world", '{"name":"example"}', "rows[1]{name}:\n  example", "你好 🌍", "<|endoftext|>"]) {
      expect(countTokens(text)).toBe(encode(text, { disallowedSpecial: new Set() }).length);
    }
    expect(countTokens("")).toBe(0);
    expect(countTokens("hello world")).toBe(2);
  });
});
