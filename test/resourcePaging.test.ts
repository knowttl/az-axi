import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runCommand } from "../src/lib/registry.js";
import { routeArgv } from "../src/lib/router.js";
import { nativeMarkerList } from "../src/lib/nativePaging.js";
import { SUB_A, acrTags, discoveryResource, keyvaultSecrets, storageBlobs, subscriptionList } from "./samples.js";

let dir: string;
let pages: number;
let endAfter: number;
const requests: string[] = [];
const json = (body: unknown, headers?: HeadersInit) => new Response(JSON.stringify(body), { headers });

// Synthetic service pages exercise the real command, transport and safe projections.
function service(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  requests.push(url.pathname);
  if (url.pathname === "/oauth2/exchange") return Promise.resolve(json({ refresh_token: "offline-refresh" }));
  if (url.pathname === "/oauth2/token") return Promise.resolve(json({ access_token: "offline-access" }));
  expect(init?.method).toBe("GET");
  pages++;
  const vault = url.hostname.endsWith(".vault.azure.net");
  const size = Math.min(vault ? 25 : 500, Number(url.searchParams.get("maxresults") ?? url.searchParams.get("n") ?? 500));
  const next = pages < endAfter ? `page-${pages}` : undefined;
  if (url.hostname.endsWith(".blob.core.windows.net")) {
    const blob = /<Blob>.*<\/Blob>/.exec(storageBlobs)![0];
    const container = blob.replaceAll("Blob", "Container");
    const blobs = url.searchParams.has("restype");
    return Promise.resolve(new Response(`<EnumerationResults><${blobs ? "Blobs" : "Containers"}>${(blobs ? blob : container).repeat(size)}</${blobs ? "Blobs" : "Containers"}><NextMarker>${next ?? ""}</NextMarker></EnumerationResults>`));
  }
  if (url.hostname.endsWith(".azurecr.io")) {
    return Promise.resolve(json(url.pathname.endsWith("_catalog")
      ? { repositories: Array(size).fill("example") }
      : { tags: Array(size).fill(acrTags.tags[0]) },
    next ? { Link: `<${url.origin}${url.pathname}?last=${next}>; rel="next"` } : undefined));
  }
  const item = vault ? JSON.parse(keyvaultSecrets).value[0] : url.pathname === "/subscriptions"
    ? subscriptionList[0]
    : { ...discoveryResource, id: `${url.pathname}/example`, name: "example" };
  const nextUrl = new URL(url);
  nextUrl.searchParams.set("page", next ?? "");
  return Promise.resolve(json({ value: Array(size).fill(item), ...(next ? { nextLink: nextUrl.toString() } : {}) }));
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-18T00:00:00Z"));
  dir = mkdtempSync(join(tmpdir(), "az-axi-paging-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ version: 1, profiles: { ci: { auth: "token", subscriptions: [SUB_A] } } }));
  vi.stubEnv("AZ_AXI_CONFIG", join(dir, "config.json"));
  vi.stubEnv("AZ_AXI_PROFILE", "ci");
  vi.stubEnv("AZ_AXI_ARM_TOKEN", "offline-arm");
  vi.stubEnv("AZ_AXI_STORAGE_TOKEN", "offline-storage");
  vi.stubEnv("AZ_AXI_VAULT_TOKEN", "offline-vault");
  vi.stubEnv("AZ_AXI_REGISTRY_TOKEN", "offline-registry");
  vi.stubEnv("AZ_AXI_SUBSCRIPTIONS", SUB_A);
  vi.stubGlobal("fetch", vi.fn(service));
  pages = 0;
  endAfter = Infinity;
  requests.length = 0;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

const LISTS = [
  "sub list", "account list", "group list", "resource list",
  ...["nsg", "nic", "vnet", "public-ip", "private-endpoint", "dns zone"].map((kind) => `network ${kind} list`),
  "network dns record-set list --resource-group example --zone-name example.com",
  ...["a", "aaaa", "caa", "cname", "mx", "ns", "ptr", "soa", "srv", "txt"].map((type) => `network dns record-set ${type} list --resource-group example --zone-name example.com`),
  "storage container list --account-name stexample", "storage blob list --account-name stexample --container-name example",
  ...["secret", "key", "certificate"].map((kind) => `keyvault ${kind} list --vault-name kvexample`),
  "acr repository list --name myregistry", "acr repository show-tags --name myregistry --repository example",
];
async function run(command: string, flags: string[]) {
  const { argv } = routeArgv([...command.split(" "), ...flags]);
  return runCommand(argv[0]!, argv.slice(1));
}
function rows(result: Record<string, unknown>): unknown[] {
  return Object.values(result).find((value) => Array.isArray(value) && value.length && typeof value[0] === "object") as unknown[];
}

it.each(LISTS)("%s enforces the fetch cap and retains safe field selection with --full", async (command) => {
  const result = await run(command, ["--max-rows", "2", "--limit", "1", "--full", "--fields", "name"]);
  expect(rows(result)).toHaveLength(2);
  expect(rows(result)[0]).toEqual({ name: expect.any(String) });
  expect(result.count).toContain("+");
  expect(JSON.stringify(result)).not.toMatch(/never-output-this-value|offline-(arm|storage|vault|access|refresh|registry)/);
  expect(pages).toBe(1);
});

const WALKS = ["resource list", "storage blob list --account-name stexample --container-name example", "keyvault secret list --vault-name kvexample", "acr repository list --name myregistry"];
it.each(WALKS)("%s separates default display and fetch budgets and stops at the collection end", async (command) => {
  endAfter = 1;
  const result = await run(command, ["--limit", "1"]);
  expect(rows(result)).toHaveLength(1);
  expect(result.count).not.toContain("+");
  expect(pages).toBe(1);
  expect(JSON.stringify(result.help)).toContain("--full");
});
it.each(WALKS)("%s defaults to 1000 fetched rows regardless of --limit", async (command) => {
  const result = await run(command, ["--full", "--limit", "1"]);
  expect(rows(result)).toHaveLength(1000);
  expect(result.count).toContain("+");
  expect(pages).toBe(command.startsWith("keyvault") ? 40 : 2);
});
it.each(WALKS)("%s raises the fetch budget with --all and retains the page cap", async (command) => {
  const result = await run(command, ["--all", "--full"]);
  expect(rows(result)).toHaveLength(command.startsWith("keyvault") ? 2500 : 10000);
  expect(pages).toBe(command.startsWith("keyvault") ? 100 : 20);
  expect(result.count).toContain("+");
});
it("Key Vault expiry filters count scanned objects before filtering", async () => {
  const result = await run("keyvault secret list --vault-name kvexample", ["--max-rows", "2", "--expiring-within", "1m"]);
  expect(result.secrets).toEqual([]);
  expect(result.status).toContain("listing incomplete");
  expect(pages).toBe(1);
  expect(requests).toEqual(["/secrets"]);
});
it.each(["resource list", "network nsg list"])("%s reports incomplete empty local filters at the row cap", async (command) => {
  const result = await run(command, ["--max-rows", "2", "--name", "missing"]);
  expect(result.total).toBe("0+");
  expect(result.rows).toContain("listing is incomplete");
  expect(JSON.stringify(result.help)).toContain("lower bounds");
  expect(pages).toBe(1);
});
it.each(["0", "100001", "1.5"])("rejects invalid fetch budget %s before transport", async (value) => {
  await expect(run("group list", ["--max-rows", value])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(requests).toEqual([]);
});
it("marker walks withhold a continuation when the service overfills the budget", async () => {
  const result = await nativeMarkerList({ maxRows: 1, maxPages: 100 }, undefined, async () => ({ rows: [1, 2], nextMarker: "next" }));
  expect(result).toEqual({ rows: [1], incomplete: true });
});
it("marker walks finish completely at the exact row boundary without a continuation", async () => {
  expect(await nativeMarkerList({ maxRows: 2, maxPages: 100 }, undefined, async () => ({ rows: [1, 2] })))
    .toEqual({ rows: [1, 2], incomplete: false });
});
it("marker walks terminate repeated continuations without offering them again", async () => {
  const fetch = vi.fn(async () => ({ rows: [], nextMarker: "same" }));
  expect(await nativeMarkerList({ maxRows: 1000, maxPages: 100 }, undefined, fetch)).toEqual({ rows: [], incomplete: true });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("marker walks stop at the page cap even when pages are empty", async () => {
  let marker = 0;
  const fetch = vi.fn(async () => ({ rows: [], nextMarker: String(++marker) }));
  expect(await nativeMarkerList({ maxRows: 1000, maxPages: 100 }, undefined, fetch)).toEqual({ rows: [], nextMarker: "100", incomplete: true });
  expect(fetch).toHaveBeenCalledTimes(100);
});
