import { AxiError } from "axi-sdk-js";
import { identityOf } from "./auth.js";
import { ApiRequestError, sendRequest, type ApiResponse } from "./client.js";
import type { ResolvedProfile } from "./config.js";
import { diffResource } from "./diff.js";
import { assertOperationUrl, operationUrls, opStatusCommand, pollOperation } from "./lro.js";
import { shortenResourceId } from "./scope.js";
import { quoteFlagValue } from "./shell.js";
import { appendWriteLog } from "./writeLog.js";

/** Structured write outcome carried alongside the standard error contract. */
export class WriteExecutionError extends AxiError {
  constructor(error: AxiError, readonly output: Record<string, unknown>, help: string[]) {
    super(error.message, error.code, [...error.suggestions, ...help]);
  }
}

/** Execute only after gates 1-5 pass; the client repeats them before sending. */
export async function executeWrite(options: {
  profile: ResolvedProfile;
  method: string;
  path: string;
  cls: "write" | "destructive";
  body: unknown;
  ifMatch?: string;
  confirm?: string;
  selectors: string;
  timeoutMs: number;
  noWait: boolean;
}): Promise<Record<string, unknown>> {
  const { profile, method, path, body } = options;
  const started = Date.now();
  const url = new URL(path);
  const pathname = url.pathname.replace(/\/+$/, "");
  const probePath = method === "POST" ? `${url.origin}${pathname.slice(0, pathname.lastIndexOf("/"))}${url.search}` : path;
  const verifyUrl = new URL(probePath);
  const help = [`Verify with \`az-axi api GET ${quoteFlagValue(verifyUrl.pathname + verifyUrl.search)}${options.selectors ? ` ${options.selectors}` : ""}\``];
  const base = {
    target: shortenResourceId(url.pathname),
    ...(options.ifMatch === undefined ? { protection: "review-to-execute protection was not used" } : {}),
  };
  // Token mode has no account lookup. Do not decode or log the bearer token.
  const identity = profile.auth === "az" ? (await identityOf(profile)).name : "token (identity unavailable)";
  let current: ApiResponse<unknown> | undefined;
  let missing: ApiRequestError | undefined;
  try {
    current = await sendRequest(profile, { path: probePath });
  } catch (error) {
    if (!(error instanceof AxiError) || error.code !== "NOT_FOUND" || (method !== "PUT" && method !== "DELETE")) throw error;
    if (error instanceof ApiRequestError) missing = error;
  }
  const noop = method === "DELETE" ? current === undefined :
    (method === "PUT" || method === "PATCH") && current !== undefined && body !== undefined && diffResource(current.body, body, method).noop;
  if (noop) {
    return { ...base, result: "already in desired state (no-op)", status: current?.status ?? 404,
      requestId: current?.requestId ?? missing?.requestId, correlationId: current?.correlationId ?? missing?.correlationId,
      durationSec: (Date.now() - started) / 1000, help };
  }
  const bodyEtag = current?.body !== null && typeof current?.body === "object" && "etag" in current.body && typeof current.body.etag === "string" ? current.body.etag : undefined;
  const ifMatch = options.ifMatch ?? current?.headers.etag ?? bodyEtag;
  let response: ApiResponse<unknown> | undefined;
  let outcome = "success";
  try {
    response = await sendRequest(profile, { method, path, body, ifMatch, execute: true, confirm: options.confirm });
    const urls = operationUrls(response);
    const operationUrl = urls.asyncOperationUrl ?? urls.locationUrl;
    if ((response.status === 201 || response.status === 202) && operationUrl) {
      assertOperationUrl(operationUrl);
      if (options.noWait) {
        return { ...base, result: "operation accepted", status: response.status, operationUrl,
          requestId: response.requestId, correlationId: response.correlationId,
          durationSec: (Date.now() - started) / 1000,
          help: [opStatusCommand(operationUrl, profile), ...help] };
      }
      await pollOperation(profile, urls, { timeoutMs: options.timeoutMs });
    } else if (response.status === 202) {
      throw new AxiError("write accepted without an operation URL", "API_ERROR", help);
    }
    return { ...base, result: "done", status: response.status, requestId: response.requestId,
      correlationId: response.correlationId, durationSec: (Date.now() - started) / 1000, help };
  } catch (error) {
    outcome = error instanceof AxiError ? error.code : "API_ERROR";
    if (error instanceof ApiRequestError && response === undefined) {
      response = { status: error.httpStatus, requestId: error.requestId, correlationId: error.correlationId,
        headers: {}, body: undefined, clientRequestId: "" };
    }
    const failure = error instanceof AxiError ? error : new AxiError("write execution failed", "API_ERROR", help);
    throw new WriteExecutionError(failure, { ...base, result: "failed", status: response?.status ?? 0,
      requestId: response?.requestId, correlationId: response?.correlationId,
      durationSec: (Date.now() - started) / 1000 }, help);
  } finally {
    try {
      appendWriteLog({ profile: profile.name, identity, class: options.cls, method, url: path,
        requestId: response?.requestId, correlationId: response?.correlationId,
        httpStatus: response?.status ?? 0, outcome });
    } catch {
      throw new WriteExecutionError(new AxiError(`write outcome: ${outcome}; could not append the write log`, "API_ERROR", [
        "Check the write log location and permissions before executing another write",
      ]), { ...base, result: "write log failed", status: response?.status ?? 0,
        requestId: response?.requestId, correlationId: response?.correlationId,
        durationSec: (Date.now() - started) / 1000 }, help);
    }
  }
}
