import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestAcrMetadata } from "../src/lib/client.js";
import type { ResolvedProfile } from "../src/lib/config.js";
import { acrCatalog, acrDigest, acrManifest, acrMetadataRows, acrTags } from "./samples.js";

vi.mock("../src/lib/auth.js", () => ({ resolveCredential: vi.fn() }));
import { resolveCredential } from "../src/lib/auth.js";

const profile: ResolvedProfile = { name: "ci", auth: "token", source: "flag", writeSubscriptions: [] };
const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", ...headers } });

function tokenFlow() {
  fetchMock
    .mockResolvedValueOnce(json({ refresh_token: "fake-refresh" }))
    .mockResolvedValueOnce(json({ access_token: "fake-access" }));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(resolveCredential).mockReset().mockResolvedValue({ header: "Bearer fake-entra-token", mode: "token" });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function calls(): Array<{ url: URL; init: RequestInit }> {
  return fetchMock.mock.calls.map(([url, init]) => ({ url: new URL(String(url)), init: init as RequestInit }));
}

describe("acr metadata transport", () => {
  it("lists repositories through Entra exchange with a catalog scope", async () => {
    tokenFlow();
    fetchMock.mockResolvedValueOnce(json(acrCatalog));
    const result = await requestAcrMetadata(profile, { op: "repository-list", registry: "myregistry", limit: 50 });
    expect(result).toEqual({ rows: [{ name: "hello-world" }, { name: "nanoserver" }] });
    const [exchange, token, data] = calls();
    expect(exchange!.url.toString()).toBe("https://myregistry.azurecr.io/oauth2/exchange");
    expect(exchange!.init).toMatchObject({ method: "POST", redirect: "error" });
    expect(String(exchange!.init.body)).toContain("grant_type=access_token");
    expect(String(exchange!.init.body)).toContain(`service=${encodeURIComponent("myregistry.azurecr.io")}`);
    expect(String(exchange!.init.body)).not.toContain("fake-access");
    expect(token!.url.toString()).toBe("https://myregistry.azurecr.io/oauth2/token");
    expect(String(token!.init.body)).toContain(`scope=${encodeURIComponent("registry:catalog:*")}`);
    expect(data!.url.toString()).toBe("https://myregistry.azurecr.io/acr/v1/_catalog?api-version=2021-07-01&n=50");
    expect(data!.init).toMatchObject({ method: "GET", redirect: "error",
      headers: { Authorization: "Bearer fake-access" } });
    expect(data!.init).not.toHaveProperty("body");
    expect(resolveCredential).toHaveBeenCalledWith(profile, "registry", expect.any(AbortSignal));
    expect(JSON.stringify(result)).not.toContain("never-output-this-value");
  });

  it("lists tags for one repository with a pull scope and projects safe fields", async () => {
    tokenFlow();
    fetchMock.mockResolvedValueOnce(json(acrTags));
    const result = await requestAcrMetadata(profile,
      { op: "tag-list", registry: "myregistry", repository: "hello-world", limit: 10, orderby: "time_desc" });
    expect(result).toEqual({ rows: [acrMetadataRows.tag] });
    const [, token, data] = calls();
    expect(String(token!.init.body)).toContain(`scope=${encodeURIComponent("repository:hello-world:pull")}`);
    expect(data!.url.pathname).toBe("/acr/v1/hello-world/_tags");
    expect(data!.url.searchParams.get("orderby")).toBe("timedesc");
    expect(data!.url.searchParams.get("n")).toBe("10");
    expect(JSON.stringify(result)).not.toContain("never-output-this-value");
  });

  it("shows one manifest by tag and drops signatures, history and download URLs", async () => {
    tokenFlow();
    fetchMock.mockResolvedValueOnce(json(acrManifest, { "Docker-Content-Digest": acrDigest }));
    const result = await requestAcrMetadata(profile,
      { op: "manifest-show", registry: "myregistry", repository: "hello-world", reference: "latest", limit: 50 });
    expect(result).toEqual({ rows: [acrMetadataRows.manifest] });
    const [, token, data] = calls();
    expect(String(token!.init.body)).toContain(`scope=${encodeURIComponent("repository:hello-world:pull")}`);
    expect(data!.url.pathname).toBe("/v2/hello-world/manifests/latest");
    expect(data!.url.searchParams.get("api-version")).toBe("2021-07-01");
    expect((data!.init.headers as Record<string, string>).Accept).toContain("application/vnd.docker.distribution.manifest.v2+json");
    expect(JSON.stringify(result)).not.toContain("never-output-this-value");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("continues from the service Link header without following endpoints", async () => {
    tokenFlow();
    fetchMock.mockResolvedValueOnce(json({ repositories: ["hello-world"] },
      { Link: '</acr/v1/_catalog?last=hello-world&n=1>; rel="next"' }));
    const first = await requestAcrMetadata(profile, { op: "repository-list", registry: "myregistry", limit: 1 });
    expect(first.nextMarker).toBe("hello-world");
    tokenFlow();
    fetchMock.mockResolvedValueOnce(json({ repositories: ["nanoserver"] }));
    const second = await requestAcrMetadata(profile,
      { op: "repository-list", registry: "myregistry", limit: 1, last: first.nextMarker });
    expect(calls()[5]!.url.searchParams.get("last")).toBe("hello-world");
    expect(second).toEqual({ rows: [{ name: "nanoserver" }] });
  });

  it("ignores a hostile Link target host", async () => {
    tokenFlow();
    fetchMock.mockResolvedValueOnce(json(acrCatalog, { Link: '<https://evil.example.com/catalog>; rel="next"' }));
    const result = await requestAcrMetadata(profile, { op: "repository-list", registry: "myregistry", limit: 50 });
    expect(result.nextMarker).toBeUndefined();
  });

  it.each([401, 403, 404])("HTTP %s never falls back or reads another credential", async (status) => {
    tokenFlow();
    fetchMock.mockResolvedValueOnce(new Response("credential-value", { status }));
    await expect(requestAcrMetadata(profile, { op: "repository-list", registry: "myregistry", limit: 50 }))
      .rejects.toMatchObject({ message: `acr metadata request returned HTTP ${status}` });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(resolveCredential).toHaveBeenCalledTimes(1);
  });

  it.each(["SharedKey registry:key", "Bearer token\r\nx: y"])("rejects a non-bearer or injected credential", async (header) => {
    vi.mocked(resolveCredential).mockResolvedValue({ header, mode: "token" });
    await expect(requestAcrMetadata(profile, { op: "repository-list", registry: "myregistry", limit: 50 }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("missing Entra credentials never exchanges or fetches", async () => {
    vi.mocked(resolveCredential).mockRejectedValue(new Error("missing token"));
    await expect(requestAcrMetadata(profile, { op: "repository-list", registry: "myregistry", limit: 50 }))
      .rejects.toThrow("missing token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never sends the Entra token as a scope or query value", async () => {
    tokenFlow();
    fetchMock.mockResolvedValueOnce(json(acrCatalog));
    await requestAcrMetadata(profile, { op: "repository-list", registry: "myregistry", limit: 50 });
    for (const { url, init } of calls()) {
      expect(url.search).not.toContain("fake-entra-token");
      expect(JSON.stringify(init.body ?? "")).not.toContain("fake-access");
    }
    expect(JSON.stringify(calls())).not.toContain("Bearer fake-entra-token");
  });

  it.each(["MyRegistry", "ab", "myregistry.azurecr.io", "myregistry?x=1", "evil.example.com"])(
    "rejects hostile registry %s before auth", async (registry) => {
      await expect(requestAcrMetadata(profile, { op: "repository-list", registry, limit: 50 }))
        .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(resolveCredential).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

  it.each(["team/my--image", "team/my__image", "team---name/my__image", "team.name/my_image"])(
    "reads tags for repository %s with valid separators", async (repository) => {
      tokenFlow();
      fetchMock.mockResolvedValueOnce(json(acrTags));
      expect(await requestAcrMetadata(profile, { op: "tag-list", registry: "myregistry", repository, limit: 50 }))
        .toEqual({ rows: [acrMetadataRows.tag] });
      const [, token, data] = calls();
      expect(new URLSearchParams(String(token!.init.body)).get("scope")).toBe(`repository:${repository}:pull`);
      expect(data!.url.pathname).toBe(`/acr/v1/${repository}/_tags`);
    });

  it.each([
    ["team/my--image", "latest"], ["team/my__image", acrDigest],
    ["team---name/my__image", "release.azurecr.io"], ["team.name/my_image", "latest"],
  ])("reads manifest metadata for %s at %s", async (repository, reference) => {
    tokenFlow();
    fetchMock.mockResolvedValueOnce(json(acrManifest, { "Docker-Content-Digest": acrDigest }));
    expect(await requestAcrMetadata(profile, { op: "manifest-show", registry: "myregistry", repository, reference, limit: 50 }))
      .toEqual({ rows: [acrMetadataRows.manifest] });
    const [, token, data] = calls();
    expect(new URLSearchParams(String(token!.init.body)).get("scope")).toBe(`repository:${repository}:pull`);
    expect(data!.url.pathname).toBe(`/v2/${repository}/manifests/${encodeURIComponent(reference)}`);
  });

  it.each(["../secret", "", "repo//name", ".hidden", "a".repeat(256), "team/my___image", "team/my..image", "team/my-_image"])("rejects hostile repository %s", async (repository) => {
    await expect(requestAcrMetadata(profile, { op: "tag-list", registry: "myregistry", repository, limit: 50 }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["", "latest?", "../digest", "sha256:xyz", "--flag"])("rejects hostile reference %s", async (reference) => {
    await expect(requestAcrMetadata(profile,
      { op: "manifest-show", registry: "myregistry", repository: "hello-world", reference, limit: 50 }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects orderby outside tag lists and unknown order values", async () => {
    await expect(requestAcrMetadata(profile, { op: "repository-list", registry: "myregistry", limit: 50, orderby: "time_asc" }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(requestAcrMetadata(profile,
      { op: "tag-list", registry: "myregistry", repository: "hello-world", limit: 50, orderby: "newest" as never }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds the token and data responses", async () => {
    fetchMock.mockResolvedValueOnce(new Response("x".repeat(1024 * 1024 + 1)));
    await expect(requestAcrMetadata(profile, { op: "repository-list", registry: "myregistry", limit: 50 }))
      .rejects.toMatchObject({ code: "API_ERROR" });
  });

  it("refuses redirects instead of following them", async () => {
    tokenFlow();
    fetchMock.mockResolvedValueOnce(new Response("moved", { status: 302, headers: { location: "https://evil.example.com" } }));
    await expect(requestAcrMetadata(profile, { op: "repository-list", registry: "myregistry", limit: 50 }))
      .rejects.toMatchObject({ message: "acr metadata request returned HTTP 302" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
