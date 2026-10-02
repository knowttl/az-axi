import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RequestClass } from "./policy.js";

/** Environment override for the write log location. */
export const WRITE_LOG_ENV = "AZ_AXI_WRITE_LOG";

/**
 * One executed write, successful or not. Exactly the fields in PLAN.md
 * Section 6.13.7: never request or response bodies, never headers. The type
 * has no body or header field, so callers cannot log them by accident.
 */
export interface WriteLogEntry {
  /** ISO-8601 timestamp of when the write completed. */
  time: string;
  /** Profile the write ran under. */
  profile: string;
  /** Identity the write ran as (for example the signed-in account). */
  identity: string;
  /** Request classification from `policy.ts`. */
  class: RequestClass;
  /** HTTP method, for example `PATCH`. */
  method: string;
  /** Full request URL, including the `api-version` query. */
  url: string;
  /** `x-ms-request-id` of the final response, when there was one. */
  requestId?: string;
  /** `x-ms-correlation-request-id` of the final response, when present. */
  correlationId?: string;
  /** Final HTTP status. */
  httpStatus: number;
  /** `success`, or the error code when the write failed. */
  outcome: string;
}

/** What the caller supplies; `time` defaults to now when omitted. */
export type WriteLogInput = Omit<WriteLogEntry, "time"> & { time?: string };

/**
 * Where executed writes are recorded: `$AZ_AXI_WRITE_LOG` when set,
 * otherwise `~/.az-axi/writes.log`. Built with `homedir` and `join`, so it
 * is Windows-safe. A blank override falls back to the default.
 */
export function resolveWriteLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[WRITE_LOG_ENV]?.trim();
  if (override) return override;
  return join(homedir(), ".az-axi", "writes.log");
}

/**
 * Appends one JSON Lines entry to the write log, creating the directory and
 * the file (user-only permissions where the OS supports them) when missing.
 * For executed writes only: dry runs never call this. Filesystem errors
 * propagate so the caller (the execute step) decides how to report them.
 */
export function appendWriteLog(input: WriteLogInput, file: string = resolveWriteLogPath()): void {
  // Listed fields only: anything else on `input` (a body, headers) is dropped here.
  const entry: WriteLogEntry = {
    time: input.time ?? new Date().toISOString(),
    profile: input.profile,
    identity: input.identity,
    class: input.class,
    method: input.method,
    url: input.url,
    requestId: input.requestId,
    correlationId: input.correlationId,
    httpStatus: input.httpStatus,
    outcome: input.outcome,
  };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}
