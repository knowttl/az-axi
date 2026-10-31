import { randomUUID } from "node:crypto";
import type { NativeListBudget } from "./nativePaging.js";
import { setTimeout as delay } from "node:timers/promises";
import { AxiError } from "axi-sdk-js";
import { KqlError, type KqlDiagnostic } from "./errors.js";
import { resolveCredential } from "./auth.js";
import { tokenEnvFor, type Resource, type ResolvedProfile } from "./config.js";
import { enforceGates, type GateOptions } from "./gates.js";
import { assertReadOnlyBoundary, classifyRequest } from "./policy.js";
import { assertEffectAllows } from "./registry.js";
import { workspaceCustomerIdCommand } from "./queries.js";
import { REDACTED } from "./redact.js";
import { packageInfo } from "./version.js";
import { formatFlagValue, quoteFlagValue } from "./shell.js";

export type { Resource } from "./config.js";
export { requestStorageMetadata } from "./storageMetadata.js";
export { requestKeyVaultMetadata } from "./keyvaultMetadata.js";
export type { KeyVaultKind, KeyVaultPage, KeyVaultRead } from "./keyvaultMetadata.js";
export { requestAcrMetadata } from "./acrMetadata.js";

export interface RequestOptions extends GateOptions {
  method?: string;
  /** Host to talk to. Defaults to `arm`. */
  resource?: Resource;
  /** Path from the host root (`/subscriptions`), or an absolute URL on the resource's own host (a `nextLink`). */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Required for `arm` unless the path or `query` already carries `api-version`. Never added for logs or graph. */
  apiVersion?: string;
  ifMatch?: string;
  accept?: string;
  /** Return the response text instead of parsed JSON. */
  raw?: boolean;
  signal?: AbortSignal;
}

export interface ApiResponse<T> {
  status: number;
  /** Header names are lower-cased. */
  headers: Record<string, string>;
  body: T;
  /** `x-ms-request-id`: quote it when tracing a call in Azure. */
  requestId?: string;
  correlationId?: string;
  /** The `x-ms-client-request-id` this client sent on the final attempt. */
  clientRequestId: string;
}

/** Failure metadata for the write audit, without response bodies or headers. */
export class ApiRequestError extends AxiError {
  constructor(error: AxiError, readonly httpStatus: number, readonly requestId?: string, readonly correlationId?: string) {
    super(error.message, error.code, error.suggestions);
    this.cause = error;
  }
}

const HOSTS: Record<Resource, string> = {
  arm: "management.azure.com",
  logs: "api.loganalytics.io",
  graph: "graph.microsoft.com",
};

const RESOURCE_URL: Record<Resource, string> = {
  arm: "https://management.azure.com/",
  logs: "https://api.loganalytics.io",
  graph: "https://graph.microsoft.com",
};

const TLS_ERROR_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

const MAX_RETRY_AFTER_MS = 10_000;
const DEFAULT_MAX_PAGES = 10;
const PRE_SEND_ERROR_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT", ...TLS_ERROR_CODES]);
const TRANSIENT_READ_ERROR_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT"]);

function transportCode(err: unknown): string | undefined {
  return (err as { cause?: { code?: string }; code?: string })?.cause?.code ?? (err as { code?: string })?.code;
}

export function buildUrl(options: RequestOptions): string {
  const resource = options.resource ?? "arm";
  const host = HOSTS[resource];
  let url: URL;
  try {
    url = /^[a-z][a-z0-9+.-]*:\/\//i.test(options.path)
      ? new URL(options.path)
      : new URL(`https://${host}/${options.path.replace(/^\/+/, "")}`);
  } catch {
    throw new AxiError(`invalid request path '${options.path}'`, "VALIDATION_ERROR", [
      "Pass a path from the host root, for example /subscriptions",
    ]);
  }
  // The bearer token must only ever go to the host it was minted for.
  if (url.protocol !== "https:" || url.host !== host) {
    throw new AxiError(`refusing to send a ${resource} token to '${url.host}'`, "VALIDATION_ERROR", [
      `Requests for --resource ${resource} must target https://${host}`,
    ]);
  }
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  if (resource === "arm" && !url.searchParams.has("api-version")) {
    if (!options.apiVersion) {
      throw new AxiError(`missing api-version for ${url.pathname}`, "VALIDATION_ERROR", [
        "Pass --api-version <version> (Azure Resource Manager requires one on every request)",
        "List supported versions with `az provider show --namespace <Provider> --query \"resourceTypes[].apiVersions\"`",
      ]);
    }
    url.searchParams.set("api-version", options.apiVersion);
  }
  return url.toString();
}

/** Sends one request through policy, gates and the token, returning status, headers and body. */
export async function sendRequest<T = unknown>(
  profile: ResolvedProfile,
  options: RequestOptions,
): Promise<ApiResponse<T>> {
  options.signal?.throwIfAborted();
  const resource = options.resource ?? "arm";
  const method = (options.method ?? "GET").toUpperCase();
  const url = buildUrl(options);
  const shape = { resource, method, path: new URL(url).pathname };
  const cls = classifyRequest(shape);
  const isWrite = cls !== "read" && cls !== "query";
  assertReadOnlyBoundary(shape, cls);
  assertEffectAllows(cls);
  const execute = enforceGates(profile, shape, cls, options);
  if ((cls === "write" || cls === "destructive") && !execute) {
    throw new AxiError("write request requires explicit execution", "API_ERROR", [
      "Run `az-axi api` without --execute to review the dry run",
    ]);
  }

  const credential = await resolveCredential(profile, resource, options.signal);
  const token = credential.header.replace(/^Bearer /, "");
  const scrub = (text: string) => (token ? text.split(token).join(REDACTED) : text);
  const unknownOutcome = (requestId: string): AxiError => {
    const target = new URL(url);
    if (method === "POST") target.pathname = target.pathname.replace(/\/[^/]+\/?$/, "");
    const command = `az-axi api GET ${quoteFlagValue(target.toString())}` +
      (resource !== "arm" ? ` ${formatFlagValue("resource", resource)}` : "") +
      (profile.configPath ? ` ${formatFlagValue("config", profile.configPath)} ${formatFlagValue("profile", profile.name)}` : "") +
      (profile.tenant ? ` ${formatFlagValue("tenant", profile.tenant)}` : "");
    return new AxiError(scrub(`unknown outcome for ${method} ${shape.path}`), "UNKNOWN_OUTCOME", [
      "The request may have reached the service and changed the resource; it was not retried",
      scrub(`Check current state before trying again: \`${command}\``),
      `requestId: ${requestId}`,
    ]);
  };

  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
  }

  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    const clientRequestId = randomUUID();
    const headers: Record<string, string> = {
      Authorization: credential.header,
      Accept: options.accept ?? "application/json",
      "User-Agent": `az-axi/${packageInfo().version}`,
      "x-ms-client-request-id": clientRequestId,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (options.ifMatch) headers["If-Match"] = options.ifMatch;

    let response: Response;
    try {
      response = await fetch(url, { method, headers, body, signal: options.signal });
    } catch (err) {
      const code = transportCode(err);
      if (isWrite && !PRE_SEND_ERROR_CODES.has(code ?? "")) {
        throw new ApiRequestError(unknownOutcome(clientRequestId), 0, clientRequestId);
      }
      options.signal?.throwIfAborted();
      if (!isWrite && attempt === 0 && TRANSIENT_READ_ERROR_CODES.has(code ?? "")) continue;
      throw new ApiRequestError(networkError(err, resource, clientRequestId, scrub), 0, clientRequestId);
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });
    const requestId = responseHeaders["x-ms-request-id"];
    const correlationId = responseHeaders["x-ms-correlation-request-id"];
    const retryMs = retryDelayMs(response.headers.get("retry-after"));
    const retry = !isWrite && attempt === 0 && (response.status === 429 || response.status === 503) &&
      retryMs !== undefined && retryMs <= MAX_RETRY_AFTER_MS;
    let text = "";
    try {
      if (retry) await response.arrayBuffer();
      else text = await response.text();
    } catch (err) {
      if (!isWrite) {
        options.signal?.throwIfAborted();
        if (attempt === 0 && TRANSIENT_READ_ERROR_CODES.has(transportCode(err) ?? "")) continue;
      }
      throw new ApiRequestError(isWrite && (response.ok || response.status >= 500 || response.status === 408)
        ? unknownOutcome(requestId ?? clientRequestId) : networkError(err, resource, clientRequestId, scrub), response.status,
        requestId ?? clientRequestId, correlationId);
    }
    if (retry) {
      if (options.signal) await delay(retryMs, undefined, { signal: options.signal });
      else await new Promise((resolve) => setTimeout(resolve, retryMs));
      continue;
    }
    if (!response.ok) {
      if (isWrite && (response.status >= 500 || response.status === 408)) {
        throw new ApiRequestError(unknownOutcome(requestId ?? clientRequestId), response.status,
          requestId ?? clientRequestId, correlationId);
      }
      throw new ApiRequestError(translateError({
        status: response.status,
        headers: responseHeaders,
        text: scrub(text),
        profile,
        resource,
        path: new URL(url).pathname,
        requestId: requestId ?? clientRequestId,
      }), response.status, requestId ?? clientRequestId, correlationId);
    }
    let parsedBody: unknown;
    try {
      parsedBody = options.raw ? text : parseBody(text);
    } catch (error) {
      if (!(error instanceof AxiError)) throw error;
      throw new ApiRequestError(error, response.status, requestId ?? clientRequestId, correlationId);
    }
    return {
      status: response.status,
      headers: responseHeaders,
      body: parsedBody as T,
      requestId,
      correlationId,
      clientRequestId,
    };
  }
}

/** Convenience for read commands: the response body only. */
export async function request<T = unknown>(profile: ResolvedProfile, options: RequestOptions): Promise<T> {
  return (await sendRequest<T>(profile, options)).body;
}

export interface ListResponse<T> {
  value: T[];
  nextLink?: string;
}

/** First page of a list response. */
export async function requestList<T>(profile: ResolvedProfile, options: RequestOptions): Promise<T[]> {
  return (await requestListPage<T>(profile, options)).value;
}

async function requestListPage<T>(profile: ResolvedProfile, options: RequestOptions): Promise<ListResponse<T>> {
  const body = await request<ListResponse<T>>(profile, options);
  if (!body || !Array.isArray(body.value)) {
    throw new AxiError("invalid list response: expected a value array", "API_ERROR", [
      "Check API compatibility and any proxy or sign-in page intercepting the response",
    ]);
  }
  return body;
}

/**
 * Follows nextLink within a page cap and, for native lists, a row budget.
 * Incomplete results may expose a nextLink only after consuming the entire page.
 */
export async function requestAll<T>(
  profile: ResolvedProfile,
  options: RequestOptions,
  budget: number | NativeListBudget = DEFAULT_MAX_PAGES,
): Promise<{ items: T[]; nextLink?: string; incomplete?: boolean }> {
  const maxPages = typeof budget === "number" ? budget : budget.maxPages;
  const maxRows = typeof budget === "number" ? Infinity : budget.maxRows;
  const items: T[] = [];
  let page = options;
  for (let i = 0; i < maxPages; i++) {
    const body = await requestListPage<T>(profile, page);
    const rows = body.value;
    const remaining = maxRows - items.length;
    items.push(...rows.slice(0, remaining));
    // A next-page link would skip the unconsumed tail of this page.
    if (rows.length > remaining) return { items, incomplete: true };
    if (!body?.nextLink) return { items };
    page = { method: options.method, resource: options.resource, path: body.nextLink };
    if (items.length === maxRows) return { items, nextLink: page.path, incomplete: true };
  }
  return { items, nextLink: page.path, ...(typeof budget === "number" ? {} : { incomplete: true }) };
}

function parseBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new AxiError("response is not valid JSON", "API_ERROR", [
      "Check API compatibility and any proxy or sign-in page intercepting the response",
    ]);
  }
}

/** Seconds or an HTTP date. Absent or unparseable means do not retry. */
function retryDelayMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}

function networkError(
  err: unknown,
  resource: Resource,
  clientRequestId: string,
  scrub: (text: string) => string,
): AxiError {
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code ?? (err as { code?: string }).code;
  if (code && TLS_ERROR_CODES.has(code)) {
    return new AxiError(`TLS certificate verification failed contacting ${HOSTS[resource]}`, "TLS_ERROR", [
      "A TLS-inspecting proxy is likely re-signing traffic",
      "Set NODE_EXTRA_CA_CERTS to the path of your organization's root CA (PEM)",
      "Run `az-axi doctor` to re-check",
      `clientRequestId: ${clientRequestId}`,
    ]);
  }
  return new AxiError(`network error contacting ${HOSTS[resource]}`, "NETWORK_ERROR", [
    `Check connectivity to https://${HOSTS[resource]}`,
    scrub(cause?.message ?? (err as Error).message),
    "Run `az-axi doctor` to verify the profile",
    `clientRequestId: ${clientRequestId}`,
  ]);
}

interface ErrorContext {
  status: number;
  headers: Record<string, string>;
  text: string;
  profile: ResolvedProfile;
  resource: Resource;
  path: string;
  requestId: string;
}

interface ApiErrorNode {
  code?: string;
  message?: string;
  innererror?: ApiErrorNode;
  line?: number;
  pos?: number;
  token?: string;
}

const AUTH_ERROR_CODES = new Set([
  "authenticationfailed",
  "expiredauthenticationtoken",
  "invalidauthenticationtoken",
  "invalidauthenticationtokenaudience",
]);

/** Outer code for classification; deepest message, because Log Analytics hides syntax errors in `innererror`. */
function readApiError(text: string): { code?: string; message?: string; innerCode?: string; diagnostics?: KqlDiagnostic[] } {
  try {
    const parsed = JSON.parse(text) as { error?: ApiErrorNode; message?: string };
    const root = parsed.error;
    let message = root?.message ?? parsed.message;
    let innerCode: string | undefined;
    let current = root;
    const seen = new Set<ApiErrorNode>();
    const diagnostics: KqlDiagnostic[] = [];
    while (current?.innererror && typeof current.innererror === "object" && !seen.has(current)) {
      seen.add(current);
      current = current.innererror;
      if (current.code) innerCode = current.code;
      if (current.message?.trim()) message = current.message;
      if (Number.isInteger(current.line) && current.line! > 0 && Number.isInteger(current.pos) && current.pos! > 0) {
        diagnostics.push({ line: current.line!, column: current.pos!, code: current.code ?? "", token: current.token ?? "", message: current.message ?? "" });
      }
    }
    return { code: root?.code, message, innerCode, diagnostics: diagnostics.slice(0, 5) };
  } catch {
    return {};
  }
}

function isAuthFailure(status: number, code: string | undefined): boolean {
  if (status === 401) return true;
  return status === 403 && AUTH_ERROR_CODES.has((code ?? "").toLowerCase());
}

function translateError(ctx: ErrorContext): AxiError {
  const { status, headers, profile, resource, path } = ctx;
  const parsedError = readApiError(ctx.text);
  const armCode = parsedError.code;
  const innerCode = parsedError.innerCode;
  const message = (parsedError.message ?? ctx.text).slice(0, 400);
  const trace = `requestId: ${ctx.requestId}`;
  const fail = (text: string, code: string, hints: string[]) => new AxiError(text, code, [...hints, trace]);
  const codes = [
    ...(armCode ? [`error code: ${armCode}`] : []),
    ...(innerCode && innerCode !== armCode ? [`inner error: ${innerCode}`] : []),
  ];

  if (isAuthFailure(status, armCode)) {
    const claims = /claims=/i.test(headers["www-authenticate"] ?? "");
    return fail(`not authorized for ${resource} (profile '${profile.name}')`, "AUTH_REQUIRED", [
      profile.auth === "token"
        ? `The token in $${tokenEnvFor(profile, resource)} is missing, expired, or for the wrong audience (needs ${RESOURCE_URL[resource]})`
        : claims
          ? `Run \`az logout\` then \`az login${profile.tenant ? ` --tenant ${profile.tenant}` : ""}\` to satisfy Conditional Access`
          : "Run `az login` - the Azure CLI token was rejected or expired",
      "Run `az-axi doctor` to verify authentication for this profile",
      ...codes,
    ]);
  }
  if (status === 403) {
    return fail(`access denied: ${message}`, "FORBIDDEN", [
      resource === "arm"
        ? "The identity is signed in but RBAC denies this: Reader and Security Reader are needed at the management group or subscription scope"
        : resource === "logs"
          ? "Log Analytics Reader is needed on the workspace"
          : "The identity lacks the Microsoft Graph permission for this lookup",
      ...codes,
    ]);
  }
  if (status === 404) {
    return fail(`not found: ${path}${armCode ? ` (${armCode})` : ""}`, "NOT_FOUND", [
      message,
      resource === "logs"
        ? `Check the workspace ID GUID (customer ID), not the ARM resource ID. Find it with \`${workspaceCustomerIdCommand()}\``
        : armCode === "SubscriptionNotFound"
          ? "Run `az-axi sub list` to see subscriptions visible to this identity"
          : "Check the subscription, resource group, resource name and api-version",
    ]);
  }
  if (status === 400) {
    const kqlQuery = (resource === "logs" && path.endsWith("/query")) || path.toLowerCase() === "/providers/microsoft.resourcegraph/resources";
    if (kqlQuery) {
      const syntax = /syntax/i.test(innerCode ?? armCode ?? "");
      return new KqlError(`The server rejected the query (${syntax ? "syntax" : "semantic"} error): ${message || "bad request"}`,
        parsedError.diagnostics ?? [], [
          "Offline KQL parsing does not check tables, columns, workspace functions, permissions or service-specific restrictions; check these and request options, then retry",
          ...codes, trace,
        ]);
    }
    return fail(message || "bad request", "VALIDATION_ERROR", [
      resource === "logs"
        ? "The KQL query or --timespan was rejected: fix the syntax and retry"
        : armCode === "InvalidQuery"
          ? "The KQL query is invalid: fix its syntax"
          : armCode === "NoRegisteredProviderFound"
            ? "Check the supported locations and API versions in the Azure error above; for security alerts, select a supported --location"
            : armCode === "InvalidApiVersionParameter"
              ? "The api-version is not supported for this resource type; use a supported version with `az-axi api GET <path> --api-version <version>`"
              : "Check the flag values and the request body",
      ...codes,
    ]);
  }
  if (status === 409) {
    if (armCode === "MissingSubscriptionRegistration") {
      return fail(message, "PROVIDER_NOT_REGISTERED", [
        "Ask the subscription owner to register the provider namespace named in the Azure error, then retry",
        "az-axi does not register resource providers",
        ...codes,
      ]);
    }
    return fail(message || "conflict", "CONFLICT", [
      "The resource changed concurrently or the request conflicts with its current state",
      "Re-read the resource before retrying",
    ]);
  }
  if (status === 412) {
    return fail(message || "precondition failed", "PRECONDITION_FAILED", [
      "The resource changed since the dry run (If-Match did not match): re-run the dry run before retrying",
    ]);
  }
  if (status === 429 || status === 503) {
    const quota = headers["x-ms-user-quota-resets-after"];
    return fail(`rate limited by ${HOSTS[resource]}`, "RATE_LIMITED", [
      `Retry after ${headers["retry-after"] ?? "a few"} seconds`,
      ...(resource === "arm" && quota ? [`Resource Graph quota resets after ${quota}`] : []),
      resource === "logs"
        ? "Narrow the KQL with '| take' or '| summarize', or shorten --timespan, then retry. --limit only hides rows already returned"
        : "Narrow the query with --limit or more filters",
      ...codes,
    ]);
  }
  if (status === 504) {
    return fail(message || "the request timed out", "API_ERROR", [
      resource === "logs"
        ? "The query exceeded the Log Analytics timeout (3 minutes by default): shorten --timespan or narrow the KQL and retry"
        : "The request timed out; retry or narrow it",
      ...codes,
    ]);
  }
  return fail(message || `HTTP ${status}`, "API_ERROR", [
    `HTTP ${status} from ${path}${armCode ? ` (${armCode})` : ""}`,
    ...codes,
  ]);
}
