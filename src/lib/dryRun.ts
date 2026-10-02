import { AxiError } from "axi-sdk-js";
import { MANAGEMENT_LOCKS } from "./apiVersions.js";
import { sendRequest } from "./client.js";
import type { ResolvedProfile, Resource } from "./config.js";
import { diffResource } from "./diff.js";
import { truncate } from "./format.js";
import { subscriptionOfPath, targetResourceName } from "./gates.js";
import { classifyRequest, type RequestClass } from "./policy.js";
import { redact } from "./redact.js";
import { shortenResourceId } from "./scope.js";
import { quoteFlagValue } from "./shell.js";

const BODY_TRUNCATE = 4000;

export interface DryRunRequest {
  profile: ResolvedProfile;
  resource: Resource;
  /** Upper-cased method, as classified. */
  method: string;
  /** Path as passed on the command line (may carry a query string). */
  path: string;
  cls: RequestClass;
  /** Parsed `--body`, or undefined when absent. */
  body: unknown;
  /** Raw `--body` text for the exact execute command. */
  bodyRaw?: string;
  apiVersion?: string;
  /** Parsed `--query` pairs, forwarded to the current-state GET. */
  query?: Record<string, string>;
  /** Raw `--query` text for the exact execute command. */
  queryRaw?: string;
  /** Selector flags echoed into the exact execute command (`--profile`, ...). */
  selectors?: string;
  full?: boolean;
  /** User-passed `--if-match`, echoed when no fresher ETag is read. */
  ifMatch?: string;
}

function barePath(path: string): string {
  return path.split(/[?#]/, 1)[0] ?? "";
}

/** Lower-cased, decoded segments for shape matching. */
function segmentsOf(path: string): string[] {
  return barePath(path)
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment).toLowerCase();
      } catch {
        return segment.toLowerCase();
      }
    });
}

/**
 * PUT to a deployment resource (subscription or resource group scope), which
 * previews through what-if instead of a GET diff. `.../deployments/{name}`
 * exactly; a PUT to the whatIf action itself stays a plain write.
 */
function isDeploymentPut(method: string, path: string): boolean {
  if (method.toUpperCase() !== "PUT") return false;
  const s = segmentsOf(path);
  const subScope =
    s.length === 6 &&
    s[0] === "subscriptions" &&
    s[2] === "providers" &&
    s[3] === "microsoft.resources" &&
    s[4] === "deployments";
  const rgScope =
    s.length === 8 &&
    s[0] === "subscriptions" &&
    s[2] === "resourcegroups" &&
    s[4] === "providers" &&
    s[5] === "microsoft.resources" &&
    s[6] === "deployments";
  return (subScope || rgScope) && s[s.length - 1] !== "whatif";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Redacted body, truncated to a string unless --full. Omitted when absent. */
function shownBody(body: unknown, full: boolean): { body?: unknown } {
  if (body === undefined) return {};
  const redacted = redact(body);
  if (full) return { body: redacted };
  const text = JSON.stringify(redacted);
  if (text.length <= BODY_TRUNCATE) return { body: redacted };
  return { body: truncate(text, BODY_TRUNCATE).text };
}

export function buildExecuteCommand(options: {
  method: string;
  path: string;
  resource: Resource;
  selectors?: string;
  apiVersion?: string;
  queryRaw?: string;
  bodyRaw?: string;
  etag?: string;
  confirmName?: string;
}): string {
  const parts = ["az-axi", "api", options.method, quoteFlagValue(options.path)];
  if (options.selectors) parts.push(options.selectors);
  if (options.resource !== "arm") parts.push(`--resource ${options.resource}`);
  if (options.apiVersion) parts.push(`--api-version ${quoteFlagValue(options.apiVersion)}`);
  if (options.queryRaw) parts.push(`--query ${quoteFlagValue(options.queryRaw)}`);
  if (options.bodyRaw !== undefined) {
    const body = JSON.parse(options.bodyRaw) as unknown;
    const safeBody = JSON.stringify(redact(body)) === JSON.stringify(body) ? options.bodyRaw : "<json-body>";
    parts.push(`--body ${quoteFlagValue(safeBody)}`);
  }
  if (options.etag) parts.push(`--if-match ${quoteFlagValue(options.etag)}`);
  parts.push("--execute");
  if (options.confirmName !== undefined) parts.push(`--confirm ${quoteFlagValue(options.confirmName)}`);
  return `\`${parts.join(" ")}\``;
}

interface Probed {
  current: unknown;
  etag?: string;
}

/** GETs the current state; a missing resource surfaces as NOT_FOUND. */
async function getCurrent(request: DryRunRequest): Promise<Probed> {
  const response = await sendRequest<unknown>(request.profile, {
    method: "GET",
    resource: request.resource,
    path: request.path,
    query: request.query,
    apiVersion: request.apiVersion,
  });
  return { current: response.body, etag: response.headers["etag"] };
}

interface LockHit {
  names: string[];
}

/** Best-effort lock listing for one scope; failures degrade to a hint, never an error. */
async function listLocks(request: DryRunRequest, scopePath: string): Promise<LockHit | { checked: false; code: string }> {
  try {
    const response = await sendRequest<{ value?: Array<{ name?: string }> }>(request.profile, {
      method: "GET",
      resource: request.resource,
      path: `${scopePath}/providers/Microsoft.Authorization/locks`,
      apiVersion: MANAGEMENT_LOCKS,
    });
    const names = (response.body?.value ?? []).map((lock) => lock.name).filter((name): name is string => !!name);
    return { names };
  } catch (err) {
    return { checked: false, code: err instanceof AxiError ? err.code : "API_ERROR" };
  }
}

/**
 * Dry run for a write or destructive request (PLAN.md Section 6.13.3). Sends
 * only reads: the current-state GET, lock listings, and the deployment what-if
 * (a query-class POST). Never sends the write itself.
 */
export async function dryRun(request: DryRunRequest): Promise<Record<string, unknown>> {
  const bare = barePath(request.path);
  const subscription = subscriptionOfPath(request.path) ?? "";
  const base = {
    dryRun: true,
    class: request.cls,
    method: request.method,
    target: shortenResourceId(bare),
    subscription,
    ...shownBody(request.body, request.full ?? false),
  };
  const help: string[] = [];
  const command = (extra: { etag?: string; confirmName?: string }) =>
    buildExecuteCommand({
      method: request.method,
      path: request.path,
      resource: request.resource,
      selectors: request.selectors,
      apiVersion: request.apiVersion,
      queryRaw: request.queryRaw,
      bodyRaw: request.bodyRaw,
      ...extra,
    });

  if (request.method === "PUT" && isDeploymentPut(request.method, request.path)) {
    return dryRunDeployment(request, base, help, command);
  }

  if (request.method === "PUT" || request.method === "PATCH") {
    let probed: Probed;
    try {
      probed = await getCurrent(request);
    } catch (err) {
      // PUT to a resource that does not exist would create it.
      if (request.method === "PUT" && err instanceof AxiError && err.code === "NOT_FOUND") {
        help.push(command({}));
        return { ...base, creates: true, help };
      }
      throw err;
    }
    const out: Record<string, unknown> = { ...base };
    if (probed.etag) out.etag = probed.etag;
    if (request.body === undefined) {
      help.push("Pass --body '<json>' to preview the field-level change");
      help.push(command({ etag: probed.etag ?? request.ifMatch }));
      return { ...out, help };
    }
    const diff = diffResource(probed.current, request.body, request.method);
    if (diff.noop) {
      help.push("No field would change: executing would do nothing");
      help.push(command({ etag: probed.etag ?? request.ifMatch }));
      return { ...out, changes: [], noop: true, help };
    }
    help.push(command({ etag: probed.etag ?? request.ifMatch }));
    return {
      ...out,
      changes: diff.changes,
      ...(diff.remaining > 0 ? { remaining: diff.remaining } : {}),
      help,
    };
  }

  if (request.method === "DELETE") {
    const probed = await getCurrent(request);
    const current = isRecord(probed.current) ? probed.current : {};
    const tags = isRecord(current.tags) ? Object.keys(current.tags).length : 0;
    const summary: Record<string, unknown> = { name: current.name ?? targetResourceName(request.path, "DELETE") };
    if (typeof current.type === "string") summary.type = current.type;
    if (typeof current.location === "string") summary.location = current.location;
    summary.tags = tags;
    const out: Record<string, unknown> = { ...base, summary };
    if (probed.etag) out.etag = probed.etag;

    const scopes = new Set<string>();
    const rg = /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+/i.exec(bare)?.[0];
    if (rg) scopes.add(rg);
    scopes.add(bare);
    const lockNames: string[] = [];
    let lockCheckFailed = "";
    for (const scope of scopes) {
      const locks = await listLocks(request, scope);
      if ("names" in locks) lockNames.push(...locks.names);
      else lockCheckFailed = locks.code;
    }
    if (lockNames.length > 0) {
      out.lockWarning = `Resource lock(s) guard this target or its resource group (${lockNames.slice(0, 5).join(", ")}): deleting may be blocked`;
    } else if (lockCheckFailed) {
      help.push(`Could not check resource locks (${lockCheckFailed}): confirm in the portal before executing`);
    }
    help.push(
      command({ etag: probed.etag ?? request.ifMatch, confirmName: targetResourceName(request.path, "DELETE") }),
    );
    return { ...out, help };
  }

  // Other writes (for example POST actions that are neither queries nor
  // destructive): no current state to preview, just the body and the command.
  // Destructive ones still name their confirm target.
  help.push(
    command({
      etag: request.ifMatch,
      confirmName:
        request.cls === "destructive" ? targetResourceName(request.path, request.method) : undefined,
    }),
  );
  return { ...base, help };
}

async function dryRunDeployment(
  request: DryRunRequest,
  base: Record<string, unknown>,
  help: string[],
  command: (extra: { etag?: string; confirmName?: string }) => string,
): Promise<Record<string, unknown>> {
  if (request.body === undefined) {
    help.push("Pass --body '<json>' to preview the deployment change");
    help.push(command({}));
    return { ...base, help };
  }
  const queryStart = request.path.indexOf("?");
  const query = queryStart < 0 ? "" : request.path.slice(queryStart).split("#", 1)[0];
  const whatIfPath = `${barePath(request.path)}/whatIf${query}`;
  // Defensive: the preview POST must stay a query-class request, never a write.
  const whatIfShape = { resource: request.resource, method: "POST", path: whatIfPath };
  if (classifyRequest(whatIfShape) !== "query") {
    throw new AxiError(`refusing to preview deployment: ${whatIfPath} is not a query request`, "READ_ONLY", [
      "Deployment previews only run through the what-if action",
    ]);
  }
  // The what-if body is the deployment properties; a PUT body carries the full
  // deployment resource, so only location and properties are forwarded.
  const whatIfBody =
    isRecord(request.body) && "properties" in request.body
      ? {
          ...(typeof request.body.location === "string" ? { location: request.body.location } : {}),
          properties: request.body.properties,
        }
      : request.body;
  const response = await sendRequest<{ properties?: { changes?: Array<{ changeType?: string }> } }>(request.profile, {
    method: "POST",
    resource: request.resource,
    path: whatIfPath,
    query: request.query,
    apiVersion: request.apiVersion,
    body: whatIfBody,
  });
  const changes = response.body?.properties?.changes;
  const counts: Record<string, number> = {};
  if (Array.isArray(changes)) {
    for (const change of changes) {
      const key = String(change?.changeType ?? "unknown").toLowerCase();
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  const out: Record<string, unknown> = { ...base };
  if (changes === undefined) {
    help.push("The what-if response had no changes[] to summarize");
    out.whatIf = counts;
  } else {
    out.whatIf = counts;
  }
  help.push(command({ etag: request.ifMatch }));
  return { ...out, help };
}
