import { randomUUID } from "node:crypto";
import { AxiError } from "axi-sdk-js";
import { resolveCredential } from "./auth.js";
import { tokenEnvFor, type Resource, type ResolvedProfile } from "./config.js";
import { enforceGates } from "./gates.js";
import { assertReadOnlyBoundary, classifyRequest } from "./policy.js";
import { assertEffectAllows } from "./registry.js";
import { REDACTED } from "./redact.js";
import { packageInfo } from "./version.js";

export type { Resource } from "./config.js";

export interface RequestOptions {
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
const DEFAULT_RETRY_MS = 1_000;
const DEFAULT_MAX_PAGES = 10;

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
  const resource = options.resource ?? "arm";
  const method = (options.method ?? "GET").toUpperCase();
  const url = buildUrl(options);
  const shape = { resource, method, path: new URL(url).pathname };
  const cls = classifyRequest(shape);
  assertReadOnlyBoundary(shape, cls);
  assertEffectAllows(cls);
  enforceGates(profile, shape, cls);

  const credential = await resolveCredential(profile, resource);
  const token = credential.header.replace(/^Bearer /, "");
  const scrub = (text: string) => (token ? text.split(token).join(REDACTED) : text);

  let body: string | undefined;
  if (options.body !== undefined) {
    body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  }

  for (let attempt = 0; ; attempt++) {
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
      response = await fetch(url, { method, headers, body });
    } catch (err) {
      throw networkError(err, resource, clientRequestId, scrub);
    }

    const retryMs = retryDelayMs(response.headers.get("retry-after"));
    if (attempt === 0 && (response.status === 429 || response.status === 503) && retryMs <= MAX_RETRY_AFTER_MS) {
      await response.arrayBuffer();
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      continue;
    }

    const text = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });
    const requestId = responseHeaders["x-ms-request-id"];
    const correlationId = responseHeaders["x-ms-correlation-request-id"];
    if (!response.ok) {
      throw translateError({
        status: response.status,
        headers: responseHeaders,
        text: scrub(text),
        profile,
        resource,
        path: new URL(url).pathname,
        requestId: requestId ?? clientRequestId,
      });
    }
    return {
      status: response.status,
      headers: responseHeaders,
      body: (options.raw ? text : parseBody(text)) as T,
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
  value?: T[];
  nextLink?: string;
}

/** First page of a list response. */
export async function requestList<T>(profile: ResolvedProfile, options: RequestOptions): Promise<T[]> {
  return (await request<ListResponse<T>>(profile, options))?.value ?? [];
}

/**
 * Follows `nextLink` for up to `maxPages` pages. `nextLink` is set on the result when
 * the cap stopped paging early, so callers can say the list is incomplete.
 */
export async function requestAll<T>(
  profile: ResolvedProfile,
  options: RequestOptions,
  maxPages = DEFAULT_MAX_PAGES,
): Promise<{ items: T[]; nextLink?: string }> {
  const items: T[] = [];
  let page = options;
  for (let i = 0; i < maxPages; i++) {
    const body = await request<ListResponse<T>>(profile, page);
    items.push(...(body?.value ?? []));
    if (!body?.nextLink) return { items };
    page = { method: options.method, resource: options.resource, path: body.nextLink };
  }
  return { items, nextLink: page.path };
}

function parseBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Seconds or an HTTP date; a missing header means a short default wait. */
function retryDelayMs(header: string | null): number {
  if (!header) return DEFAULT_RETRY_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? DEFAULT_RETRY_MS : Math.max(0, at - Date.now());
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

function translateError(ctx: ErrorContext): AxiError {
  const { status, headers, profile, resource, path } = ctx;
  let message = ctx.text.slice(0, 400);
  let armCode: string | undefined;
  try {
    const parsed = JSON.parse(ctx.text) as { error?: { code?: string; message?: string }; message?: string };
    armCode = parsed.error?.code;
    message = (parsed.error?.message ?? parsed.message ?? message).slice(0, 400);
  } catch {
    /* empty or non-JSON bodies keep the raw text */
  }
  const trace = `requestId: ${ctx.requestId}`;
  const fail = (text: string, code: string, hints: string[]) => new AxiError(text, code, [...hints, trace]);

  if (status === 401) {
    const claims = /claims=/i.test(headers["www-authenticate"] ?? "");
    return fail(`not authorized for ${resource} (profile '${profile.name}')`, "AUTH_REQUIRED", [
      profile.auth === "token"
        ? `The token in $${tokenEnvFor(profile, resource)} is missing, expired, or for the wrong audience (needs ${RESOURCE_URL[resource]})`
        : claims
          ? `Run \`az logout\` then \`az login${profile.tenant ? ` --tenant ${profile.tenant}` : ""}\` to satisfy Conditional Access`
          : "Run `az login` - the Azure CLI token was rejected or expired",
      "Run `az-axi doctor` to verify authentication for this profile",
    ]);
  }
  if (status === 403) {
    return fail(`access denied: ${message}`, "FORBIDDEN", [
      resource === "arm"
        ? "The identity is signed in but RBAC denies this: Reader and Security Reader are needed at the management group or subscription scope"
        : resource === "logs"
          ? "Log Analytics Reader is needed on the workspace"
          : "The identity lacks the Microsoft Graph permission for this lookup",
      ...(armCode ? [`error code: ${armCode}`] : []),
    ]);
  }
  if (status === 404) {
    return fail(`not found: ${path}${armCode ? ` (${armCode})` : ""}`, "NOT_FOUND", [
      message,
      armCode === "SubscriptionNotFound"
        ? "Run `az-axi sub list` to see subscriptions visible to this identity"
        : "Check the subscription, resource group, resource name and api-version",
    ]);
  }
  if (status === 400) {
    return fail(message || "bad request", "VALIDATION_ERROR", [
      armCode === "InvalidQuery"
        ? "The KQL query is invalid: fix its syntax"
        : armCode === "InvalidApiVersionParameter" || armCode === "NoRegisteredProviderFound"
          ? "The api-version is not supported for this resource type: pass a different --api-version"
          : "Check the flag values and the request body",
      ...(armCode ? [`error code: ${armCode}`] : []),
    ]);
  }
  if (status === 409) {
    return fail(message || "conflict", "CONFLICT", [
      "The resource changed concurrently or the request conflicts with its current state",
      "Re-read the resource before retrying",
    ]);
  }
  if (status === 412) {
    return fail(message || "precondition failed", "PRECONDITION_FAILED", [
      "The resource changed since you read it (If-Match did not match): re-read it and retry",
    ]);
  }
  if (status === 429) {
    const quota = headers["x-ms-user-quota-resets-after"];
    return fail(`rate limited by ${HOSTS[resource]}`, "RATE_LIMITED", [
      `Retry after ${headers["retry-after"] ?? "a few"} seconds`,
      ...(quota ? [`Resource Graph quota resets after ${quota}`] : []),
      "Narrow the query with --limit or more filters",
    ]);
  }
  return fail(message || `HTTP ${status}`, "API_ERROR", [
    `HTTP ${status} from ${path}${armCode ? ` (${armCode})` : ""}`,
  ]);
}
