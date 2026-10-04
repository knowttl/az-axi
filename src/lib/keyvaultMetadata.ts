import { AxiError } from "axi-sdk-js";
import { KEYVAULT_DATA_PLANE } from "./apiVersions.js";
import { resolveCredential } from "./auth.js";
import type { ResolvedProfile } from "./config.js";
import { assertEffectAllows } from "./registry.js";

export type KeyVaultKind = "secret" | "key" | "certificate";

export interface KeyVaultRead {
  kind: KeyVaultKind;
  verb: "list" | "show";
  vault: string;
  name?: string;
  limit: number;
  /** Include only items expiring within this many milliseconds. Absent means no expiry filter. */
  expiringWithinMs?: number;
}

export interface KeyVaultPage {
  rows: Array<Record<string, string | boolean>>;
  /** The service reported more pages after the returned rows. */
  truncated: boolean;
}

const COLLECTIONS: Record<KeyVaultKind, string> = {
  secret: "secrets",
  key: "keys",
  certificate: "certificates",
};

/** Service page size: the data plane returns at most 25 items per list page. */
const PAGE_SIZE = 25;
/** Response bound matching the storage metadata transport. */
const MAX_BODY_BYTES = 1024 * 1024;
/** Paging bound so a narrow expiry filter on a large vault still terminates. */
const MAX_PAGES = 40;

const fail = (message: string): never => {
  throw new AxiError(message, "VALIDATION_ERROR", ["Run `az-axi keyvault --help` for supported metadata reads"]);
};

/**
 * Property-listing reads only. The only URLs ever constructed are the collection
 * list endpoints (`/{secrets,keys,certificates}?api-version=...`) plus service
 * nextLink continuations validated back to the same vault and collection path.
 * Single-object endpoints (`/{collection}/{name}[/{version}]`) return secret values
 * or key material, so `show` filters the property list client-side instead:
 * no caller-supplied name ever enters a request URL.
 */
export async function requestKeyVaultMetadata(profile: ResolvedProfile, read: KeyVaultRead): Promise<KeyVaultPage> {
  if (!/^[A-Za-z][A-Za-z0-9-]{1,22}[A-Za-z0-9]$/.test(read.vault) || read.vault.includes("--")) {
    fail("--vault-name must be a public Azure key vault name");
  }
  const collection = COLLECTIONS[read.kind];
  if (!collection || read.verb !== "list" && read.verb !== "show") fail("unsupported key vault operation");
  if (!Number.isInteger(read.limit) || read.limit < 1 || read.limit > 1000) fail("--limit must be an integer from 1 to 1000");
  if (read.expiringWithinMs !== undefined &&
      (!Number.isFinite(read.expiringWithinMs) || read.expiringWithinMs <= 0)) {
    fail("--expiring-within must be a positive duration like 30d");
  }
  if (read.verb === "show" && (!read.name || !/^[0-9A-Za-z-]{1,127}$/.test(read.name))) {
    fail("--name requires a key vault object name (letters, digits and hyphens, up to 127 characters)");
  }
  const host = `${read.vault}.vault.azure.net`;
  assertEffectAllows("read");
  const signal = AbortSignal.timeout(30_000);
  const credential = await resolveCredential(profile, "vault", signal);
  if (!/^Bearer [^\r\n]+$/.test(credential.header)) fail("keyvault requires an Entra bearer credential");
  const headers = { Authorization: credential.header, Accept: "application/json" };
  const rows: Array<Record<string, string | boolean>> = [];
  let url: string | undefined =
    `https://${host}/${collection}?api-version=${KEYVAULT_DATA_PLANE}&maxresults=${Math.min(PAGE_SIZE, read.limit)}`;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES && url && rows.length < read.limit; page++) {
    let response: Response;
    try {
      response = await fetch(url, { method: "GET", redirect: "error", signal, headers });
    } catch {
      throw new AxiError("key vault metadata request failed", "NETWORK_ERROR", ["Check connectivity to the vault's data-plane endpoint"]);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AxiError(`key vault metadata request returned HTTP ${response.status}`,
        response.status === 401 ? "AUTH_REQUIRED" : response.status === 403 ? "FORBIDDEN" : response.status === 404 ? "NOT_FOUND" : "API_ERROR",
        ["Use an Entra token for https://vault.azure.net/ and check Key Vault data-plane permissions (list); no key or certificate fallback exists"]);
    }
    const body = await readBoundedJson(response);
    const items = Array.isArray((body as { value?: unknown }).value) ? (body as { value: unknown[] }).value : failBody();
    for (const item of items) {
      const row = toRow(read.kind, item);
      if (read.verb === "show" && row.name !== read.name) continue;
      if (read.expiringWithinMs !== undefined && !expiresWithin(row, read.expiringWithinMs, Date.now())) continue;
      rows.push(row);
      if (rows.length >= read.limit || read.verb === "show") break;
    }
    if (read.verb === "show" && rows.length) return { rows, truncated: false };
    url = nextPage(host, collection, body);
  }
  if (url) truncated = true;
  return { rows: rows.slice(0, read.limit), truncated };
}

function failBody(): never {
  throw new AxiError("invalid key vault metadata response", "API_ERROR", ["Retry the metadata read"]);
}

/** Bounded JSON read: the service page is small, but the stream is capped like the storage transport. */
async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) failBody();
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
    await reader.cancel().catch(() => undefined);
    throw new AxiError("key vault metadata response exceeded its bound or could not be read", "API_ERROR", ["Retry with a smaller --limit"]);
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    failBody();
  }
}

/**
 * Project one list item to safe properties only. Unexpected members (notably any
 * `value`, key material or certificate bytes) are dropped, never returned.
 */
function toRow(kind: KeyVaultKind, item: unknown): Record<string, string | boolean> {
  if (!item || typeof item !== "object") failBody();
  const record = item as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : typeof record.kid === "string" ? record.kid : undefined;
  const segments = typeof id === "string" ? id.split("/") : [];
  const at = segments.findIndex((part) => part === "secrets" || part === "keys" || part === "certificates");
  // List identifiers always carry a version segment after the name.
  const name = at >= 0 && segments.length === at + 3 ? segments[at + 1] : undefined;
  const attributes = record.attributes && typeof record.attributes === "object"
    ? record.attributes as Record<string, unknown>
    : {};
  if (!name || !/^[0-9A-Za-z-]{1,127}$/.test(name)) failBody();
  const row: Record<string, string | boolean> = {
    name,
    enabled: attributes.enabled === true,
    expiresOn: epochToIso(attributes.exp),
    notBefore: epochToIso(attributes.nbf),
    created: epochToIso(attributes.created),
    updated: epochToIso(attributes.updated),
  };
  if (kind === "secret" && typeof record.contentType === "string") row.contentType = record.contentType;
  if (kind === "certificate" && typeof record.x5t === "string") row.thumbprint = record.x5t;
  if (typeof record.managed === "boolean") row.managed = record.managed;
  return row;
}

function epochToIso(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "";
  return new Date(value * 1000).toISOString();
}

/** True when the row expires after now and no later than now plus the window. */
function expiresWithin(row: Record<string, string | boolean>, windowMs: number, now: number): boolean {
  const expiresOn = row.expiresOn;
  if (typeof expiresOn !== "string" || !expiresOn) return false;
  const at = Date.parse(expiresOn);
  return Number.isFinite(at) && at > now && at <= now + windowMs;
}

/**
 * Follow only a service continuation that stays on this vault and collection.
 * Anything else (another host, a single-object path, a relative reference)
 * is refused: list URLs never become value URLs.
 */
function nextPage(host: string, collection: string, body: unknown): string | undefined {
  const nextLink = (body as { nextLink?: unknown }).nextLink;
  if (nextLink === undefined || nextLink === null) return undefined;
  if (typeof nextLink !== "string" || !nextLink) failBody();
  let url: URL;
  try {
    url = new URL(nextLink);
  } catch {
    failBody();
  }
  if (url!.protocol !== "https:" || url!.host !== host || url!.pathname !== `/${collection}`) {
    throw new AxiError("key vault returned an unexpected continuation", "API_ERROR", ["Retry the metadata read"]);
  }
  return url!.toString();
}
