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
  it("lists PATCH changes at dot paths and ignores untouched current fields", () => {
    const diff = diffResource(CURRENT, { tags: { env: "dev" }, location: "northeurope" }, "PATCH");
    expect(diff.noop).toBe(false);
    expect(diff.remaining).toBe(0);
    expect(diff.changes).toEqual([
      { path: "tags.env", from: "prod", to: "dev" },
      { path: "location", from: "westeurope", to: "northeurope" },
    ]);
  });

  it("reports a PATCH addition with an undefined from", () => {
    const diff = diffResource(CURRENT, { tags: { owner: "data" } }, "PATCH");
    expect(diff.changes).toEqual([{ path: "tags.owner", from: undefined, to: "data" }]);
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
