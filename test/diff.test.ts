import { describe, expect, it } from "vitest";
import { diffResource, MAX_CHANGES } from "../src/lib/diff.js";

// Synthetic resource shapes; no identifiers needed for change computation.
const CURRENT = {
  name: "stexample",
  location: "westeurope",
  tags: { env: "prod", team: "billing" },
  properties: { sku: { name: "Standard_LRS" }, accessTier: "Hot" },
};

describe("diffResource", () => {
  it.each(["PUT", "PATCH"] as const)("displays query-only URI changes distinctly for %s", (method) => {
    const from = "https://example.com/view?team=dev#cpu";
    const to = "https://example.com/view?team=ops#cpu";
    expect(diffResource({ tags: { dashboard: from } }, { tags: { dashboard: to } }, method)).toEqual({
      changes: [{ path: "tags.dashboard", from, to }], remaining: 0, noop: false,
    });
  });

  it("lists PATCH changes at dot paths and ignores untouched current fields", () => {
    const diff = diffResource(CURRENT, { tags: { env: "dev" }, location: "northeurope" }, "PATCH");
    expect(diff.noop).toBe(false);
    expect(diff.remaining).toBe(0);
    expect(diff.changes).toEqual([
      { path: "tags.env", from: "prod", to: "dev" },
      { path: "location", from: "westeurope", to: "northeurope" },
      { path: "tags.team", from: "billing", to: undefined },
    ]);
  });

  it("reports a PATCH addition with an undefined from", () => {
    const diff = diffResource(CURRENT, { tags: { owner: "data" } }, "PATCH");
    expect(diff.changes).toEqual([
      { path: "tags.owner", from: undefined, to: "data" },
      { path: "tags.env", from: "prod", to: undefined },
      { path: "tags.team", from: "billing", to: undefined },
    ]);
  });

  it("lists PUT removals with an undefined to", () => {
    const diff = diffResource(CURRENT, { name: "stexample", location: "westeurope" }, "PUT");
    expect(diff.changes).toEqual([
      { path: "tags.env", from: "prod", to: undefined },
      { path: "tags.team", from: "billing", to: undefined },
      { path: "properties.sku.name", from: "Standard_LRS", to: undefined },
      { path: "properties.accessTier", from: "Hot", to: undefined },
    ]);
  });

  it("treats prototype-named fields as own additions and removals", () => {
    for (const key of ["toString", "constructor", "__proto__"]) {
      const tags = Object.fromEntries([[key, "billing"]]);
      for (const method of ["PUT", "PATCH"] as const) {
        expect(diffResource({ tags: {} }, { tags }, method)).toEqual({
          changes: [{ path: `tags.${key}`, from: undefined, to: "billing" }],
          remaining: 0,
          noop: false,
        });
        expect(diffResource({ tags }, { tags }, method).noop).toBe(true);
      }
      expect(diffResource({ tags }, { tags: {} }, "PUT")).toEqual({
        changes: [{ path: `tags.${key}`, from: "billing", to: undefined }],
        remaining: 0,
        noop: false,
      });
      expect(diffResource({ tags }, { tags: {} }, "PATCH")).toEqual(diffResource({ tags }, { tags: {} }, "PUT"));
    }
  });

  it("requires matching own keys in objects inside arrays", () => {
    const current = { list: [JSON.parse('{"__proto__":{}}')] };
    const body = { list: [{ other: {} }] };
    for (const method of ["PUT", "PATCH"] as const) {
      for (const [from, to] of [[current, body], [body, current]] as const) {
        expect(diffResource(from, to, method)).toEqual({
          changes: [{ path: "list", from: from.list, to: to.list }],
          remaining: 0,
          noop: false,
        });
      }
    }
  });

  it("lists empty objects as terminal PUT removals at every depth", () => {
    const current = { properties: { settings: {}, nested: { empty: {}, value: 1 } } };
    expect(diffResource(current, { properties: {} }, "PUT")).toEqual({
      changes: [
        { path: "properties.settings", from: {}, to: undefined },
        { path: "properties.nested.empty", from: {}, to: undefined },
        { path: "properties.nested.value", from: 1, to: undefined },
      ],
      remaining: 0,
      noop: false,
    });
    expect(diffResource(current, { properties: {} }, "PATCH").noop).toBe(true);
    expect(diffResource(current, current, "PUT").noop).toBe(true);
  });

  it("detects a no-op for equal bodies regardless of key order", () => {
    const body = {
      properties: { accessTier: "Hot", sku: { name: "Standard_LRS" } },
      tags: { team: "billing", env: "prod" },
      location: "westeurope",
      name: "stexample",
    };
    for (const method of ["PUT", "PATCH"] as const) {
      expect(diffResource(CURRENT, body, method)).toEqual({ changes: [], remaining: 0, noop: true });
    }
  });

  it("detects a no-op PATCH for an empty body", () => {
    expect(diffResource(CURRENT, {}, "PATCH").noop).toBe(true);
  });

  it.each(["PUT", "PATCH"])("includes omitted tags in %s replacements", (method) => {
    for (const tags of [{ env: "prod" }, {}]) {
      const diff = diffResource(CURRENT, { ...CURRENT, tags }, method);
      expect(diff.noop).toBe(false);
      expect(diff.changes).toEqual([
        ...(Object.hasOwn(tags, "env") ? [] : [{ path: "tags.env", from: "prod", to: undefined }]),
        { path: "tags.team", from: "billing", to: undefined },
      ]);
    }
    expect(diffResource(CURRENT, { properties: { accessTier: "Hot" } }, "PATCH").noop).toBe(true);
  });

  it("reports an empty PUT body as removing every leaf", () => {
    const diff = diffResource({ a: 1, nested: { b: 2 } }, {}, "PUT");
    expect(diff.noop).toBe(false);
    expect(diff.changes).toEqual([
      { path: "a", from: 1, to: undefined },
      { path: "nested.b", from: 2, to: undefined },
    ]);
  });

  it("compares arrays as a whole value", () => {
    const current = { list: ["a", "b"] };
    expect(diffResource(current, { list: ["a", "b"] }, "PATCH").noop).toBe(true);
    expect(diffResource(current, { list: ["a", "c"] }, "PATCH").changes).toEqual([
      { path: "list", from: ["a", "b"], to: ["a", "c"] },
    ]);
  });

  it("reports an object replaced by a primitive as one change", () => {
    expect(diffResource({ a: { b: 1 } }, { a: 5 }, "PATCH").changes).toEqual([
      { path: "a", from: { b: 1 }, to: 5 },
    ]);
  });

  it("caps rows at 20 with a count of the rest", () => {
    const current: Record<string, number> = {};
    const body: Record<string, number> = {};
    for (let i = 0; i < 25; i++) {
      current[`f${i}`] = i;
      body[`f${i}`] = i + 100;
    }
    const diff = diffResource(current, body, "PATCH");
    expect(diff.changes).toHaveLength(MAX_CHANGES);
    expect(MAX_CHANGES).toBe(20);
    expect(diff.remaining).toBe(5);
    expect(diff.noop).toBe(false);
    expect(diff.changes[0]).toEqual({ path: "f0", from: 0, to: 100 });
  });

  it("does not mutate its inputs", () => {
    const current = structuredClone(CURRENT);
    const body = { tags: { env: "dev" } };
    const bodyCopy = structuredClone(body);
    diffResource(current, body, "PUT");
    expect(current).toEqual(CURRENT);
    expect(body).toEqual(bodyCopy);
  });
});
