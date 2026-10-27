import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import { redact } from "./redact.js";

export interface KqlDiagnostic {
  line: number;
  column: number;
  code: string;
  token: string;
  message: string;
}

export class KqlError extends AxiError {
  constructor(message: string, readonly diagnostics: KqlDiagnostic[], help: string[]) {
    super(message, "VALIDATION_ERROR", help);
  }
}

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
  const kql = error instanceof KqlError ? error : error instanceof Error && error.cause instanceof KqlError ? error.cause : undefined;
  const out: Record<string, unknown> = error instanceof AxiError
    ? { error: error.message, code: error.code, ...(error instanceof WriteExecutionError ? error.output : {}),
        ...(kql?.diagnostics.length ? { diagnostics: kql.diagnostics } : {}) }
    : { error: error instanceof Error ? error.message : String(error), code: "UNKNOWN" };
  if (error instanceof AxiError && error.suggestions.length > 0) out.help = error.suggestions;
  const redacted = redact(out);
  // Diagnostic tokens are KQL text, not credentials; retain value-based secret redaction.
  if (error instanceof AxiError && kql?.diagnostics.length) {
    const diagnostics = redacted.diagnostics as KqlDiagnostic[];
    kql.diagnostics.forEach((diagnostic, index) => { diagnostics[index]!.token = redact(diagnostic.token); });
  }
  return {
    output: `${encode(redacted)}\n`,
    exitCode: error instanceof AxiError && USAGE_CODES.has(error.code) ? 2 : 1,
  };
}
