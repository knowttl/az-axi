import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import { redact } from "./redact.js";

/** Structured write outcome carried alongside the standard error contract. */
export class WriteExecutionError extends AxiError {
  constructor(error: AxiError, readonly output: Record<string, unknown>, help: string[]) {
    super(error.message, error.code, [...error.suggestions, ...help]);
  }
}

const USAGE_CODES = new Set([
  "VALIDATION_ERROR", "UNKNOWN_FLAG", "AUTH_REQUIRED", "NOT_FOUND", "FORBIDDEN",
  "READ_ONLY", "WRITES_DISABLED", "SUBSCRIPTION_NOT_WRITABLE", "CONFIRM_REQUIRED", "CONFIRM_MISMATCH",
]);

/** Both entry points redact structured and unexpected failures before encoding. */
export function formatError(error: unknown): { output: string; exitCode: number } {
  const out: Record<string, unknown> = error instanceof AxiError
    ? { error: error.message, code: error.code, ...(error instanceof WriteExecutionError ? error.output : {}) }
    : { error: error instanceof Error ? error.message : String(error), code: "UNKNOWN" };
  if (error instanceof AxiError && error.suggestions.length > 0) out.help = error.suggestions;
  return {
    output: `${encode(redact(out))}\n`,
    exitCode: error instanceof AxiError && USAGE_CODES.has(error.code) ? 2 : 1,
  };
}
