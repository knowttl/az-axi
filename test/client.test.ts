import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import { clearCredentialCache } from "../src/lib/auth.js";
import { ApiRequestError, buildUrl, request, requestAll, sendRequest } from "../src/lib/client.js";
import type { ResolvedProfile } from "../src/lib/config.js";
import { redact } from "../src/lib/redact.js";

const TOKEN = "tok-9f3c1d7a-distinctive-secret";

function profile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return { name: "ci", source: "implicit", auth: "token", writeSubscriptions: [], ...overrides };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const fetchMock = vi.fn();

beforeEach(() => {
  clearCredentialCache();
  process.env.AZ_AXI_ARM_TOKEN = TOKEN;
  process.env.AZ_AXI_LOGS_TOKEN = TOKEN;
  process.env.AZ_AXI_GRAPH_TOKEN = TOKEN;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AZ_AXI_ARM_TOKEN;
  delete process.env.AZ_AXI_LOGS_TOKEN;
  delete process.env.AZ_AXI_GRAPH_TOKEN;
});

async function failure(promise: Promise<unknown>): Promise<AxiError> {
  try {
    await promise;
  } catch (err) {
    return err as AxiError;
  }
  throw new Error("expected the request to fail");
}

const render = (error: AxiError) =>
  encode(redact({ error: error.message, code: error.code, help: error.suggestions }));

describe("client execution backstop", () => {
  const sub = "00000000-0000-0000-0000-000000000021";
  const path = `/subscriptions/${sub}/resourceGroups/rg-demo`;
  const writer = () => profile({ allowWrites: true, subscriptions: [sub], writeSubscriptions: [sub] });

  it.each([201, 202, 400, 429, 503])("preserves HTTP %s metadata when reading the body fails", async (status) => {
    const response = new Response(new ReadableStream({
      start(controller) { controller.error(new Error(`connection lost ${TOKEN}`)); },
    }), { status, headers: { "x-ms-request-id": "req-body", "x-ms-correlation-request-id": "corr-body", "retry-after": "0" } });
    fetchMock.mockResolvedValueOnce(response);
    const error = await failure(sendRequest(writer(), { method: "PATCH", path, apiVersion: "1", execute: true }));
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ code: "NETWORK_ERROR", httpStatus: status, requestId: "req-body", correlationId: "corr-body" });
    expect(render(error)).not.toContain(TOKEN);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses the client request ID when interrupted response headers omit the server ID", async () => {
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.error(new Error("connection lost")); },
    }), { status: 202 }));
    const error = await failure(sendRequest(writer(), { method: "PATCH", path, apiVersion: "1", execute: true }));
    expect(error).toMatchObject({ httpStatus: 202,
      requestId: fetchMock.mock.calls[0]![1].headers["x-ms-client-request-id"] });
  });

  it("blocks a write without explicit execution even on a permitted profile", async () => {
    await expect(sendRequest(writer(), { method: "PATCH", path, apiVersion: "1" }))
      .rejects.toMatchObject({ code: "API_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks destructive confirmation at the transport boundary", async () => {
    for (const confirm of [undefined, "wrong"]) {
      await expect(sendRequest(writer(), { method: "DELETE", path, apiVersion: "1", execute: true, confirm }))
        .rejects.toMatchObject({ code: confirm ? "CONFIRM_MISMATCH" : "CONFIRM_REQUIRED" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends If-Match only after all gates pass", async () => {
    fetchMock.mockImplementation(async () => json({}));
    await sendRequest(writer(), { method: "DELETE", path, apiVersion: "1", execute: true,
      confirm: "rg-demo", ifMatch: '"reviewed"' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE", headers: { "If-Match": '"reviewed"' } });
  });
});

describe("buildUrl", () => {
  it("targets the host of each resource and adds api-version for arm only", () => {
    expect(buildUrl({ path: "/subscriptions", apiVersion: "2022-12-01" })).toBe(
      "https://management.azure.com/subscriptions?api-version=2022-12-01",
    );
    expect(buildUrl({ resource: "logs", path: "/v1/workspaces/x/query", apiVersion: "ignored" })).toBe(
      "https://api.loganalytics.io/v1/workspaces/x/query",
    );
    expect(buildUrl({ resource: "graph", path: "v1.0/directoryObjects/getByIds" })).toBe(
      "https://graph.microsoft.com/v1.0/directoryObjects/getByIds",
    );
  });

  it("keeps an api-version already in the path and merges query values", () => {
    const url = new URL(buildUrl({ path: "/subscriptions?api-version=2020-01-01", query: { $top: 5, skip: undefined } }));
    expect(url.searchParams.get("api-version")).toBe("2020-01-01");
    expect(url.searchParams.get("$top")).toBe("5");
    expect(url.searchParams.has("skip")).toBe(false);
  });

  it("requires an api-version for arm", () => {
    expect(() => buildUrl({ path: "/subscriptions" })).toThrowError(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
  });

  it("refuses to send a token to another host", () => {
    for (const path of ["https://evil.example.com/x?api-version=1", "http://management.azure.com/x?api-version=1"]) {
      expect(() => buildUrl({ path })).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    }
    expect(() => buildUrl({ resource: "logs", path: "https://management.azure.com/x" })).toThrowError(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
    // A protocol-relative path stays on the resource host.
    expect(new URL(buildUrl({ path: "//evil.example.com/x", apiVersion: "1" })).host).toBe("management.azure.com");
  });
});

describe("sendRequest", () => {
  it("passes cancellation to fetch and preserves the abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("poll deadline");
    fetchMock.mockImplementation(async (_url, init) => {
      expect(init.signal).toBe(controller.signal);
      controller.abort(reason);
      throw reason;
    });
    await expect(sendRequest(profile(), { path: "/x", apiVersion: "1", signal: controller.signal }))
      .rejects.toBe(reason);
  });

  it("never fetches after cancellation", async () => {
    const signal = AbortSignal.abort(new Error("poll deadline"));
    await expect(sendRequest(profile(), { path: "/x", apiVersion: "1", signal })).rejects.toThrow("poll deadline");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels the retry wait without issuing another request", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => {
      queueMicrotask(() => controller.abort());
      return json({}, 503, { "retry-after": "10" });
    });
    await expect(sendRequest(profile(), { path: "/x", apiVersion: "1", signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends a fresh client request id, user agent and bearer token on every request", async () => {
    fetchMock.mockImplementation(async () => json({ value: [] }));
    await sendRequest(profile(), { path: "/subscriptions", apiVersion: "2022-12-01" });
    await sendRequest(profile(), { resource: "graph", path: "/v1.0/me" });
    await sendRequest(profile(), { resource: "logs", path: "/v1/workspaces" });

    const ids = fetchMock.mock.calls.map(([, init]) => {
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(headers["User-Agent"]).toMatch(/^az-axi\/\d+\.\d+\.\d+/);
      expect(headers["x-ms-client-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
      return headers["x-ms-client-request-id"];
    });
    expect(new Set(ids).size).toBe(3);
  });

  it("returns status, lower-cased headers, body and correlation ids", async () => {
    fetchMock.mockImplementation(async () =>
      json({ value: [1] }, 200, {
        "X-Ms-Request-Id": "req-1",
        "x-ms-correlation-request-id": "corr-1",
        ETag: '"abc"',
      }),
    );
    const response = await sendRequest<{ value: number[] }>(profile(), { path: "/subscriptions", apiVersion: "2022-12-01" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ value: [1] });
    expect(response.requestId).toBe("req-1");
    expect(response.correlationId).toBe("corr-1");
    expect(response.headers.etag).toBe('"abc"');
    expect(response.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sends JSON bodies and If-Match, and unwraps the body with request()", async () => {
    fetchMock.mockImplementation(async () => json({ totalRecords: 0 }));
    const body = await request(profile(), {
      method: "POST",
      path: "/providers/Microsoft.ResourceGraph/resources",
      apiVersion: "2024-04-01",
      body: { query: "Resources | take 1" },
      ifMatch: '"etag-1"',
    });
    expect(body).toEqual({ totalRecords: 0 });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init.body).toBe('{"query":"Resources | take 1"}');
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["If-Match"]).toBe('"etag-1"');
  });

  it("returns raw text and tolerates empty and non-JSON bodies", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("plain", { status: 200 }));
    expect(await request(profile(), { path: "/x", apiVersion: "1", raw: true })).toBe("plain");
    fetchMock.mockImplementationOnce(async () => new Response("", { status: 200 }));
    expect(await request(profile(), { path: "/x", apiVersion: "1" })).toBeUndefined();
    fetchMock.mockImplementationOnce(async () => new Response("not json", { status: 200 }));
    expect(await request(profile(), { path: "/x", apiVersion: "1" })).toBe("not json");
  });
});

describe("error translation", () => {
  const ERROR_BODY = (code: string, message: string) => ({ error: { code, message } });
  const cases: Array<[string, number, unknown, Record<string, string>, string, number]> = [
    ["401", 401, ERROR_BODY("ExpiredAuthenticationToken", "token expired"), {}, "AUTH_REQUIRED", 0],
    ["403", 403, ERROR_BODY("AuthorizationFailed", "no access"), {}, "FORBIDDEN", 0],
    ["404", 404, ERROR_BODY("SubscriptionNotFound", "no such subscription"), {}, "NOT_FOUND", 0],
    ["400 InvalidQuery", 400, ERROR_BODY("InvalidQuery", "bad kql"), {}, "VALIDATION_ERROR", 0],
    ["409", 409, ERROR_BODY("Conflict", "busy"), {}, "CONFLICT", 0],
    ["412", 412, ERROR_BODY("PreconditionFailed", "etag"), {}, "PRECONDITION_FAILED", 0],
    ["429 over cap", 429, ERROR_BODY("Throttled", "slow down"), { "retry-after": "60", "x-ms-user-quota-resets-after": "00:00:05" }, "RATE_LIMITED", 0],
    ["503 over cap", 503, ERROR_BODY("ServiceUnavailable", "busy"), { "retry-after": "60" }, "RATE_LIMITED", 0],
    ["500", 500, ERROR_BODY("InternalError", "boom"), {}, "API_ERROR", 0],
  ];

  it.each(cases)("maps HTTP %s to its code and carries the request id", async (_label, status, body, headers, code) => {
    fetchMock.mockImplementation(async () => json(body, status, { "x-ms-request-id": "req-77", ...headers }));
    const error = await failure(request(profile(), { path: "/subscriptions", apiVersion: "2022-12-01" }));
    expect(error.code).toBe(code);
    expect(error.suggestions.length).toBeGreaterThan(0);
    expect(error.suggestions).toContain("requestId: req-77");
  });

  it("falls back to the client request id when the response has none", async () => {
    fetchMock.mockImplementation(async () => json(ERROR_BODY("InternalError", "boom"), 500));
    const error = await failure(request(profile(), { path: "/x", apiVersion: "1" }));
    const sent = fetchMock.mock.calls[0]?.[1].headers["x-ms-client-request-id"];
    expect(error.suggestions).toContain(`requestId: ${sent}`);
  });

  it("names the quota reset on a Resource Graph throttle", async () => {
    fetchMock.mockImplementation(async () =>
      json({}, 429, { "retry-after": "60", "x-ms-user-quota-resets-after": "00:00:05" }),
    );
    const error = await failure(request(profile(), { path: "/x", apiVersion: "1" }));
    expect(error.suggestions.join("\n")).toContain("Retry after 60 seconds");
    expect(error.suggestions.join("\n")).toContain("00:00:05");
  });

  it("suggests the role per resource on 403", async () => {
    fetchMock.mockImplementation(async () => json(ERROR_BODY("AuthorizationFailed", "no"), 403));
    expect((await failure(request(profile(), { path: "/x", apiVersion: "1" }))).suggestions.join(" ")).toContain("Security Reader");
    expect((await failure(request(profile(), { resource: "logs", path: "/x" }))).suggestions.join(" ")).toContain("Log Analytics Reader");
  });

  it("names the env var for a rejected token", async () => {
    fetchMock.mockImplementation(async () => json({}, 401));
    expect((await failure(request(profile(), { path: "/x", apiVersion: "1" }))).suggestions.join(" ")).toContain("$AZ_AXI_ARM_TOKEN");
  });

  it("maps arm 404 and 400 hints from the ARM error code", async () => {
    fetchMock.mockImplementation(async () => json(ERROR_BODY("SubscriptionNotFound", "x"), 404));
    expect((await failure(request(profile(), { path: "/x", apiVersion: "1" }))).suggestions.join(" ")).toContain("az-axi sub list");
    fetchMock.mockImplementation(async () => json(ERROR_BODY("InvalidApiVersionParameter", "x"), 400));
    expect((await failure(request(profile(), { path: "/x", apiVersion: "1" }))).suggestions.join(" ")).toContain("--api-version");
  });

  it("surfaces the Log Analytics syntax error hidden in innererror", async () => {
    fetchMock.mockImplementation(async () =>
      json(
        {
          error: {
            code: "BadArgumentError",
            message: "The request had some invalid properties",
            innererror: {
              code: "SyntaxError",
              message: "Query could not be parsed at 'foo' on line [1,13]",
            },
          },
        },
        400,
      ),
    );
    const error = await failure(request(profile(), { resource: "logs", path: "/v1/workspaces/x/query", method: "POST" }));
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toContain("parsed at 'foo'");
    expect(error.suggestions.join(" ")).toContain("KQL");
    expect(error.suggestions.join(" ")).toContain("SyntaxError");
  });

  it("treats an invalid logs token as auth failure, not a missing Reader role", async () => {
    fetchMock.mockImplementation(async () =>
      json({ error: { code: "InvalidAuthenticationToken", message: "The access token is invalid." } }, 403),
    );
    const error = await failure(request(profile(), { resource: "logs", path: "/v1/workspaces/x/query" }));
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(error.suggestions.join(" ")).not.toContain("Log Analytics Reader");
    expect(error.suggestions.join(" ")).toContain("AZ_AXI_LOGS_TOKEN");
  });

  it("points a missing workspace at the customer ID query", async () => {
    fetchMock.mockImplementation(async () =>
      json({ error: { code: "PathNotFoundError", message: "The requested path does not exist" } }, 404),
    );
    const error = await failure(request(profile(), { resource: "logs", path: "/v1/workspaces/x/query" }));
    expect(error.code).toBe("NOT_FOUND");
    expect(error.suggestions.join(" ")).toContain("properties.customerId");
    expect(error.suggestions.join(" ")).not.toContain("api-version");
  });

  it("tells a timed-out logs query to narrow the KQL, not to raise --limit", async () => {
    fetchMock.mockImplementation(async () => json({}, 504));
    const timeout = await failure(request(profile(), { resource: "logs", path: "/v1/workspaces/x/query" }));
    expect(timeout.code).toBe("API_ERROR");
    expect(timeout.suggestions.join(" ")).toContain("timeout");
    fetchMock.mockImplementation(async () => json({}, 429, { "retry-after": "60" }));
    const limited = await failure(request(profile(), { resource: "logs", path: "/v1/workspaces/x/query" }));
    expect(limited.suggestions.join(" ")).toContain("shorten --timespan");
    expect(limited.suggestions.join(" ")).not.toContain("Resource Graph quota");
  });
});

describe("retry", () => {
  it.each([429, 503])("retries once on %i when Retry-After is 10 seconds or less", async (status) => {
    fetchMock
      .mockImplementationOnce(async () => json({}, status, { "retry-after": "0" }))
      .mockImplementationOnce(async () => json({ ok: true }));
    expect(await request(profile(), { path: "/x", apiVersion: "1" })).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = fetchMock.mock.calls.map(([, init]) => init.headers["x-ms-client-request-id"]);
    expect(first).not.toBe(second);
  });

  it.each([429, 503])("does not retry %i when Retry-After exceeds 10 seconds", async (status) => {
    fetchMock.mockImplementation(async () => json({}, status, { "retry-after": "11" }));
    expect((await failure(request(profile(), { path: "/x", apiVersion: "1" }))).code).toBe("RATE_LIMITED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([429, 503])("does not retry %i when Retry-After is absent or unparseable", async (status) => {
    for (const headers of [{}, { "retry-after": "soon" }]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(async () => json({}, status, headers));
      expect((await failure(request(profile(), { path: "/x", apiVersion: "1" }))).code).toBe("RATE_LIMITED");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it.each([429, 503])("retries %i only once, then returns RATE_LIMITED", async (status) => {
    fetchMock.mockImplementation(async () => json({}, status, { "retry-after": "0" }));
    expect((await failure(request(profile(), { path: "/x", apiVersion: "1" }))).code).toBe("RATE_LIMITED");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("waits Retry-After seconds before the retry", async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockImplementationOnce(async () => json({}, 503, { "retry-after": "5" }))
        .mockImplementationOnce(async () => json({ ok: true }));
      const pending = request(profile(), { path: "/x", apiVersion: "1" });
      await vi.advanceTimersByTimeAsync(4_900);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(await pending).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("network and TLS errors", () => {
  it.each(["SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"])(
    "maps %s to TLS_ERROR",
    async (code) => {
      fetchMock.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code } }));
      const error = await failure(request(profile(), { path: "/x", apiVersion: "1" }));
      expect(error.code).toBe("TLS_ERROR");
      expect(error.suggestions.join("\n")).toContain("NODE_EXTRA_CA_CERTS");
      expect(error.suggestions.join("\n")).toContain("TLS-inspecting proxy");
    },
  );

  it("maps other fetch failures to NETWORK_ERROR with a client request id", async () => {
    fetchMock.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND management.azure.com" } }));
    const error = await failure(request(profile(), { path: "/x", apiVersion: "1" }));
    expect(error.code).toBe("NETWORK_ERROR");
    expect(error.suggestions.some((s) => s.startsWith("clientRequestId: "))).toBe(true);
  });
});

describe("nextLink paging", () => {
  it("follows nextLink across pages on the same host", async () => {
    fetchMock
      .mockImplementationOnce(async () => json({ value: [1, 2], nextLink: "https://management.azure.com/subscriptions?api-version=2022-12-01&$skiptoken=p2" }))
      .mockImplementationOnce(async () => json({ value: [3] }));
    const result = await requestAll<number>(profile(), { path: "/subscriptions", apiVersion: "2022-12-01" });
    expect(result).toEqual({ items: [1, 2, 3] });
    expect(fetchMock.mock.calls[1]?.[0]).toContain("skiptoken=p2");
  });

  it("stops the generic default after 10 pages", async () => {
    fetchMock.mockImplementation(async () =>
      json({ value: [1], nextLink: "https://management.azure.com/subscriptions?api-version=2022-12-01&$skiptoken=more" }),
    );
    const result = await requestAll<number>(profile(), { path: "/subscriptions", apiVersion: "2022-12-01" });
    expect(result.items).toHaveLength(10);
    expect(result.nextLink).toContain("skiptoken=more");
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("reports the unfetched nextLink when the page cap stops paging", async () => {
    fetchMock.mockImplementation(async () =>
      json({ value: [1], nextLink: "https://management.azure.com/subscriptions?api-version=2022-12-01&$skiptoken=more" }),
    );
    const result = await requestAll<number>(profile(), { path: "/subscriptions", apiVersion: "2022-12-01" }, 2);
    expect(result.items).toEqual([1, 1]);
    expect(result.nextLink).toContain("skiptoken=more");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses a nextLink on another host", async () => {
    fetchMock.mockImplementationOnce(async () => json({ value: [1], nextLink: "https://evil.example.com/next" }));
    const error = await failure(requestAll(profile(), { path: "/subscriptions", apiVersion: "2022-12-01" }));
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("the token never reaches rendered output", () => {
  it("is scrubbed from error bodies, whatever the status", async () => {
    for (const status of [400, 401, 403, 404, 409, 412, 429, 500]) {
      fetchMock.mockImplementation(async () =>
        json({ error: { code: "Echo", message: `rejected ${TOKEN} in header` } }, status, { "retry-after": "60" }),
      );
      const error = await failure(request(profile(), { path: "/x", apiVersion: "1" }));
      expect(render(error), `HTTP ${status}`).not.toContain(TOKEN);
    }
  });

  it("is scrubbed from non-JSON error bodies and network error messages", async () => {
    fetchMock.mockImplementationOnce(async () => new Response(`<html>${TOKEN}</html>`, { status: 502 }));
    expect(render(await failure(request(profile(), { path: "/x", apiVersion: "1" })))).not.toContain(TOKEN);
    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { message: `bad ${TOKEN}` } }));
    expect(render(await failure(request(profile(), { path: "/x", apiVersion: "1" })))).not.toContain(TOKEN);
  });

  it("is absent from validation, policy and missing-token errors", async () => {
    const errors = [
      await failure(request(profile(), { path: "/x" })),
      await failure(request(profile(), { path: "https://evil.example.com/x" })),
      await failure(request(profile(), { method: "DELETE", path: "/x", apiVersion: "1" })),
      await failure(request(profile(), { method: "POST", path: "/x/listKeys", apiVersion: "1" })),
    ];
    delete process.env.AZ_AXI_ARM_TOKEN;
    clearCredentialCache();
    errors.push(await failure(request(profile(), { path: "/x", apiVersion: "1" })));
    for (const error of errors) expect(render(error)).not.toContain(TOKEN);
  });
});
