import { AxiError } from "axi-sdk-js";
import { sendRequest, type ApiResponse } from "./client.js";
import type { ResolvedProfile } from "./config.js";

/**
 * Long-running operation polling (PLAN.md Section 6.13.5).
 * Intended for the future `api` execute flow after a 201/202 write response
 * carries an `Azure-AsyncOperation` or `Location` header; `op status` reuses
 * the response reading for its single read-only GET. Every poll is a GET through `client.ts`,
 * so policy, gates and correlation apply unchanged.
 *
 * Reference: Track asynchronous Azure operations
 * (https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/async-operations).
 */

/** The only host operation URLs may point at. */
export const LRO_HOST = "management.azure.com";

/** `Retry-After` fallback between polls. */
export const DEFAULT_RETRY_AFTER_MS = 10_000;

/** `--timeout` default: how long a poll may run before it reports OPERATION_TIMEOUT. */
export const DEFAULT_TIMEOUT_MS = 600_000;

export interface LroUrls {
  asyncOperationUrl?: string;
  locationUrl?: string;
  retryAfter?: string;
}

export interface LroPollOptions {
  /** Total poll budget. Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Clock, so tests can use fake timers. Defaults to Date.now. */
  now?: () => number;
  /** Wait between polls. Defaults to a setTimeout promise. */
  delay?: (ms: number) => Promise<void>;
}

export interface OperationState {
  /** The reported status (`Succeeded`, `InProgress`, ...), or the synthesized one below. */
  state: string;
  /** True while the operation has not reached a terminal status. */
  running: boolean;
  /** True for terminal `Failed` or `Canceled`. */
  failed: boolean;
  code?: string;
  message?: string;
}

const TERMINAL_SUCCESS = "SUCCEEDED";
const TERMINAL_FAILURE = new Set(["FAILED", "CANCELED"]);

export function opStatusCommand(url: string, profile: ResolvedProfile): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `az-axi op status ${quote(url)}` +
    (profile.configPath ? ` --config ${quote(profile.configPath)} --profile ${quote(profile.name)}` : "") +
    (profile.tenant ? ` --tenant ${quote(profile.tenant)}` : "");
}

/** Only absolute https URLs on the ARM host may be polled or inspected. */
export function assertOperationUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AxiError(`invalid operation URL '${value}'`, "VALIDATION_ERROR", [
      "Pass the absolute operation URL from the write response",
      "Example: `az-axi op status 'https://management.azure.com/<operation-path>?api-version=<v>'`",
    ]);
  }
  if (url.protocol !== "https:" || url.host !== LRO_HOST) {
    throw new AxiError(`refusing to poll '${url.host || value}'`, "VALIDATION_ERROR", [
      `Operation URLs must be absolute https URLs on ${LRO_HOST}`,
      "Pass the Azure-AsyncOperation or Location URL from the write response",
    ]);
  }
  return url.toString();
}

/** `--timeout` in seconds to milliseconds. */
export function parseTimeoutFlag(value: string | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  const ms = Number(value) * 1000;
  if (!value.trim() || !Number.isFinite(ms) || !(ms > 0)) {
    throw new AxiError(`invalid --timeout '${value}'`, "VALIDATION_ERROR", [
      "Use positive numeric seconds like --timeout 600",
    ]);
  }
  return ms;
}

/** Preserves operation URLs and initial `Retry-After` scheduling from a write response. */
export function operationUrls(response: ApiResponse<unknown>): LroUrls {
  const asyncOperationUrl = response.headers["azure-asyncoperation"];
  const locationUrl = response.headers["location"];
  return {
    ...(asyncOperationUrl ? { asyncOperationUrl } : {}),
    ...(locationUrl ? { locationUrl } : {}),
    ...(response.headers["retry-after"] !== undefined ? { retryAfter: response.headers["retry-after"] } : {}),
  };
}

function errorDetail(body: unknown): { code?: string; message?: string } {
  if (body === null || typeof body !== "object" || Object.getPrototypeOf(body) !== Object.prototype) {
    return {};
  }
  const error = (body as Record<string, unknown>).error;
  if (error === null || typeof error !== "object" || Object.getPrototypeOf(error) !== Object.prototype) {
    return {};
  }
  const detail = error as Record<string, unknown>;
  return {
    ...(typeof detail.code === "string" ? { code: detail.code } : {}),
    ...(typeof detail.message === "string" ? { message: detail.message } : {}),
  };
}

/**
 * Reads one operation response. A body `status` decides, preferring the
 * `Azure-AsyncOperation` shape; without one, HTTP 202 means still running and
 * any other status means the `Location` target is done.
 */
export function describeOperation(response: ApiResponse<unknown>): OperationState {
  const body =
    response.body !== null &&
    typeof response.body === "object" &&
    Object.getPrototypeOf(response.body) === Object.prototype
      ? (response.body as Record<string, unknown>)
      : undefined;
  const reported = typeof body?.status === "string" ? body.status : undefined;
  if (reported !== undefined) {
    const upper = reported.toUpperCase();
    return {
      state: reported,
      running: upper !== TERMINAL_SUCCESS && !TERMINAL_FAILURE.has(upper),
      failed: TERMINAL_FAILURE.has(upper),
      ...errorDetail(response.body),
    };
  }
  if (response.status === 202) return { state: "InProgress", running: true, failed: false };
  return { state: "Succeeded", running: false, failed: false };
}

/** Seconds, or an HTTP date. Absent or unparseable means the default. */
function retryAfterMs(headers: Record<string, string>, now: () => number): number {
  const raw = headers["retry-after"];
  if (raw === undefined) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const at = Date.parse(raw);
  if (!Number.isNaN(at)) return Math.max(0, at - now());
  return DEFAULT_RETRY_AFTER_MS;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls until the operation succeeds, fails, or the timeout elapses.
 * Prefers the `Azure-AsyncOperation` URL; otherwise polls `Location`.
 * A body status takes precedence over HTTP 202 for either URL.
 * Returns the terminal response. Throws OPERATION_FAILED
 * with the operation's error, or OPERATION_TIMEOUT with an `op status` command
 * to check its current state when the budget runs out.
 */
export async function pollOperation(
  profile: ResolvedProfile,
  urls: LroUrls,
  options: LroPollOptions = {},
): Promise<ApiResponse<unknown>> {
  const pollUrl = urls.asyncOperationUrl ?? urls.locationUrl;
  if (!pollUrl) {
    throw new AxiError("no operation URL to poll", "VALIDATION_ERROR", [
      "Pass the Azure-AsyncOperation or Location URL from a 201 or 202 response",
    ]);
  }
  assertOperationUrl(pollUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const delay = options.delay ?? defaultDelay;
  const deadline = now() + timeoutMs;

  let last: ApiResponse<unknown> | undefined;
  const timeout = () => new AxiError(
    `operation did not finish within ${Math.round(timeoutMs / 1000)}s`,
    "OPERATION_TIMEOUT",
    [
      `Resume with \`${opStatusCommand(pollUrl, profile)}\``,
      ...(last?.requestId ? [`requestId: ${last.requestId}`] : []),
    ],
  );
  let waitMs = urls.retryAfter === undefined ? 0 : retryAfterMs({ "retry-after": urls.retryAfter }, now);
  for (;;) {
    if (now() >= deadline) throw timeout();
    if (waitMs > 0) await delay(Math.min(waitMs, deadline - now()));
    if (now() >= deadline) throw timeout();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: ApiResponse<unknown>;
    try {
      response = await Promise.race([
        sendRequest<unknown>(profile, { path: pollUrl, signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = timeout();
            controller.abort(error);
            reject(error);
          }, deadline - now());
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    last = response;
    if (now() >= deadline) throw timeout();
    const state = describeOperation(response);
    if (state.failed) {
      const what = state.code ? `${state.state} (${state.code})` : state.state;
      throw new AxiError(`long-running operation ended as ${what}`, "OPERATION_FAILED", [
        state.message ?? "The operation reported no error message",
        `operation: ${pollUrl}`,
        ...(response.requestId ? [`requestId: ${response.requestId}`] : []),
      ]);
    }
    if (!state.running) return response;
    waitMs = retryAfterMs(response.headers, now);
  }
}
