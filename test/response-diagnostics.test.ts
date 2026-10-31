import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearCredentialCache } from "../src/lib/auth.js";
import { requestList, sendRequest, requestAcrMetadata, requestKeyVaultMetadata, requestStorageMetadata } from "../src/lib/client.js";
import type { ResolvedProfile } from "../src/lib/config.js";
import { formatError, WriteExecutionError } from "../src/lib/errors.js";
import { AxiError } from "axi-sdk-js";

const profile: ResolvedProfile = { name: "ci", auth: "token", source: "implicit", writeSubscriptions: [] };
const fetchMock = vi.fn<typeof fetch>();
const html = "<html>synthetic-private-value</html>";
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

beforeEach(() => {
  clearCredentialCache();
  for (const resource of ["ARM", "VAULT", "STORAGE", "REGISTRY"]) vi.stubEnv(`AZ_AXI_${resource}_TOKEN`, "synthetic-token");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); clearCredentialCache(); });

const requests = [
  { name: "shared client", run: () => sendRequest(profile, { path: "/subscriptions", apiVersion: "1" }), auth: false },
  { name: "key vault", run: () => requestKeyVaultMetadata(profile, { kind: "secret", vault: "kvexample", limit: 10 }), auth: false },
  { name: "storage XML", run: () => requestStorageMetadata(profile, { kind: "container", verb: "list", account: "stexample", limit: 10 }), auth: false },
  { name: "registry", run: () => requestAcrMetadata(profile, { op: "repository-list", registry: "myregistry", limit: 10 }), auth: true },
];

test.each(requests)("$name reports safe evidence for an HTML login page", async ({ run, auth }) => {
  if (auth) fetchMock.mockResolvedValueOnce(json({ refresh_token: "synthetic-refresh" }))
    .mockResolvedValueOnce(json({ access_token: "synthetic-access" }));
  fetchMock.mockResolvedValueOnce(new Response(html, { headers: { "content-type": "text/html; private=synthetic-header-value" } }));
  const error = await run().catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AxiError);
  const rendered = formatError(error);
  expect(rendered.exitCode).toBe(1);
  expect(rendered.output).toContain("code: API_ERROR");
  expect(rendered.output).toContain("status: 200");
  expect(rendered.output).toContain("contentType: text/html");
  expect(rendered.output).toContain("$,string");
  expect(rendered.output).not.toContain("synthetic-private-value");
  expect(rendered.output).not.toContain("synthetic-header-value");
  expect(rendered.output).not.toContain("synthetic-token");
});

test.each([
  { name: "shared list", run: () => requestList(profile, { path: "/subscriptions", apiVersion: "1" }), auth: false },
  { name: "key vault list", run: requests[1]!.run, auth: false },
  { name: "registry catalog", run: requests[3]!.run, auth: true },
])("$name reports a wrong envelope without values or tenant keys", async ({ run, auth }) => {
  if (auth) fetchMock.mockResolvedValueOnce(json({ refresh_token: "synthetic-refresh" }))
    .mockResolvedValueOnce(json({ access_token: "synthetic-access" }));
  fetchMock.mockResolvedValueOnce(json({ "user@example.test": "synthetic-private-value", value: false }));
  const error = await run().catch((error: unknown) => error);
  const output = formatError(error).output;
  expect(output).toContain("status: 200");
  expect(output).toContain("contentType: application/json");
  expect(output).toContain("boolean");
  expect(output).not.toContain("user@example.test");
  expect(output).not.toContain("synthetic-private-value");
});

test("diagnostics survive the write outcome wrapper", async () => {
  fetchMock.mockResolvedValueOnce(new Response(html));
  const error = await requests[0]!.run().catch((error: AxiError) => error);
  const output = formatError(new WriteExecutionError(error as AxiError, { outcome: "failed" }, [])).output;
  expect(output).toContain("status: 200");
  expect(output).toContain("outcome: failed");
});

test("registry token shape failures retain safe response evidence", async () => {
  fetchMock.mockResolvedValueOnce(json({ refresh_token: 123, note: "synthetic-private-value" }));
  const error = await requests[3]!.run().catch((error: unknown) => error);
  const output = formatError(error).output;
  expect(output).toContain("code: AUTH_REQUIRED");
  expect(output).toContain("status: 200");
  expect(output).toContain("contentType: application/json");
  expect(output).not.toContain("synthetic-private-value");
});

test("healthy JSON and explicit raw responses keep their bodies", async () => {
  fetchMock.mockResolvedValueOnce(json({ value: [{ name: "example" }] }))
    .mockResolvedValueOnce(new Response(html));
  expect(await requestList(profile, { path: "/subscriptions", apiVersion: "1" })).toEqual([{ name: "example" }]);
  expect((await sendRequest(profile, { path: "/subscriptions", apiVersion: "1", raw: true })).body).toBe(html);
});

test("an HTTP error never inherits a previous response's diagnostics", async () => {
  fetchMock.mockResolvedValueOnce(new Response(html)).mockResolvedValueOnce(json({ value: [] }))
    .mockResolvedValueOnce(new Response(null, { status: 403 }));
  await requests[0]!.run().catch(() => undefined);
  await requests[0]!.run();
  const error = await requests[0]!.run().catch((error: unknown) => error);
  expect(formatError(error).output).not.toContain("shape");
  expect(formatError(error).output).not.toContain("contentType");
});
