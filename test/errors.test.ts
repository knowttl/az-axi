import { AxiError } from "axi-sdk-js";
import { describe, expect, it } from "vitest";
import { formatError, WriteExecutionError } from "../src/lib/errors.js";
import { registerSecret } from "../src/lib/redact.js";

describe("shared error formatting", () => {
  it.each([
    new Error("AccountKey=synthetic-secret"),
    "AccountKey=synthetic-secret",
    new AxiError("AccountKey=synthetic-secret", "API_ERROR", ["SharedAccessKey=synthetic-remedy"]),
  ])("redacts recognized secret patterns from failures", (error) => {
    const result = formatError(error);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("***redacted***");
    expect(result.output).not.toContain("synthetic-secret");
    expect(result.output).not.toContain("synthetic-remedy");
  });

  it("preserves structured write outcomes and redacts registered values", () => {
    registerSecret("synthetic-error-credential");
    const result = formatError(new WriteExecutionError(
      new AxiError("failed with synthetic-error-credential", "API_ERROR"),
      { status: "unknown", operation: { password: "synthetic-password" } },
      ["Verify synthetic-error-credential"],
    ));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("status: unknown");
    expect(result.output).toContain("help[1]:");
    expect(result.output).not.toContain("synthetic-error-credential");
    expect(result.output).not.toContain("synthetic-password");
  });
});
