import { AxiError } from "axi-sdk-js";
import { resolveCredential } from "./auth.js";
import type { ResolvedProfile } from "./config.js";
import { assertEffectAllows } from "./registry.js";

export type AcrOp = "repository-list" | "tag-list" | "manifest-show";

export interface AcrRead {
  op: AcrOp;
  registry: string;
  repository?: string;
  reference?: string;
  limit: number;
  last?: string;
  orderby?: "time_asc" | "time_desc";
}

export interface AcrPage {
  rows: Record<string, unknown>[];
  nextMarker?: string;
}

// VERIFY: Microsoft Learn REST Container Registry data plane, api-version
// 2021-07-01 (catalog, tags and manifest documents fetched 2026-10-04):
// https://learn.microsoft.com/en-us/rest/api/registry-dataplane/container-registry
// Exchange/refresh audience: https://containerregistry.azure.net/.default
const API_VERSION = "2021-07-01";
const MAX_BODY_BYTES = 1024 * 1024;
const MANIFEST_ACCEPT =
  "application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json";

const fail = (message: string): never => {
  throw new AxiError(message, "VALIDATION_ERROR", ["Run `az-axi acr --help` for supported metadata reads"]);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textField = (item: Record<string, unknown>, name: string): string => {
  const value = item[name];
  return typeof value === "string" ? value : "";
};

/** No caller-supplied URLs, methods, bodies or auth schemes. */
export async function requestAcrMetadata(profile: ResolvedProfile, read: AcrRead): Promise<AcrPage> {
  if (!/^[a-z0-9]{5,50}$/.test(read.registry)) fail("--name/--registry must be a public Azure container registry name");
  if (!["repository-list", "tag-list", "manifest-show"].includes(read.op)) fail("unsupported acr operation");
  if (!Number.isInteger(read.limit) || read.limit < 1 || read.limit > 1000) fail("--limit must be an integer from 1 to 1000");
  if (read.op !== "repository-list" && !validRepository(read.repository)) fail("--repository must be a registry repository name");
  if (read.op === "manifest-show" && !validReference(read.reference)) fail("--name must be repository:tag or repository@digest");
  if (read.op !== "tag-list" && read.orderby !== undefined) fail("--orderby applies only to acr repository show-tags");
  if (read.orderby !== undefined && read.orderby !== "time_asc" && read.orderby !== "time_desc") {
    fail("--orderby must be time_asc or time_desc");
  }
  assertEffectAllows("read");
  const signal = AbortSignal.timeout(30_000);
  const credential = await resolveCredential(profile, "registry", signal);
  if (!/^Bearer [^\r\n]+$/.test(credential.header)) fail("acr requires an Entra bearer credential");
  const loginServer = `${read.registry}.azurecr.io`;
  const entra = credential.header.replace(/^Bearer /, "");
  const refresh = await exchangeToken(loginServer, entra, signal);
  const scope = read.op === "repository-list" ? "registry:catalog:*" : `repository:${read.repository}:pull`;
  const access = await accessToken(loginServer, refresh, scope, signal);
  if (read.op === "repository-list") return catalogPage(loginServer, access, read, signal);
  if (read.op === "tag-list") return tagPage(loginServer, access, read, signal);
  return manifestPage(loginServer, access, read, signal);
}

function validRepository(value: string | undefined): value is string {
  if (value === undefined || value.length > 255) return false;
  return /^[A-Za-z0-9]+(?:(?:[._]|__|-+)[A-Za-z0-9]+)*(?:\/[A-Za-z0-9]+(?:(?:[._]|__|-+)[A-Za-z0-9]+)*)*$/.test(value);
}

function validReference(value: string | undefined): value is string {
  if (value === undefined) return false;
  return /^[\w][\w.-]{0,127}$/.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:[0-9A-Za-z_+.=:/-]{32,}$/.test(value);
}

function pathOf(loginServer: string, path: string, query?: Record<string, string>): string {
  const url = new URL(`https://${loginServer}${path}`);
  url.searchParams.set("api-version", API_VERSION);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

/** Exact token endpoint only; the Entra token never travels anywhere else. */
async function exchangeToken(loginServer: string, entra: string, signal: AbortSignal): Promise<string> {
  const body = new URLSearchParams({ grant_type: "access_token", service: loginServer, access_token: entra });
  const json = await postForm(`https://${loginServer}/oauth2/exchange`, body, signal);
  if (typeof json.refresh_token !== "string" || !json.refresh_token || /[\r\n]/.test(json.refresh_token)) {
    throw new AxiError("acr token exchange returned an unusable refresh token", "AUTH_REQUIRED", [
      "Check the selected Azure CLI tenant and sign-in, or use a token profile with AZ_AXI_REGISTRY_TOKEN",
    ]);
  }
  return json.refresh_token;
}

async function accessToken(loginServer: string, refresh: string, scope: string, signal: AbortSignal): Promise<string> {
  const body = new URLSearchParams({ grant_type: "refresh_token", service: loginServer, scope, refresh_token: refresh });
  const json = await postForm(`https://${loginServer}/oauth2/token`, body, signal);
  if (typeof json.access_token !== "string" || !json.access_token || /[\r\n]/.test(json.access_token)) {
    throw new AxiError("acr token request returned an unusable access token", "AUTH_REQUIRED", [
      "The identity needs AcrPull on the registry; admin-user passwords are never used",
    ]);
  }
  return json.access_token;
}

/** One exact form POST to the pinned login server; token values never enter errors. */
async function postForm(url: string, body: URLSearchParams, signal: AbortSignal): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST", redirect: "error", signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch {
    throw new AxiError("acr authentication request failed", "NETWORK_ERROR", ["Check connectivity to the registry login server"]);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AxiError(`acr authentication request returned HTTP ${response.status}`,
      response.status === 401 ? "AUTH_REQUIRED" : response.status === 403 ? "FORBIDDEN" : "API_ERROR",
      ["Use an Entra token for https://containerregistry.azure.net/ and check AcrPull role assignment; password fallback is disabled"]);
  }
  const json = await boundedJson(response, "acr authentication response exceeded its bound");
  if (!isRecord(json)) throw new AxiError("invalid acr authentication response", "API_ERROR", ["Retry the metadata read"]);
  return json;
}

interface DataResponse {
  json: unknown;
  headers: Headers;
}

async function dataGet(url: string, access: string, accept: string | undefined, signal: AbortSignal): Promise<DataResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET", redirect: "error", signal,
      headers: { Authorization: `Bearer ${access}`, ...(accept ? { Accept: accept } : {}) },
    });
  } catch {
    throw new AxiError("acr metadata request failed", "NETWORK_ERROR", ["Check connectivity to the registry login server"]);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AxiError(`acr metadata request returned HTTP ${response.status}`,
      response.status === 401 ? "AUTH_REQUIRED" : response.status === 403 ? "FORBIDDEN" : "API_ERROR",
      ["Use an Entra token for https://containerregistry.azure.net/ and check AcrPull role assignment; password fallback is disabled"]);
  }
  return { json: await boundedJson(response, "acr metadata response exceeded its bound"), headers: response.headers };
}

/** Bound the decoded stream too: responses may omit Content-Length. */
async function boundedJson(response: Response, message: string): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new Error("response too large");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    await reader.cancel();
    throw new AxiError(message, "API_ERROR", ["Retry with a smaller --limit"]);
  } finally {
    reader.releaseLock();
  }
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new AxiError("invalid acr metadata response", "API_ERROR", ["Retry the metadata read"]);
  }
}

/** Continuation from the service Link header; a missing Link means the page is complete. */
function linkMarker(headers: Headers, loginServer: string): string | undefined {
  const link = headers.get("link");
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const match = /<([^>]*)>\s*;\s*rel="next"/.exec(part.trim());
    if (!match) continue;
    try {
      const last = new URL(match[1]!, `https://${loginServer}`).searchParams.get("last");
      if (last) return last;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function catalogPage(loginServer: string, access: string, read: AcrRead, signal: AbortSignal): Promise<AcrPage> {
  const url = pathOf(loginServer, "/acr/v1/_catalog",
    { n: String(read.limit), ...(read.last !== undefined ? { last: read.last } : {}) });
  const { json, headers } = await dataGet(url, access, undefined, signal);
  if (!isRecord(json) || !Array.isArray(json.repositories) ||
      json.repositories.some((name) => typeof name !== "string" || !name)) {
    throw new AxiError("invalid acr catalog response", "API_ERROR", ["Retry the metadata read"]);
  }
  return { rows: json.repositories.map((name) => ({ name })), ...marker(headers, loginServer) };
}

async function tagPage(loginServer: string, access: string, read: AcrRead, signal: AbortSignal): Promise<AcrPage> {
  const repository = read.repository!;
  const url = pathOf(loginServer, `/acr/v1/${repository.split("/").map(encodeURIComponent).join("/")}/_tags`,
    { n: String(read.limit),
      ...(read.last !== undefined ? { last: read.last } : {}),
      ...(read.orderby ? { orderby: read.orderby === "time_asc" ? "timeasc" : "timedesc" } : {}) });
  const { json, headers } = await dataGet(url, access, undefined, signal);
  if (!isRecord(json) || !Array.isArray(json.tags)) throw new AxiError("invalid acr tag response", "API_ERROR", ["Retry the metadata read"]);
  const rows = json.tags.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name) {
      throw new AxiError("invalid acr tag response", "API_ERROR", ["Retry the metadata read"]);
    }
    return {
      name: entry.name, digest: textField(entry, "digest"),
      createdTime: textField(entry, "createdTime"), lastUpdateTime: textField(entry, "lastUpdateTime"),
    };
  });
  return { rows, ...marker(headers, loginServer) };
}

function marker(headers: Headers, loginServer: string): { nextMarker?: string } {
  const nextMarker = linkMarker(headers, loginServer);
  return nextMarker ? { nextMarker } : {};
}

/** One manifest document only; blob content is never fetched. */
async function manifestPage(loginServer: string, access: string, read: AcrRead, signal: AbortSignal): Promise<AcrPage> {
  const repository = read.repository!;
  const url = pathOf(loginServer,
    `/v2/${repository.split("/").map(encodeURIComponent).join("/")}/manifests/${encodeURIComponent(read.reference!)}`);
  const { json, headers } = await dataGet(url, access, MANIFEST_ACCEPT, signal);
  if (!isRecord(json)) throw new AxiError("invalid acr manifest response", "API_ERROR", ["Retry the metadata read"]);
  const digest = headers.get("docker-content-digest") ?? "";
  return { rows: [manifestRow(json, digest)] };
}

/** Strict metadata projection: descriptors only, no signatures, history or download URLs. */
function manifestRow(json: Record<string, unknown>, digest: string): Record<string, unknown> {
  const row: Record<string, unknown> = { digest };
  if (typeof json.mediaType === "string") row.mediaType = json.mediaType;
  if (typeof json.schemaVersion === "number") row.schemaVersion = json.schemaVersion;
  const config = descriptor(json.config);
  if (config) row.config = config;
  const layers = Array.isArray(json.layers) ? json.layers.map(descriptor).filter(Boolean) : [];
  if (layers.length) row.layers = layers;
  const manifests = Array.isArray(json.manifests) ? json.manifests.map(manifestEntry).filter(Boolean) : [];
  if (manifests.length) row.manifests = manifests;
  return row;
}

function descriptor(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || typeof value.digest !== "string" || !value.digest) return undefined;
  const row: Record<string, unknown> = { digest: value.digest };
  if (typeof value.mediaType === "string") row.mediaType = value.mediaType;
  if (typeof value.size === "number" && Number.isFinite(value.size) && value.size >= 0) row.size = value.size;
  return row;
}

function manifestEntry(value: unknown): Record<string, unknown> | undefined {
  const row = descriptor(value);
  if (!row || !isRecord(value)) return undefined;
  if (isRecord(value.platform)) {
    const platform: Record<string, string> = {};
    for (const key of ["architecture", "os", "variant"]) {
      if (typeof value.platform[key] === "string") platform[key] = value.platform[key] as string;
    }
    if (Object.keys(platform).length) row.platform = platform;
  }
  return row;
}
