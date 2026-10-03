import { AxiError } from "axi-sdk-js";
import type { Resource } from "./config.js";

/**
 * The only place requests are classified (PLAN.md Section 6.13.1).
 * Anything the rules do not recognize falls through to `write`, never to `read`.
 */
export type RequestClass = "read" | "query" | "secret" | "destructive" | "write";

export interface RequestShape {
  resource: Resource;
  method: string;
  /** Path, optionally with a query string. */
  path: string;
}

/** POST actions that return credentials (final path segment, case-insensitive). */
export const SECRET_ACTIONS: readonly string[] = [
  "listKeys",
  "listKey",
  "listCredentials",
  "listConnectionStrings",
  "listSecrets",
  "listAdminCredentials",
  "listPublishingCredentials",
  "publishxml",
  "listClusterAdminCredential",
  "listClusterUserCredential",
  "listClusterMonitoringUserCredential",
  "listCredential",
  "listAdminKeys",
  "listQueryKeys",
  "listAccountSas",
  "listServiceSas",
  "regeneratePassword",
  "regenerateCredential",
  "generateCredentials",
  "sharedKeys",
  "regenerateSharedKey",
  "readonlykeys",
  "listCallbackUrl",
  "retrieveBootDiagnosticsData",
];

export const SECRET_PARAMETER_ACTIONS: readonly string[] = ["createQueryKey", "regenerateAdminKey"];

/** POST actions that destroy or disrupt a resource (final path segment, case-insensitive). */
export const DESTRUCTIVE_ACTIONS: readonly string[] = [
  "delete",
  "purge",
  "regenerateKey",
  "regenerateKeys",
  "regeneratePrimaryKey",
  "regenerateSecondaryKey",
  "revoke",
  "deallocate",
  "powerOff",
  "stop",
  "restart",
  "failover",
  "reimage",
  "redeploy",
  "reimageall",
  "simulateEviction",
];

/**
 * Security-sensitive Microsoft.Authorization types: any PUT, PATCH or DELETE on
 * them is destructive, even when it only creates.
 */
export const PROTECTED_AUTHORIZATION_TYPES: readonly string[] = [
  "roleAssignments",
  "roleDefinitions",
  "locks",
  "policyAssignments",
];

const lower = (values: readonly string[]) => new Set(values.map((v) => v.toLowerCase()));
const SECRET_SET = lower(SECRET_ACTIONS);
const SECRET_PARAMETER_SET = lower(SECRET_PARAMETER_ACTIONS);
const DESTRUCTIVE_SET = lower(DESTRUCTIVE_ACTIONS);
const PROTECTED_SET = lower(PROTECTED_AUTHORIZATION_TYPES);

/** Lower-cased, percent-decoded, non-empty path segments; ARM decodes segments before routing. */
function segmentsOf(path: string): string[] {
  const bare = path.split(/[?#]/, 1)[0] ?? "";
  return bare
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

function isQueryPost(resource: Resource, s: string[]): boolean {
  if (resource === "logs") {
    return s.length === 4 && s[0] === "v1" && s[1] === "workspaces" && s[3] === "query";
  }
  if (resource === "graph") {
    return s.length === 3 && s[0] === "v1.0" && s[1] === "directoryobjects" && s[2] === "getbyids";
  }
  if (s.length === 3 && s[0] === "providers" && s[1] === "microsoft.resourcegraph" && s[2] === "resources") {
    return true;
  }
  // Deployment what-if at subscription and resource group scope.
  const scoped = s[0] === "subscriptions" && s.length >= 2 ? s.slice(2) : undefined;
  if (!scoped) return false;
  const rest = scoped[0] === "resourcegroups" ? scoped.slice(2) : scoped;
  return (
    rest.length === 5 &&
    rest[0] === "providers" &&
    rest[1] === "microsoft.resources" &&
    rest[2] === "deployments" &&
    rest[4] === "whatif"
  );
}

function touchesProtectedAuthorizationType(s: string[]): boolean {
  return s.some((segment, i) => segment === "microsoft.authorization" && PROTECTED_SET.has(s[i + 1] ?? ""));
}

export function classifyRequest({ resource, method, path }: RequestShape): RequestClass {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") return "read";
  const s = segmentsOf(path);
  const last = s[s.length - 1] ?? "";
  if (verb === "POST") {
    if (isQueryPost(resource, s)) return "query";
    if (SECRET_SET.has(last)) return "secret";
    if (s[s.length - 6] === "providers" && s[s.length - 5] === "microsoft.search" &&
        s[s.length - 4] === "searchservices" && SECRET_PARAMETER_SET.has(s[s.length - 2] ?? "")) return "secret";
    if (DESTRUCTIVE_SET.has(last)) return "destructive";
    return "write";
  }
  if (verb === "DELETE") return "destructive";
  if ((verb === "PUT" || verb === "PATCH") && touchesProtectedAuthorizationType(s)) return "destructive";
  return "write";
}

/**
 * Boundaries no profile or flag can move: credential-returning actions are never
 * sent, and az-axi writes to ARM only. Hints never mention how writes are enabled.
 */
export function assertReadOnlyBoundary(request: RequestShape, cls: RequestClass): void {
  if (cls === "secret") {
    throw new AxiError(
      `blocked: ${request.method.toUpperCase()} ${segmentsOf(request.path).at(-1)} returns credentials`,
      "READ_ONLY",
      [
        "az-axi never calls actions that return keys, secrets or credentials",
        "Use the Azure portal or the Azure CLI for these",
      ],
    );
  }
  if (request.resource !== "arm" && cls !== "read" && cls !== "query") {
    throw new AxiError(
      `blocked: ${request.method.toUpperCase()} requests to ${request.resource} are not supported`,
      "READ_ONLY",
      [
        `az-axi only reads from ${request.resource}`,
        "Writes are limited to Azure Resource Manager (--resource arm)",
      ],
    );
  }
}
