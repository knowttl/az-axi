import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import { redact, redactText } from "./redact.js";
import { ResponseDiagnostics } from "../response-diagnostics.js";

/** Response-local evidence, retained through the request and write error wrappers. */
export class ResponseInvalidError extends AxiError {
  constructor(error: AxiError, readonly responseDiagnostics: Record<string, unknown>) {
    super(error.message, error.code, error.suggestions);
    this.cause = error;
  }
}

export function responseDiagnostics(response: Response, data?: unknown): ResponseDiagnostics {
  const diagnostics = new ResponseDiagnostics({ text: redactText }, ["API_ERROR", "AUTH_REQUIRED"]);
  diagnostics.record(response.status, response.headers, data);
  return diagnostics;
}

export function responseInvalid(error: unknown, diagnostics: ResponseDiagnostics): unknown {
  return error instanceof AxiError ? new ResponseInvalidError(error, diagnostics.forError(error)) : error;
}

function responseDetails(error: unknown): Record<string, unknown> {
  if (error instanceof ResponseInvalidError) return error.responseDiagnostics;
  if (error instanceof Error && error.cause) return responseDetails(error.cause);
  return {};
}

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
    this.cause = error;
  }
}

const USAGE_CODES = new Set([
  "VALIDATION_ERROR", "UNKNOWN_FLAG", "AUTH_REQUIRED", "NOT_FOUND", "FORBIDDEN",
  "READ_ONLY", "WRITES_DISABLED", "SUBSCRIPTION_NOT_WRITABLE", "CONFIRM_REQUIRED", "CONFIRM_MISMATCH",
]);

/** Both entry points redact structured and unexpected failures before encoding. */
export function formatError(error: unknown): { output: string; exitCode: number } {
  const kql = error instanceof KqlError ? error : error instanceof Error && error.cause instanceof KqlError ? error.cause : undefined;
  const details = responseDetails(error);
  const out: Record<string, unknown> = error instanceof AxiError
    ? { error: error.message, code: error.code, ...details, ...(error instanceof WriteExecutionError ? error.output : {}),
        ...(error instanceof WriteExecutionError && details.status !== undefined ? { responseStatus: details.status } : {}),
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
