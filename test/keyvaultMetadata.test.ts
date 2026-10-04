import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestKeyVaultMetadata } from "../src/lib/client.js";
import type { ResolvedProfile } from "../src/lib/config.js";
import { keyvaultCertificates, keyvaultKeys, keyvaultSecrets } from "./samples.js";

vi.mock("../src/lib/auth.js", () => ({ resolveCredential: vi.fn() }));
import { resolveCredential } from "../src/lib/auth.js";

const profile: ResolvedProfile = { name: "ci", auth: "token", source: "flag", writeSubscriptions: [] };
const fetchMock = vi.fn<typeof fetch>();
const json = (text: string, init?: ResponseInit) =>
  new Response(text, { ...init, headers: { "content-type": "application/json" } });
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(resolveCredential).mockReset().mockResolvedValue({ header: "Bearer fake-vault-token", mode: "token" });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const firstUrl = () => String(fetchMock.mock.calls[0]![0]);
const allPaths = () => fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);

describe("key vault metadata transport", () => {
  it.each([
    ["secret", keyvaultSecrets, "https://kvexample.vault.azure.net/secrets?api-version=7.4&maxresults=25"],
    ["key", keyvaultKeys, "https://kvexample.vault.azure.net/keys?api-version=7.4&maxresults=25"],
    ["certificate", keyvaultCertificates, "https://kvexample.vault.azure.net/certificates?api-version=7.4&maxresults=25"],
  ] as const)("%s list sends only the approved property-listing GET", async (kind, payload, url) => {
    fetchMock.mockResolvedValue(json(payload));
    const result = await requestKeyVaultMetadata(profile, { kind, verb: "list", vault: "kvexample", limit: 50 });
    expect(firstUrl()).toBe(url);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      method: "GET", redirect: "error",
      headers: { Authorization: "Bearer fake-vault-token", Accept: "application/json" },
    });
    expect(fetchMock.mock.calls[0]![1]).not.toHaveProperty("body");
    expect(resolveCredential).toHaveBeenCalledWith(profile, "vault", expect.any(AbortSignal));
    expect(JSON.stringify(result)).not.toContain("never-output-this-value");
    expect(result).toEqual({ rows: [expect.objectContaining({ name: expect.any(String) })], truncated: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("projects safe properties with ISO timestamps and drops values, tags and key material", async () => {
    fetchMock.mockResolvedValue(json(keyvaultSecrets));
    const { rows: [row] } = await requestKeyVaultMetadata(profile, { kind: "secret", verb: "list", vault: "kvexample", limit: 50 });
    expect(row).toEqual({
      name: "example-secret", enabled: true, expiresOn: "2026-11-03T00:00:00.000Z",
      notBefore: "2026-10-03T00:00:00.000Z", created: "2026-10-04T00:00:00.000Z",
      updated: "2026-10-04T00:00:00.000Z", contentType: "text/plain", managed: false,
    });
  });

  it("leaves missing expiry attributes empty instead of inventing dates", async () => {
    fetchMock.mockResolvedValue(json(keyvaultCertificates));
    const { rows: [row] } = await requestKeyVaultMetadata(profile, { kind: "certificate", verb: "list", vault: "kvexample", limit: 50 });
    expect(row).toMatchObject({ name: "example-cert", enabled: false, expiresOn: "", notBefore: "", thumbprint: "dGVzdA" });
  });

  it("show filters the property list by name and never addresses a single object", async () => {
    fetchMock.mockResolvedValue(json(keyvaultSecrets));
    const result = await requestKeyVaultMetadata(profile, { kind: "secret", verb: "show", vault: "kvexample", name: "example-secret", limit: 50 });
    expect(result.rows).toHaveLength(1);
    expect(allPaths()).toEqual(["/secrets"]);
  });

  it("show pages the property list until the name is found", async () => {
    fetchMock
      .mockResolvedValueOnce(json(JSON.stringify({ value: [], nextLink: "https://kvexample.vault.azure.net/secrets?api-version=7.4&$skiptoken=abc" })))
      .mockResolvedValueOnce(json(keyvaultSecrets));
    const result = await requestKeyVaultMetadata(profile, { kind: "secret", verb: "show", vault: "kvexample", name: "example-secret", limit: 50 });
    expect(result.rows).toHaveLength(1);
    expect(allPaths()).toEqual(["/secrets", "/secrets"]);
  });

  it("show reports an empty page when the name is absent from every page", async () => {
    fetchMock.mockResolvedValue(json(JSON.stringify({ value: [] })));
    const result = await requestKeyVaultMetadata(profile, { kind: "secret", verb: "show", vault: "kvexample", name: "missing", limit: 50 });
    expect(result).toEqual({ rows: [], truncated: false });
  });

  it.each(["other/secret", "../secret", "secret?api-version=1", "secret/version/extra", "a".repeat(128), "", "has space", "semi;colon"])(
    "never builds a value URL for hostile show name %j", async (name) => {
      fetchMock.mockResolvedValue(json(keyvaultSecrets));
      await expect(requestKeyVaultMetadata(profile, { kind: "secret", verb: "show", vault: "kvexample", name, limit: 50 }))
        .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(allPaths().every((path) => path === "/secrets")).toBe(true);
    },
  );

  it("refuses a continuation to another host or a single-object path", async () => {
    for (const nextLink of [
      "https://evil.example.com/secrets?api-version=7.4",
      "https://kvexample.vault.azure.net/secrets/example-secret/abc123?api-version=7.4",
      "https://kvexample.vault.azure.net/keys?api-version=7.4",
      "/secrets?api-version=7.4",
    ]) {
      fetchMock.mockReset().mockResolvedValue(json(JSON.stringify({ value: [], nextLink })));
      await expect(requestKeyVaultMetadata(profile, { kind: "secret", verb: "list", vault: "kvexample", limit: 50 }))
        .rejects.toMatchObject({ code: "API_ERROR" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("filters expiring items client-side from listed properties", async () => {
    const now = Date.parse("2026-10-04T00:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    fetchMock.mockResolvedValue(json(JSON.stringify({ value: [
      { id: "https://kvexample.vault.azure.net/secrets/soon/v1", attributes: { enabled: true, exp: now / 1000 + 7 * 86_400 } },
      { id: "https://kvexample.vault.azure.net/secrets/later/v1", attributes: { enabled: true, exp: now / 1000 + 90 * 86_400 } },
      { id: "https://kvexample.vault.azure.net/secrets/never/v1", attributes: { enabled: true } },
      { id: "https://kvexample.vault.azure.net/secrets/expired/v1", attributes: { enabled: true, exp: now / 1000 - 60 } },
    ] })));
    const result = await requestKeyVaultMetadata(profile,
      { kind: "secret", verb: "list", vault: "kvexample", limit: 50, expiringWithinMs: 30 * 86_400_000 });
    expect(result.rows.map((row) => row.name)).toEqual(["soon"]);
  });

  it("marks truncation when the service has more pages than the limit", async () => {
    fetchMock.mockResolvedValue(json(JSON.stringify({
      value: [{ id: "https://kvexample.vault.azure.net/secrets/a/v1", attributes: { enabled: true } }],
      nextLink: "https://kvexample.vault.azure.net/secrets?api-version=7.4&$skiptoken=abc",
    })));
    const result = await requestKeyVaultMetadata(profile, { kind: "secret", verb: "list", vault: "kvexample", limit: 1 });
    expect(result).toMatchObject({ truncated: true });
    expect(result.rows).toHaveLength(1);
  });

  it.each([
    ["secret", "secrets", "id"], ["secret", "secrets", "kid"],
    ["key", "keys", "id"], ["key", "keys", "kid"],
    ["certificate", "certificates", "id"], ["certificate", "certificates", "kid"],
  ] as const)("%s accepts base identifiers through %s/%s", async (kind, collection, field) => {
    fetchMock.mockImplementation(async () => json(JSON.stringify({ value: [
      { [field]: `https://kvexample.vault.azure.net/${collection}/example` },
    ] })));
    expect((await requestKeyVaultMetadata(profile, { kind, verb: "list", vault: "kvexample", limit: 50 })).rows)
      .toEqual([expect.objectContaining({ name: "example" })]);
    expect((await requestKeyVaultMetadata(profile, { kind, verb: "show", vault: "kvexample", name: "example", limit: 50 })).rows)
      .toEqual([expect.objectContaining({ name: "example" })]);
  });

  it.each([
    ["secret", "secrets", "list"], ["secret", "secrets", "show"],
    ["key", "keys", "list"], ["key", "keys", "show"],
    ["certificate", "certificates", "list"], ["certificate", "certificates", "show"],
  ] as const)("%s %s %s follows continuations for uppercase vault names", async (kind, collection, verb) => {
    fetchMock
      .mockResolvedValueOnce(json(JSON.stringify({ value: [], nextLink: `https://kvexample.vault.azure.net/${collection}?api-version=7.4&$skiptoken=abc` })))
      .mockResolvedValueOnce(json(JSON.stringify({ value: [{ id: `https://kvexample.vault.azure.net/${collection}/example` }] })));
    expect((await requestKeyVaultMetadata(profile, { kind, verb, vault: "KVEXAMPLE", name: "example", limit: 50 })).rows)
      .toEqual([expect.objectContaining({ name: "example" })]);
    expect(new URL(firstUrl()).hostname).toBe("kvexample.vault.azure.net");
    expect(allPaths()).toEqual([`/${collection}`, `/${collection}`]);
  });

  it.each([
    ["secret", "secrets", undefined], ["key", "keys", undefined], ["certificate", "certificates", undefined],
    ["secret", "secrets", 86_400_000], ["key", "keys", 86_400_000], ["certificate", "certificates", 86_400_000],
  ] as const)("%s marks omitted final-page matches with expiry window %s/%s", async (kind, collection, expiringWithinMs) => {
    vi.spyOn(Date, "now").mockReturnValue(1791072000000);
    const value = Array.from({ length: 25 }, (_, i) => ({
      id: `https://kvexample.vault.azure.net/${collection}/example-${i}`, attributes: { exp: 1791072060 },
    }));
    fetchMock
      .mockResolvedValueOnce(json(JSON.stringify({ value, nextLink: `https://kvexample.vault.azure.net/${collection}?api-version=7.4&$skiptoken=abc` })))
      .mockResolvedValueOnce(json(JSON.stringify({ value })));
    const result = await requestKeyVaultMetadata(profile, { kind, verb: "list", vault: "kvexample", limit: 30, expiringWithinMs });
    expect(result.rows).toHaveLength(30);
    expect(result).toMatchObject({ truncated: true, truncationReason: "limit" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not mark truncation for final-page items excluded by expiry", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1791072000000);
    fetchMock.mockResolvedValue(json(JSON.stringify({ value: [
      { id: "https://kvexample.vault.azure.net/secrets/soon", attributes: { exp: 1791072060 } },
      { id: "https://kvexample.vault.azure.net/secrets/never" },
    ] })));
    expect(await requestKeyVaultMetadata(profile, { kind: "secret", verb: "list", vault: "kvexample", limit: 1, expiringWithinMs: 86_400_000 }))
      .toMatchObject({ rows: [expect.objectContaining({ name: "soon" })], truncated: false });
  });

  it.each([
    ["secret", "secrets"], ["key", "keys"], ["certificate", "certificates"],
  ] as const)("%s distinguishes the scan cap on %s from the row limit", async (kind, collection) => {
    fetchMock.mockImplementation(async () => json(JSON.stringify({
      value: [{ id: `https://kvexample.vault.azure.net/${collection}/never` }],
      nextLink: `https://kvexample.vault.azure.net/${collection}?api-version=7.4&$skiptoken=abc`,
    })));
    expect(await requestKeyVaultMetadata(profile, { kind, verb: "list", vault: "kvexample", limit: 50, expiringWithinMs: 86_400_000 }))
      .toEqual({ rows: [], truncated: true, truncationReason: "scan" });
    expect(fetchMock).toHaveBeenCalledTimes(40);
  });

  it.each([401, 403, 404])("HTTP %s never falls back or reads an error body", async (status) => {
    fetchMock.mockResolvedValue(new Response("credential-value", { status }));
    await expect(requestKeyVaultMetadata(profile, { kind: "secret", verb: "list", vault: "kvexample", limit: 50 }))
      .rejects.toMatchObject({ message: `key vault metadata request returned HTTP ${status}` });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolveCredential).toHaveBeenCalledTimes(1);
  });

  it("missing Entra credentials never fetches", async () => {
    vi.mocked(resolveCredential).mockRejectedValue(new Error("missing token"));
    await expect(requestKeyVaultMetadata(profile, { kind: "secret", verb: "list", vault: "kvexample", limit: 50 }))
      .rejects.toThrow("missing token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["SharedKey account:key", "Bearer token\r\nx: y"])("rejects a non-bearer or injected credential", async (header) => {
    vi.mocked(resolveCredential).mockResolvedValue({ header, mode: "token" });
    await expect(requestKeyVaultMetadata(profile, { kind: "secret", verb: "list", vault: "kvexample", limit: 50 }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["evil.example.com", "kv--example", "-kv", "kv", "kvexample.vault.azure.net", "kv_example"])(
    "rejects hostile vault %s before auth", async (vault) => {
      await expect(requestKeyVaultMetadata(profile, { kind: "secret", verb: "list", vault, limit: 50 }))
        .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(resolveCredential).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(["not json", JSON.stringify({}), JSON.stringify({ value: {} }), JSON.stringify({ value: [{ id: "https://kvexample.vault.azure.net/secrets/" }] })])(
    "refuses malformed bodies", async (body) => {
      fetchMock.mockResolvedValue(json(body));
      await expect(requestKeyVaultMetadata(profile, { kind: "secret", verb: "list", vault: "kvexample", limit: 50 }))
        .rejects.toMatchObject({ code: "API_ERROR" });
    },
  );

  it("bounds list bytes", async () => {
    fetchMock.mockResolvedValue(json("x".repeat(1024 * 1024 + 1)));
    await expect(requestKeyVaultMetadata(profile, { kind: "secret", verb: "list", vault: "kvexample", limit: 50 }))
      .rejects.toMatchObject({ code: "API_ERROR" });
  });
});
