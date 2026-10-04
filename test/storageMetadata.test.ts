import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestStorageMetadata } from "../src/lib/client.js";
import type { ResolvedProfile } from "../src/lib/config.js";
import { storageBlobs, storageContainers, storageProperties } from "./samples.js";

vi.mock("../src/lib/auth.js", () => ({ resolveCredential: vi.fn() }));
import { resolveCredential } from "../src/lib/auth.js";

const profile: ResolvedProfile = { name: "ci", auth: "token", source: "flag", writeSubscriptions: [] };
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(resolveCredential).mockReset().mockResolvedValue({ header: "Bearer fake-storage-token", mode: "token" });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("storage metadata transport", () => {
  it.each([
    ["container", "list", "GET", "/?comp=list&maxresults=50", storageContainers],
    ["container", "show", "HEAD", "/example?restype=container", null],
    ["blob", "list", "GET", "/example?restype=container&comp=list&maxresults=50", storageBlobs],
    ["blob", "show", "HEAD", "/example/folder/a%3Fb%23c?", null],
  ] as const)("%s %s sends only the approved metadata operation", async (kind, verb, method, suffix, xml) => {
    fetchMock.mockResolvedValue(new Response(xml, { headers: storageProperties }));
    const result = await requestStorageMetadata(profile, { kind, verb, account: "stexample", container: "example", name: kind === "blob" ? "folder/a?b#c" : "example", limit: 50 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`https://stexample.blob.core.windows.net${suffix.replace(/\?$/, "")}`);
    expect(init).toMatchObject({ method, redirect: "error", headers: { Authorization: "Bearer fake-storage-token", "x-ms-version": "2023-11-03" } });
    expect(init).not.toHaveProperty("body");
    expect(resolveCredential).toHaveBeenCalledWith(profile, "storage", expect.any(AbortSignal));
    expect(JSON.stringify(result)).not.toContain("never-output-this-value");
    expect(result.rows[0]).toHaveProperty("etag");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses escaped prefix and opaque marker without following XML endpoints", async () => {
    fetchMock.mockResolvedValue(new Response(storageBlobs.replace("<EnumerationResults>", '<EnumerationResults ServiceEndpoint="https://evil.example.com">')));
    const result = await requestStorageMetadata(profile, { kind: "blob", verb: "list", account: "stexample", container: "example", limit: 10, prefix: "&sig=secret", marker: "?comp=download" });
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.host).toBe("stexample.blob.core.windows.net");
    expect([...url.searchParams.keys()]).toEqual(["restype", "comp", "maxresults", "prefix", "marker"]);
    expect(result).toMatchObject({ nextMarker: "next&page", rows: [{ name: "folder/a&b.txt", size: "42", blobType: "BlockBlob" }] });
  });

  it.each([401, 403, 404, 302])( "HTTP %s never falls back or reads an error body", async (status) => {
    fetchMock.mockResolvedValue(new Response("credential-value", { status, headers: { location: "https://evil.example.com" } }));
    await expect(requestStorageMetadata(profile, { kind: "container", verb: "list", account: "stexample", limit: 50 })).rejects.toMatchObject({ message: `storage metadata request returned HTTP ${status}` });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolveCredential).toHaveBeenCalledTimes(1);
  });

  it("missing Entra credentials never fetches or retries with a key", async () => {
    vi.mocked(resolveCredential).mockRejectedValue(new Error("missing token"));
    await expect(requestStorageMetadata(profile, { kind: "container", verb: "list", account: "stexample", limit: 50 })).rejects.toThrow("missing token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["SharedKey account:key", "Bearer token\r\nx: y"])("rejects a non-bearer or injected credential", async (header) => {
    vi.mocked(resolveCredential).mockResolvedValue({ header, mode: "token" });
    await expect(requestStorageMetadata(profile, { kind: "container", verb: "list", account: "stexample", limit: 50 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["evil.example.com", "stexample?sig=secret", "stexample@evil.example.com"])("rejects hostile account %s before auth", async (account) => {
    await expect(requestStorageMetadata(profile, { kind: "container", verb: "list", account, limit: 50 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["../secret", ".", "folder/../secret"])("rejects dot paths %s", async (name) => {
    await expect(requestStorageMetadata(profile, { kind: "blob", verb: "show", account: "stexample", container: "example", name, limit: 50 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["<!DOCTYPE x [<!ENTITY secret SYSTEM 'file:///secret'>]><EnumerationResults/>", "<EnumerationResults><Blobs></EnumerationResults>", "<wrong/>"])("refuses malformed or DTD XML", async (xml) => {
    fetchMock.mockResolvedValue(new Response(xml));
    await expect(requestStorageMetadata(profile, { kind: "blob", verb: "list", account: "stexample", container: "example", limit: 50 })).rejects.toMatchObject({ code: "API_ERROR" });
  });

  it("bounds list bytes", async () => {
    fetchMock.mockResolvedValue(new Response("x".repeat(1024 * 1024 + 1)));
    await expect(requestStorageMetadata(profile, { kind: "container", verb: "list", account: "stexample", limit: 50 })).rejects.toMatchObject({ code: "API_ERROR" });
  });

  it("never consumes a blob body on show", async () => {
    const response = new Response("blob-content-must-not-be-read", { headers: storageProperties });
    const text = vi.spyOn(response, "text");
    const reader = vi.spyOn(response.body!, "getReader");
    fetchMock.mockResolvedValue(response);
    await requestStorageMetadata(profile, { kind: "blob", verb: "show", account: "stexample", container: "example", name: "blob", limit: 50 });
    expect(text).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();
  });
});
