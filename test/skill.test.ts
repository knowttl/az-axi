import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { skillMarkdown } from "../src/lib/skill.js";

describe("packaged agent skill", () => {
  it("matches the committed SKILL.md generated from code", () => {
    const skill = readFileSync(new URL("../skills/az-axi/SKILL.md", import.meta.url), "utf8");
    expect(skill).toBe(skillMarkdown());
  });

  it("stays trigger-shaped, static and non-interactive", () => {
    const skill = readFileSync(new URL("../skills/az-axi/SKILL.md", import.meta.url), "utf8");
    const match = skill.match(/^---\n([\s\S]*?)\n---\n/);
    expect(match).not.toBeNull();
    // Trigger-shaped frontmatter: name plus a terse single-line description.
    expect(match![1]!.split("\n").filter((line) => line.startsWith("description:"))).toHaveLength(1);
    expect(match![1]!).toMatch(/^name: az-axi$/m);
    // No live state: the static skill never carries session data.
    expect(skill).not.toMatch(/\(token\)|tenantId|subscriptionId/);
    // Runnable command forms use the non-interactive npx invocation; the only
    // bare `az-axi ...` names are the generated registry table identifiers.
    const table = skill.split("<!-- command-registry:start -->")[1]!.split("<!-- command-registry:end -->")[0]!;
    const prose = skill.replace(table, "");
    for (const line of prose.split("\n")) {
      if (line.includes("`az-axi ")) expect(line).toContain("npx -y @knowttl/az-axi");
    }
    expect(skill).toContain("npx -y @knowttl/az-axi");
  });
});
