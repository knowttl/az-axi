import { AxiError } from "axi-sdk-js";
import { resolveCredential } from "./auth.js";
import type { ResolvedProfile } from "./config.js";
import { assertEffectAllows } from "./registry.js";

export interface StorageRead {
  kind: "container" | "blob";
  verb: "list" | "show";
  account: string;
  container?: string;
  name?: string;
  limit: number;
  prefix?: string;
  marker?: string;
}

export interface StoragePage {
  rows: Record<string, string>[];
  nextMarker?: string;
}

const fail = (message: string): never => {
  throw new AxiError(message, "VALIDATION_ERROR", ["Run `az-axi storage --help` for supported metadata reads"]);
};

/** No caller-supplied URLs, methods, query maps, bodies or auth schemes. */
export async function requestStorageMetadata(profile: ResolvedProfile, read: StorageRead): Promise<StoragePage> {
  if (!/^[a-z0-9]{3,24}$/.test(read.account)) fail("--account-name must be a public Azure storage account name");
  if (!["container", "blob"].includes(read.kind) || !["list", "show"].includes(read.verb)) fail("unsupported storage operation");
  if (!Number.isInteger(read.limit) || read.limit < 1 || read.limit > 1000) fail("--limit must be an integer from 1 to 1000");
  const container = read.kind === "container" ? (read.verb === "show" ? read.name : undefined) : read.container;
  if ((read.kind === "blob" || read.verb === "show") &&
      (!container || !/^(?:\$root|\$logs|\$web|[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9]))$/.test(container) || container.includes("--"))) {
    fail("a valid container name is required");
  }
  if (read.kind === "blob" && read.verb === "show" &&
      (!read.name || read.name.length > 1024 || read.name.split("/").some((part) => part === "." || part === ".."))) {
    fail("--name requires a blob name without dot path segments");
  }
  const list = read.verb === "list";
  const url = new URL(`https://${read.account}.blob.core.windows.net/`);
  if (container) url.pathname = `/${encodeURIComponent(container)}`;
  if (!list && read.kind === "blob") url.pathname += `/${read.name!.split("/").map(encodeURIComponent).join("/")}`;
  if (read.kind === "container" && !list || read.kind === "blob" && list) url.searchParams.set("restype", "container");
  if (list) {
    url.searchParams.set("comp", "list");
    url.searchParams.set("maxresults", String(read.limit));
    if (read.prefix !== undefined) url.searchParams.set("prefix", read.prefix);
    if (read.marker !== undefined) url.searchParams.set("marker", read.marker);
  }
  assertEffectAllows("read");
  const signal = AbortSignal.timeout(30_000);
  const credential = await resolveCredential(profile, "storage", signal);
  if (!/^Bearer [^\r\n]+$/.test(credential.header)) fail("storage requires an Entra bearer credential");
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: list ? "GET" : "HEAD", redirect: "error", signal,
      headers: { Authorization: credential.header, "x-ms-version": "2023-11-03", "x-ms-date": new Date().toUTCString() },
    });
  } catch {
    throw new AxiError("storage metadata request failed", "NETWORK_ERROR", ["Check connectivity to the account's Blob endpoint"]);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AxiError(`storage metadata request returned HTTP ${response.status}`,
      response.status === 401 ? "AUTH_REQUIRED" : response.status === 403 ? "FORBIDDEN" : "API_ERROR",
      ["Use an Entra token for https://storage.azure.com/ and check Blob data RBAC permissions; key fallback is disabled"]);
  }
  if (!list) {
    await response.body?.cancel();
    const headers = response.headers;
    return { rows: [{
      name: read.name!, lastModified: headers.get("last-modified") ?? "", etag: headers.get("etag") ?? "",
      ...(read.kind === "blob" ? { size: headers.get("content-length") ?? "", blobType: headers.get("x-ms-blob-type") ?? "" }
        : { publicAccess: headers.get("x-ms-blob-public-access") ?? "private" }),
    }] };
  }
  // Bound the decoded XML stream too: a compressed or chunked response may omit Content-Length.
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  if (reader) {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 1024 * 1024) throw new Error("response too large");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch {
      await reader.cancel();
      throw new AxiError("storage metadata response exceeded its bound or could not be read", "API_ERROR", ["Retry with a smaller --limit"]);
    } finally {
      reader.releaseLock();
    }
  }
  return metadataPage(text, read.kind);
}

interface Node { name: string; text: string; children: Node[]; encoded: boolean }

/** Restricted service XML: no DTD/entity expansion, bounded depth, no arbitrary values returned. */
function metadataPage(xml: string, kind: StorageRead["kind"]): StoragePage {
  function invalid(): never { throw new AxiError("invalid storage metadata XML", "API_ERROR", ["Retry the metadata read"]); }
  const root: Node = { name: "", text: "", children: [], encoded: false };
  const stack = [root];
  let nodes = 0;
  const unescape = (value: string) => value.replace(/&([^;]+);/g, (_, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (named[entity] !== undefined) return named[entity]!;
    const number = /^#x[0-9a-f]+$/i.test(entity) ? parseInt(entity.slice(2), 16) : /^#\d+$/.test(entity) ? Number(entity.slice(1)) : NaN;
    if (!Number.isInteger(number) || number < 1 || number > 0x10ffff || number >= 0xd800 && number <= 0xdfff) invalid();
    return String.fromCodePoint(number);
  });
  const tokens = xml.match(/<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g) ?? [];
  if (tokens.join("") !== xml) invalid();
  for (const token of tokens) {
    const parent = stack.at(-1)!;
    if (token.startsWith("<?xml ")) continue;
    if (token.startsWith("<![CDATA[")) { parent.text += token.slice(9, -3); continue; }
    if (token.startsWith("</")) {
      if (stack.length < 2 || token !== `</${parent.name}>`) invalid();
      stack.pop();
    } else if (token.startsWith("<")) {
      const match = /^<([A-Za-z][\w-]*)(?:\s+[^<>]*?)?\s*\/?>$/.exec(token);
      if (!match || stack.length > 16 || ++nodes > 20_000) invalid();
      const node: Node = { name: match[1]!, text: "", children: [], encoded: /\sEncoded\s*=\s*(?:"true"|'true')(?=\s|\/?>)/.test(token) };
      parent.children.push(node);
      if (!token.endsWith("/>")) stack.push(node);
    } else parent.text += unescape(token);
  }
  if (stack.length !== 1 || root.children.length !== 1 || root.children[0]?.name !== "EnumerationResults" || root.text.trim()) invalid();
  const child = (node: Node, name: string) => node.children.find((item) => item.name === name);
  const field = (node: Node, name: string) => {
    const found = child(node, name);
    if (found?.children.length) invalid();
    if (found?.encoded) {
      try { return decodeURIComponent(found.text); } catch { invalid(); }
    }
    return found?.text ?? "";
  };
  const envelope = root.children[0]!;
  const collection = child(envelope, kind === "container" ? "Containers" : "Blobs");
  if (!collection) invalid();
  const rows = collection.children.filter((item) => item.name === (kind === "container" ? "Container" : "Blob")).map((item) => {
    const properties = child(item, "Properties");
    if (!properties || !field(item, "Name")) invalid();
    return {
      name: field(item, "Name"), lastModified: field(properties, "Last-Modified"), etag: field(properties, "Etag"),
      ...(kind === "blob" ? { size: field(properties, "Content-Length"), blobType: field(properties, "BlobType") }
        : { publicAccess: field(properties, "PublicAccess") || "private" }),
    };
  });
  const nextMarker = field(envelope, "NextMarker");
  return { rows, ...(nextMarker ? { nextMarker } : {}) };
}
